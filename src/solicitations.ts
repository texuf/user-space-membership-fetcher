import {
  townsEnv,
  makeStreamRpcClient,
  ParsedEvent,
  streamIdAsBytes,
  unpackMiniblock,
  userIdFromAddress,
} from "@towns-protocol/sdk";
import { LocalhostWeb3Provider, RiverRegistry } from "@towns-protocol/web3";
import { env } from "./env";
import Table from "cli-table3";
import chalk from "chalk";
import {
  GetMiniblocksResponse,
  GetMiniblocksResponseSchema,
} from "@towns-protocol/proto";
import { toBinary } from "@bufbuild/protobuf";

// ============================================================================
// Types
// ============================================================================

interface SolicitationInfo {
  deviceKey: string;
  fallbackKey: string;
  isNewDevice: boolean;
  sessionIds: string[];
  timestamp: number;
  creatorUserId: string;
  miniblockNum: bigint;
  eventHash: string;
}

interface FulfillmentInfo {
  userAddress: string;
  deviceKey: string;
  sessionIds: string[];
  timestamp: number;
  creatorUserId: string;
  miniblockNum: bigint;
  eventHash: string;
}

interface SolicitationAnalysis {
  // Overview
  totalSolicitations: number;
  totalFulfillments: number;
  timeRangeStart: number;
  timeRangeEnd: number;

  // Solicitations by device
  solicitationsByDevice: Map<string, SolicitationInfo[]>;

  // Fulfillments by target user
  fulfillmentsByTargetUser: Map<string, FulfillmentInfo[]>;

  // Fulfillments by responder
  fulfillmentsByResponder: Map<string, FulfillmentInfo[]>;

  // All events for timeline
  solicitations: SolicitationInfo[];
  fulfillments: FulfillmentInfo[];

  // Session tracking
  sessionIdToSolicitations: Map<string, SolicitationInfo[]>;
  sessionIdToFulfillments: Map<string, FulfillmentInfo[]>;

  // For matching solicitations to fulfillments
  deviceKeyToSolicitations: Map<string, SolicitationInfo[]>;
  deviceKeyToFulfillments: Map<string, FulfillmentInfo[]>;

  // Anomalies
  anomalies: Anomaly[];
}

interface Anomaly {
  type:
    | "duplicate_solicitation"
    | "duplicate_fulfillment"
    | "unfulfilled_solicitation"
    | "fulfillment_without_solicitation"
    | "multiple_fulfillments"
    | "session_mismatch";
  severity: "low" | "medium" | "high";
  description: string;
  details: Record<string, unknown>;
}

// ============================================================================
// Analysis Functions
// ============================================================================

function createEmptyAnalysis(): SolicitationAnalysis {
  return {
    totalSolicitations: 0,
    totalFulfillments: 0,
    timeRangeStart: Infinity,
    timeRangeEnd: 0,
    solicitationsByDevice: new Map(),
    fulfillmentsByTargetUser: new Map(),
    fulfillmentsByResponder: new Map(),
    solicitations: [],
    fulfillments: [],
    sessionIdToSolicitations: new Map(),
    sessionIdToFulfillments: new Map(),
    deviceKeyToSolicitations: new Map(),
    deviceKeyToFulfillments: new Map(),
    anomalies: [],
  };
}

function processEvent(
  event: ParsedEvent,
  analysis: SolicitationAnalysis,
  miniblockNum: bigint,
  filterUserAddress?: string
): void {
  const payload = event.event.payload;
  if (payload?.case !== "memberPayload") {
    return;
  }

  const timestamp = Number(event.event.createdAtEpochMs);
  analysis.timeRangeStart = Math.min(analysis.timeRangeStart, timestamp);
  analysis.timeRangeEnd = Math.max(analysis.timeRangeEnd, timestamp);

  const content = payload.value.content;

  if (content?.case === "keySolicitation") {
    processSolicitation(
      event,
      content.value,
      analysis,
      timestamp,
      miniblockNum
    );
  } else if (content?.case === "keyFulfillment") {
    processFulfillment(
      event,
      content.value,
      analysis,
      timestamp,
      miniblockNum,
      filterUserAddress
    );
  }
}

function processSolicitation(
  event: ParsedEvent,
  solicitation: {
    deviceKey: string;
    fallbackKey: string;
    isNewDevice: boolean;
    sessionIds: string[];
  },
  analysis: SolicitationAnalysis,
  timestamp: number,
  miniblockNum: bigint
): void {
  analysis.totalSolicitations++;

  const info: SolicitationInfo = {
    deviceKey: solicitation.deviceKey,
    fallbackKey: solicitation.fallbackKey,
    isNewDevice: solicitation.isNewDevice,
    sessionIds: solicitation.sessionIds,
    timestamp,
    creatorUserId: event.creatorUserId,
    miniblockNum,
    eventHash: event.hashStr,
  };

  analysis.solicitations.push(info);

  // Track by device key
  if (!analysis.solicitationsByDevice.has(solicitation.deviceKey)) {
    analysis.solicitationsByDevice.set(solicitation.deviceKey, []);
  }
  analysis.solicitationsByDevice.get(solicitation.deviceKey)!.push(info);

  // Track by device key for matching
  if (!analysis.deviceKeyToSolicitations.has(solicitation.deviceKey)) {
    analysis.deviceKeyToSolicitations.set(solicitation.deviceKey, []);
  }
  analysis.deviceKeyToSolicitations.get(solicitation.deviceKey)!.push(info);

  // Track session IDs
  for (const sessionId of solicitation.sessionIds) {
    if (!analysis.sessionIdToSolicitations.has(sessionId)) {
      analysis.sessionIdToSolicitations.set(sessionId, []);
    }
    analysis.sessionIdToSolicitations.get(sessionId)!.push(info);
  }
}

function processFulfillment(
  event: ParsedEvent,
  fulfillment: {
    userAddress: Uint8Array;
    deviceKey: string;
    sessionIds: string[];
  },
  analysis: SolicitationAnalysis,
  timestamp: number,
  miniblockNum: bigint,
  filterUserAddress?: string
): void {
  const targetUserAddress = userIdFromAddress(fulfillment.userAddress);

  // If filtering by user address, skip non-matching fulfillments
  if (
    filterUserAddress &&
    targetUserAddress.toLowerCase() !== filterUserAddress.toLowerCase()
  ) {
    return;
  }

  analysis.totalFulfillments++;

  const info: FulfillmentInfo = {
    userAddress: targetUserAddress,
    deviceKey: fulfillment.deviceKey,
    sessionIds: fulfillment.sessionIds,
    timestamp,
    creatorUserId: event.creatorUserId,
    miniblockNum,
    eventHash: event.hashStr,
  };

  analysis.fulfillments.push(info);

  // Track by target user
  if (!analysis.fulfillmentsByTargetUser.has(targetUserAddress)) {
    analysis.fulfillmentsByTargetUser.set(targetUserAddress, []);
  }
  analysis.fulfillmentsByTargetUser.get(targetUserAddress)!.push(info);

  // Track by responder
  if (!analysis.fulfillmentsByResponder.has(event.creatorUserId)) {
    analysis.fulfillmentsByResponder.set(event.creatorUserId, []);
  }
  analysis.fulfillmentsByResponder.get(event.creatorUserId)!.push(info);

  // Track by device key for matching
  if (!analysis.deviceKeyToFulfillments.has(fulfillment.deviceKey)) {
    analysis.deviceKeyToFulfillments.set(fulfillment.deviceKey, []);
  }
  analysis.deviceKeyToFulfillments.get(fulfillment.deviceKey)!.push(info);

  // Track session IDs
  for (const sessionId of fulfillment.sessionIds) {
    if (!analysis.sessionIdToFulfillments.has(sessionId)) {
      analysis.sessionIdToFulfillments.set(sessionId, []);
    }
    analysis.sessionIdToFulfillments.get(sessionId)!.push(info);
  }
}

function detectAnomalies(analysis: SolicitationAnalysis): void {
  // 1. Detect duplicate solicitations from same device
  for (const [deviceKey, solicitations] of analysis.solicitationsByDevice) {
    if (solicitations.length > 1) {
      // Check for solicitations within short time window (potential duplicates)
      const sorted = [...solicitations].sort(
        (a, b) => a.timestamp - b.timestamp
      );
      for (let i = 1; i < sorted.length; i++) {
        const timeDiff = sorted[i].timestamp - sorted[i - 1].timestamp;
        if (timeDiff < 60000) {
          // Less than 1 minute apart
          analysis.anomalies.push({
            type: "duplicate_solicitation",
            severity: "medium",
            description: `Device ${deviceKey} sent ${
              solicitations.length
            } solicitations, ${i + 1} within ${Math.round(timeDiff / 1000)}s`,
            details: {
              deviceKey,
              count: solicitations.length,
              timeDiffMs: timeDiff,
              timestamps: sorted.map((s) =>
                new Date(s.timestamp).toISOString()
              ),
            },
          });
          break;
        }
      }
    }
  }

  // 2. Detect multiple fulfillments for same device key (potential issue)
  for (const [deviceKey, fulfillments] of analysis.deviceKeyToFulfillments) {
    if (fulfillments.length > 1) {
      const responders = new Set(fulfillments.map((f) => f.creatorUserId));
      analysis.anomalies.push({
        type: "multiple_fulfillments",
        severity: responders.size > 1 ? "high" : "medium",
        description: `Device ${deviceKey} received ${fulfillments.length} fulfillments from ${responders.size} responder(s)`,
        details: {
          deviceKey,
          count: fulfillments.length,
          responders: Array.from(responders),
          sessionIds: fulfillments.flatMap((f) => f.sessionIds),
        },
      });
    }
  }

  // 3. Detect session IDs that appear in multiple fulfillments
  for (const [sessionId, fulfillments] of analysis.sessionIdToFulfillments) {
    if (fulfillments.length > 1) {
      analysis.anomalies.push({
        type: "duplicate_fulfillment",
        severity: "high",
        description: `Session ${sessionId} fulfilled ${fulfillments.length} times`,
        details: {
          sessionId,
          count: fulfillments.length,
          responders: fulfillments.map((f) => f.creatorUserId),
          timestamps: fulfillments.map((f) =>
            new Date(f.timestamp).toISOString()
          ),
        },
      });
    }
  }

  // 4. Detect solicitations without matching fulfillments
  for (const [deviceKey, solicitations] of analysis.deviceKeyToSolicitations) {
    const fulfillments = analysis.deviceKeyToFulfillments.get(deviceKey) || [];
    if (fulfillments.length === 0 && solicitations.length > 0) {
      const latestSolicitation = solicitations[solicitations.length - 1];
      const timeSince = analysis.timeRangeEnd - latestSolicitation.timestamp;
      if (timeSince > 300000) {
        // More than 5 minutes old
        analysis.anomalies.push({
          type: "unfulfilled_solicitation",
          severity: "low",
          description: `Device ${deviceKey} has ${solicitations.length} solicitation(s) with no fulfillment`,
          details: {
            deviceKey,
            solicitationCount: solicitations.length,
            timeSinceLastMs: timeSince,
            isNewDevice: latestSolicitation.isNewDevice,
          },
        });
      }
    }
  }
}

// ============================================================================
// Display Functions
// ============================================================================

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function printOverview(analysis: SolicitationAnalysis, streamId: string): void {
  console.log(chalk.bold.cyan("\n" + "═".repeat(100)));
  console.log(chalk.bold.cyan("  KEY SOLICITATION & FULFILLMENT ANALYSIS"));
  console.log(chalk.bold.cyan("═".repeat(100)));

  const duration = analysis.timeRangeEnd - analysis.timeRangeStart;

  const overviewTable = new Table({
    chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
  });

  overviewTable.push(
    [chalk.gray("Stream ID"), streamId],
    [
      chalk.gray("Time Range"),
      `${new Date(analysis.timeRangeStart).toISOString()} → ${new Date(
        analysis.timeRangeEnd
      ).toISOString()}`,
    ],
    [chalk.gray("Duration"), formatDuration(duration)],
    [
      chalk.gray("Total Solicitations"),
      chalk.yellow(analysis.totalSolicitations.toString()),
    ],
    [
      chalk.gray("Total Fulfillments"),
      chalk.green(analysis.totalFulfillments.toString()),
    ],
    [
      chalk.gray("Unique Soliciting Devices"),
      chalk.magenta(analysis.solicitationsByDevice.size.toString()),
    ],
    [
      chalk.gray("Unique Responders"),
      chalk.cyan(analysis.fulfillmentsByResponder.size.toString()),
    ],
    [
      chalk.gray("Unique Target Users"),
      chalk.blue(analysis.fulfillmentsByTargetUser.size.toString()),
    ],
    [
      chalk.gray("Anomalies Detected"),
      analysis.anomalies.length > 0
        ? chalk.red(analysis.anomalies.length.toString())
        : chalk.green("0"),
    ]
  );

  console.log(overviewTable.toString());
}

function printSolicitationsByDevice(analysis: SolicitationAnalysis): void {
  console.log(chalk.bold.yellow("\n" + "─".repeat(100)));
  console.log(chalk.bold.yellow("  SOLICITATIONS BY DEVICE"));
  console.log(chalk.bold.yellow("─".repeat(100)));

  if (analysis.solicitationsByDevice.size === 0) {
    console.log(chalk.gray("  No solicitations found"));
    return;
  }

  const deviceTable = new Table({
    head: [
      chalk.white("Device Key"),
      chalk.white("Creator"),
      chalk.white("Count"),
      chalk.white("New Device"),
      chalk.white("Session IDs"),
      chalk.white("First"),
      chalk.white("Last"),
    ],
    wordWrap: true,
  });

  const sortedDevices = [...analysis.solicitationsByDevice.entries()].sort(
    (a, b) => b[1].length - a[1].length
  );

  for (const [deviceKey, solicitations] of sortedDevices.slice(0, 20)) {
    const sorted = [...solicitations].sort((a, b) => a.timestamp - b.timestamp);
    const allSessionIds = new Set(solicitations.flatMap((s) => s.sessionIds));
    const creators = new Set(solicitations.map((s) => s.creatorUserId));
    const hasNewDevice = solicitations.some((s) => s.isNewDevice);

    deviceTable.push([
      deviceKey,
      [...creators].join("\n"),
      solicitations.length.toString(),
      hasNewDevice ? chalk.yellow("Yes") : "No",
      allSessionIds.size > 0
        ? `${allSessionIds.size} unique`
        : chalk.gray("(new device)"),
      new Date(sorted[0].timestamp).toISOString().substring(0, 19),
      new Date(sorted[sorted.length - 1].timestamp)
        .toISOString()
        .substring(0, 19),
    ]);
  }

  console.log(deviceTable.toString());

  if (sortedDevices.length > 20) {
    console.log(
      chalk.gray(`  ... and ${sortedDevices.length - 20} more devices`)
    );
  }
}

function printFulfillmentsByResponder(analysis: SolicitationAnalysis): void {
  console.log(chalk.bold.green("\n" + "─".repeat(100)));
  console.log(chalk.bold.green("  FULFILLMENTS BY RESPONDER"));
  console.log(chalk.bold.green("─".repeat(100)));

  if (analysis.fulfillmentsByResponder.size === 0) {
    console.log(chalk.gray("  No fulfillments found"));
    return;
  }

  const responderTable = new Table({
    head: [
      chalk.white("Responder"),
      chalk.white("Fulfillments"),
      chalk.white("Unique Devices"),
      chalk.white("Unique Targets"),
      chalk.white("Total Sessions"),
      chalk.white("First"),
      chalk.white("Last"),
    ],
    wordWrap: true,
  });

  const sortedResponders = [...analysis.fulfillmentsByResponder.entries()].sort(
    (a, b) => b[1].length - a[1].length
  );

  for (const [responder, fulfillments] of sortedResponders.slice(0, 15)) {
    const sorted = [...fulfillments].sort((a, b) => a.timestamp - b.timestamp);
    const uniqueDevices = new Set(fulfillments.map((f) => f.deviceKey));
    const uniqueTargets = new Set(fulfillments.map((f) => f.userAddress));
    const totalSessions = fulfillments.reduce(
      (sum, f) => sum + f.sessionIds.length,
      0
    );

    responderTable.push([
      responder,
      fulfillments.length.toString(),
      uniqueDevices.size.toString(),
      uniqueTargets.size.toString(),
      totalSessions.toString(),
      new Date(sorted[0].timestamp).toISOString().substring(0, 19),
      new Date(sorted[sorted.length - 1].timestamp)
        .toISOString()
        .substring(0, 19),
    ]);
  }

  console.log(responderTable.toString());

  if (sortedResponders.length > 15) {
    console.log(
      chalk.gray(`  ... and ${sortedResponders.length - 15} more responders`)
    );
  }
}

function printFulfillmentsByTargetUser(analysis: SolicitationAnalysis): void {
  console.log(chalk.bold.blue("\n" + "─".repeat(100)));
  console.log(chalk.bold.blue("  FULFILLMENTS BY TARGET USER"));
  console.log(chalk.bold.blue("─".repeat(100)));

  if (analysis.fulfillmentsByTargetUser.size === 0) {
    console.log(chalk.gray("  No fulfillments found"));
    return;
  }

  const targetTable = new Table({
    head: [
      chalk.white("Target User"),
      chalk.white("Fulfillments"),
      chalk.white("Unique Responders"),
      chalk.white("Unique Devices"),
      chalk.white("Total Sessions"),
    ],
    wordWrap: true,
  });

  const sortedTargets = [...analysis.fulfillmentsByTargetUser.entries()].sort(
    (a, b) => b[1].length - a[1].length
  );

  for (const [target, fulfillments] of sortedTargets.slice(0, 15)) {
    const uniqueResponders = new Set(fulfillments.map((f) => f.creatorUserId));
    const uniqueDevices = new Set(fulfillments.map((f) => f.deviceKey));
    const totalSessions = fulfillments.reduce(
      (sum, f) => sum + f.sessionIds.length,
      0
    );

    targetTable.push([
      target,
      fulfillments.length.toString(),
      uniqueResponders.size.toString(),
      uniqueDevices.size.toString(),
      totalSessions.toString(),
    ]);
  }

  console.log(targetTable.toString());

  if (sortedTargets.length > 15) {
    console.log(
      chalk.gray(`  ... and ${sortedTargets.length - 15} more target users`)
    );
  }
}

function printDeviceKeyMatching(analysis: SolicitationAnalysis): void {
  console.log(chalk.bold.magenta("\n" + "─".repeat(100)));
  console.log(
    chalk.bold.magenta("  SOLICITATION → FULFILLMENT MATCHING BY DEVICE KEY")
  );
  console.log(chalk.bold.magenta("─".repeat(100)));

  const matchTable = new Table({
    head: [
      chalk.white("Device Key"),
      chalk.white("Solicitations"),
      chalk.white("Fulfillments"),
      chalk.white("Responders"),
      chalk.white("Status"),
    ],
    wordWrap: true,
  });

  // Combine all device keys from both maps
  const allDeviceKeys = new Set([
    ...analysis.deviceKeyToSolicitations.keys(),
    ...analysis.deviceKeyToFulfillments.keys(),
  ]);

  const entries: Array<{
    deviceKey: string;
    solicitations: SolicitationInfo[];
    fulfillments: FulfillmentInfo[];
  }> = [];

  for (const deviceKey of allDeviceKeys) {
    entries.push({
      deviceKey,
      solicitations: analysis.deviceKeyToSolicitations.get(deviceKey) || [],
      fulfillments: analysis.deviceKeyToFulfillments.get(deviceKey) || [],
    });
  }

  // Sort by most fulfillments first
  entries.sort((a, b) => b.fulfillments.length - a.fulfillments.length);

  for (const entry of entries.slice(0, 25)) {
    const responders = new Set(entry.fulfillments.map((f) => f.creatorUserId));

    let status: string;
    if (entry.solicitations.length === 0 && entry.fulfillments.length > 0) {
      status = chalk.yellow("Fulfillment only");
    } else if (
      entry.solicitations.length > 0 &&
      entry.fulfillments.length === 0
    ) {
      status = chalk.red("Unfulfilled");
    } else if (entry.fulfillments.length === 1) {
      status = chalk.green("OK");
    } else if (entry.fulfillments.length > 1) {
      status = chalk.red(`${entry.fulfillments.length} fulfillments!`);
    } else {
      status = chalk.gray("Unknown");
    }

    matchTable.push([
      entry.deviceKey,
      entry.solicitations.length.toString(),
      entry.fulfillments.length.toString(),
      responders.size > 0 ? [...responders].join("\n") : "-",
      status,
    ]);
  }

  console.log(matchTable.toString());

  if (entries.length > 25) {
    console.log(
      chalk.gray(`  ... and ${entries.length - 25} more device keys`)
    );
  }

  // Summary stats
  const fulfilled = entries.filter(
    (e) => e.solicitations.length > 0 && e.fulfillments.length > 0
  ).length;
  const unfulfilled = entries.filter(
    (e) => e.solicitations.length > 0 && e.fulfillments.length === 0
  ).length;
  const multipleFulfillments = entries.filter(
    (e) => e.fulfillments.length > 1
  ).length;

  console.log(
    chalk.gray(
      `\n  Summary: ${chalk.green(fulfilled.toString())} fulfilled, ${chalk.red(
        unfulfilled.toString()
      )} unfulfilled, ${chalk.yellow(
        multipleFulfillments.toString()
      )} with multiple fulfillments`
    )
  );
}

function printSessionIdAnalysis(analysis: SolicitationAnalysis): void {
  console.log(chalk.bold.cyan("\n" + "─".repeat(100)));
  console.log(chalk.bold.cyan("  SESSION ID ANALYSIS"));
  console.log(chalk.bold.cyan("─".repeat(100)));

  // Find sessions that appear in multiple fulfillments (duplicates)
  const duplicateSessions = [
    ...analysis.sessionIdToFulfillments.entries(),
  ].filter(([, fulfillments]) => fulfillments.length > 1);

  if (duplicateSessions.length === 0) {
    console.log(chalk.green("  ✓ No duplicate session fulfillments detected"));
  } else {
    console.log(
      chalk.red(
        `  ⚠ Found ${duplicateSessions.length} session(s) with multiple fulfillments:`
      )
    );

    const dupTable = new Table({
      head: [
        chalk.white("Session ID"),
        chalk.white("Fulfillment Count"),
        chalk.white("Responders"),
        chalk.white("Timestamps"),
      ],
      wordWrap: true,
    });

    for (const [sessionId, fulfillments] of duplicateSessions.slice(0, 15)) {
      const responders = fulfillments.map((f) => f.creatorUserId);

      dupTable.push([
        sessionId,
        chalk.red(fulfillments.length.toString()),
        responders.join("\n"),
        fulfillments
          .map((f) => new Date(f.timestamp).toISOString().substring(0, 19))
          .join("\n"),
      ]);
    }

    console.log(dupTable.toString());
  }

  // Show overall session stats
  console.log(chalk.gray("\n  Session Statistics:"));
  console.log(
    chalk.gray(
      `    Unique sessions in solicitations: ${analysis.sessionIdToSolicitations.size}`
    )
  );
  console.log(
    chalk.gray(
      `    Unique sessions in fulfillments: ${analysis.sessionIdToFulfillments.size}`
    )
  );
}

function printTimeline(analysis: SolicitationAnalysis): void {
  console.log(chalk.bold.white("\n" + "─".repeat(100)));
  console.log(chalk.bold.white("  TIMELINE (Last 50 Events)"));
  console.log(chalk.bold.white("─".repeat(100)));

  // Combine and sort all events
  const allEvents: Array<{
    type: "solicitation" | "fulfillment";
    timestamp: number;
    deviceKey: string;
    creator: string;
    sessionCount: number;
    isNewDevice?: boolean;
    targetUser?: string;
  }> = [];

  for (const s of analysis.solicitations) {
    allEvents.push({
      type: "solicitation",
      timestamp: s.timestamp,
      deviceKey: s.deviceKey,
      creator: s.creatorUserId,
      sessionCount: s.sessionIds.length,
      isNewDevice: s.isNewDevice,
    });
  }

  for (const f of analysis.fulfillments) {
    allEvents.push({
      type: "fulfillment",
      timestamp: f.timestamp,
      deviceKey: f.deviceKey,
      creator: f.creatorUserId,
      sessionCount: f.sessionIds.length,
      targetUser: f.userAddress,
    });
  }

  allEvents.sort((a, b) => a.timestamp - b.timestamp);

  const timelineTable = new Table({
    head: [
      chalk.white("Time"),
      chalk.white("Type"),
      chalk.white("Device Key"),
      chalk.white("Creator"),
      chalk.white("Sessions"),
      chalk.white("Details"),
    ],
    wordWrap: true,
  });

  for (const event of allEvents.slice(-50)) {
    const timeStr = new Date(event.timestamp).toISOString().substring(11, 23);
    const typeStr =
      event.type === "solicitation"
        ? chalk.yellow("SOLICIT")
        : chalk.green("FULFILL");

    let details = "";
    if (event.type === "solicitation" && event.isNewDevice) {
      details = chalk.cyan("new device");
    } else if (event.type === "fulfillment" && event.targetUser) {
      details = `→ ${event.targetUser.substring(0, 10)}...`;
    }

    timelineTable.push([
      timeStr,
      typeStr,
      event.deviceKey,
      event.creator,
      event.sessionCount.toString(),
      details,
    ]);
  }

  console.log(timelineTable.toString());
}

function printAnomalies(analysis: SolicitationAnalysis): void {
  console.log(chalk.bold.red("\n" + "─".repeat(100)));
  console.log(chalk.bold.red("  ANOMALIES & WARNINGS"));
  console.log(chalk.bold.red("─".repeat(100)));

  if (analysis.anomalies.length === 0) {
    console.log(chalk.green("  ✓ No anomalies detected"));
    return;
  }

  const severityColors = {
    high: chalk.red,
    medium: chalk.yellow,
    low: chalk.gray,
  };

  const severityIcons = {
    high: "🔴",
    medium: "🟡",
    low: "⚪",
  };

  // Group by type
  const byType = new Map<string, Anomaly[]>();
  for (const anomaly of analysis.anomalies) {
    if (!byType.has(anomaly.type)) {
      byType.set(anomaly.type, []);
    }
    byType.get(anomaly.type)!.push(anomaly);
  }

  for (const [type, anomalies] of byType) {
    console.log(
      chalk.bold(
        `\n  ${type.toUpperCase().replace(/_/g, " ")} (${anomalies.length}):`
      )
    );

    for (const anomaly of anomalies.slice(0, 10)) {
      const color = severityColors[anomaly.severity];
      const icon = severityIcons[anomaly.severity];
      console.log(`    ${icon} ${color(anomaly.description)}`);
    }

    if (anomalies.length > 10) {
      console.log(chalk.gray(`    ... and ${anomalies.length - 10} more`));
    }
  }
}

// ============================================================================
// Main
// ============================================================================

const run = async () => {
  const streamIdParam = process.argv[2];
  const userAddressParam = process.argv[3];
  const blocksToFetch = parseInt(process.argv[4] || "400", 10);

  if (!streamIdParam) {
    console.error(
      chalk.red(
        "Usage: yarn solicitations <streamId> [userAddress] [blocks_to_fetch]"
      )
    );
    console.error(chalk.gray("  streamId: The stream to analyze"));
    console.error(
      chalk.gray("  userAddress: Optional - filter fulfillments to this user")
    );
    console.error(chalk.gray("  blocks_to_fetch: defaults to 500"));
    process.exit(1);
  }

  console.log(
    chalk.cyan(`\nAnalyzing solicitations for stream ${streamIdParam}`)
  );
  if (userAddressParam) {
    console.log(
      chalk.cyan(`Filtering fulfillments for user: ${userAddressParam}`)
    );
  }
  console.log(chalk.gray(`Fetching last ${blocksToFetch} miniblocks...\n`));

  // Setup
  const config = townsEnv({ env }).makeTownsConfig();

  // Connect to river
  const riverRegistry = new RiverRegistry(
    config.river.chainConfig,
    new LocalhostWeb3Provider(config.river.rpcUrl)
  );
  const urlsStr = await riverRegistry.getOperationalNodeUrls();
  const urls = urlsStr.split(",");
  const rpcUrl = urls[Math.floor(Math.random() * urls.length)];
  console.log(chalk.gray(`RPC URL: ${rpcUrl}`));

  const riverRpcProvider = makeStreamRpcClient(rpcUrl);

  // Fetch miniblocks
  const streamId = streamIdAsBytes(streamIdParam);
  const response1 = await riverRpcProvider.getLastMiniblockHash({ streamId });
  const { miniblockNum } = response1;

  console.log(chalk.gray(`Latest miniblock: ${miniblockNum}`));

  const fromBlock =
    miniblockNum > BigInt(blocksToFetch)
      ? miniblockNum - BigInt(blocksToFetch)
      : 0n;

  console.log(chalk.gray(`Fetching blocks ${fromBlock} to ${miniblockNum}...`));

  // Fetch blocks in batches of 50, starting from the latest and going backwards
  const batchSize = 50n;
  const responses: GetMiniblocksResponse[] = [];
  let currentTo = miniblockNum;

  while (currentTo > fromBlock) {
    const currentFrom =
      currentTo - batchSize < fromBlock ? fromBlock : currentTo - batchSize;

    console.log(
      chalk.gray(`Fetching batch: ${currentFrom} to ${currentTo}...`)
    );

    const batchBlocks = await riverRpcProvider.getMiniblocks({
      streamId,
      fromInclusive: currentFrom,
      toExclusive: currentTo,
    });

    const byteLength = toBinary(
      GetMiniblocksResponseSchema,
      batchBlocks
    ).byteLength;
    const mb = byteLength / 1024 / 1024;
    console.log(
      chalk.gray(
        `Batch ${currentFrom} to ${currentTo} size: ${mb.toFixed(2)} MB`
      )
    );

    responses.unshift(batchBlocks);
    currentTo = currentFrom;

    if (batchBlocks.terminus) {
      console.log(chalk.gray(`Terminus reached at ${currentTo}`));
      break;
    }
  }

  const total = responses.reduce(
    (acc, response) => acc + response.miniblocks.length,
    0
  );

  console.log(chalk.gray(`Processing ${total} miniblocks...`));

  // Analyze
  const analysis = createEmptyAnalysis();

  for (const response of responses) {
    for (const block of response.miniblocks) {
      const unpacked = await unpackMiniblock(block, {
        disableHashValidation: true,
        disableSignatureValidation: true,
      });

      for (const event of unpacked.events) {
        processEvent(
          event,
          analysis,
          unpacked.header.miniblockNum,
          userAddressParam
        );
      }
    }
  }

  // Detect anomalies
  detectAnomalies(analysis);

  // Print reports
  printOverview(analysis, streamIdParam);
  printSolicitationsByDevice(analysis);
  printFulfillmentsByResponder(analysis);
  printFulfillmentsByTargetUser(analysis);
  printDeviceKeyMatching(analysis);
  printSessionIdAnalysis(analysis);
  printTimeline(analysis);
  printAnomalies(analysis);

  console.log(chalk.bold.cyan("\n" + "═".repeat(100)));
  console.log(chalk.bold.cyan("  END OF REPORT"));
  console.log(chalk.bold.cyan("═".repeat(100) + "\n"));
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(chalk.red("Unhandled error:"), e);
    process.exit(1);
  });
