import { parseGroupEncryptionAlgorithmId } from "@towns-protocol/encryption";
import {
  townsEnv,
  makeStreamRpcClient,
  makeUserInboxStreamId,
  ParsedEvent,
  streamIdAsBytes,
  streamIdAsString,
  unpackMiniblock,
  getUserIdFromStreamId,
} from "@towns-protocol/sdk";
import {
  INVALID_ADDRESS,
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceDapp,
} from "@towns-protocol/web3";
import { env } from "./env";
import Table from "cli-table3";
import chalk from "chalk";

// ============================================================================
// Types
// ============================================================================

interface SessionInfo {
  sessionId: string;
  streamId: string;
  senderKey: string;
  algorithm: string;
  timestamp: number;
  creatorUserId: string;
  deviceKeys: string[];
  miniblockNum: bigint;
}

interface AckInfo {
  deviceKey: string;
  miniblockNum: bigint;
  timestamp: number;
  creatorUserId: string;
}

interface DeviceStats {
  deviceKey: string;
  sessionsReceived: number;
  lastAckMiniblock: bigint;
  lastAckTimestamp: number;
  firstSeenTimestamp: number;
  lastSeenTimestamp: number;
  uniqueSenders: Set<string>;
}

interface StreamStats {
  streamId: string;
  sessionCount: number;
  uniqueSessionIds: Set<string>;
  duplicateSessionIds: Map<string, number>;
  senders: Set<string>;
  algorithms: Set<string>;
  deviceKeys: Set<string>;
  firstEventTimestamp: number;
  lastEventTimestamp: number;
}

interface InboxAnalysis {
  // Overview
  totalEvents: number;
  totalSessions: number;
  totalAcks: number;
  timeRangeStart: number;
  timeRangeEnd: number;

  // Session analysis
  sessions: SessionInfo[];
  sessionIdOccurrences: Map<string, SessionInfo[]>;
  duplicateSessionIds: Map<string, SessionInfo[]>;

  // Device analysis
  devices: Map<string, DeviceStats>;
  deviceAcks: Map<string, AckInfo[]>;

  // Stream analysis
  streams: Map<string, StreamStats>;

  // Ack analysis
  acks: AckInfo[];
  acksByDevice: Map<string, AckInfo[]>;

  // Anomalies
  anomalies: Anomaly[];
}

interface Anomaly {
  type:
    | "duplicate_session"
    | "missing_ack"
    | "ack_gap"
    | "stale_device"
    | "high_session_rate"
    | "ack_before_session";
  severity: "low" | "medium" | "high";
  description: string;
  details: Record<string, unknown>;
}

// ============================================================================
// Analysis Functions
// ============================================================================

function createEmptyAnalysis(): InboxAnalysis {
  return {
    totalEvents: 0,
    totalSessions: 0,
    totalAcks: 0,
    timeRangeStart: Infinity,
    timeRangeEnd: 0,
    sessions: [],
    sessionIdOccurrences: new Map(),
    duplicateSessionIds: new Map(),
    devices: new Map(),
    deviceAcks: new Map(),
    streams: new Map(),
    acks: [],
    acksByDevice: new Map(),
    anomalies: [],
  };
}

function processEvent(
  event: ParsedEvent,
  analysis: InboxAnalysis,
  miniblockNum: bigint
): void {
  const payload = event.event.payload;
  if (payload?.case !== "userInboxPayload") {
    return;
  }

  analysis.totalEvents++;
  const timestamp = Number(event.event.createdAtEpochMs);
  analysis.timeRangeStart = Math.min(analysis.timeRangeStart, timestamp);
  analysis.timeRangeEnd = Math.max(analysis.timeRangeEnd, timestamp);

  const content = payload.value.content;

  if (content?.case === "groupEncryptionSessions") {
    processGroupEncryptionSession(
      event,
      content.value,
      analysis,
      timestamp,
      miniblockNum
    );
  } else if (content?.case === "ack") {
    processAck(event, content.value, analysis, timestamp);
  }
}

function processGroupEncryptionSession(
  event: ParsedEvent,
  session: {
    streamId: Uint8Array;
    senderKey: string;
    sessionIds: string[];
    ciphertexts: { [key: string]: string };
    algorithm: string;
  },
  analysis: InboxAnalysis,
  timestamp: number,
  miniblockNum: bigint
): void {
  const streamId = streamIdAsString(session.streamId);
  const deviceKeys = Object.keys(session.ciphertexts);
  const algorithmParsed = parseGroupEncryptionAlgorithmId(session.algorithm);

  // Process each session ID
  for (const sessionId of session.sessionIds) {
    analysis.totalSessions++;

    const sessionInfo: SessionInfo = {
      sessionId,
      streamId,
      senderKey: session.senderKey,
      algorithm: algorithmParsed.value,
      timestamp,
      creatorUserId: event.creatorUserId,
      deviceKeys,
      miniblockNum,
    };

    analysis.sessions.push(sessionInfo);

    // Track session ID occurrences
    if (!analysis.sessionIdOccurrences.has(sessionId)) {
      analysis.sessionIdOccurrences.set(sessionId, []);
    }
    analysis.sessionIdOccurrences.get(sessionId)!.push(sessionInfo);

    // Update device stats
    for (const deviceKey of deviceKeys) {
      if (!analysis.devices.has(deviceKey)) {
        analysis.devices.set(deviceKey, {
          deviceKey,
          sessionsReceived: 0,
          lastAckMiniblock: 0n,
          lastAckTimestamp: 0,
          firstSeenTimestamp: timestamp,
          lastSeenTimestamp: timestamp,
          uniqueSenders: new Set(),
        });
      }
      const deviceStats = analysis.devices.get(deviceKey)!;
      deviceStats.sessionsReceived++;
      deviceStats.lastSeenTimestamp = Math.max(
        deviceStats.lastSeenTimestamp,
        timestamp
      );
      deviceStats.firstSeenTimestamp = Math.min(
        deviceStats.firstSeenTimestamp,
        timestamp
      );
      deviceStats.uniqueSenders.add(event.creatorUserId);
    }

    // Update stream stats
    if (!analysis.streams.has(streamId)) {
      analysis.streams.set(streamId, {
        streamId,
        sessionCount: 0,
        uniqueSessionIds: new Set(),
        duplicateSessionIds: new Map(),
        senders: new Set(),
        algorithms: new Set(),
        deviceKeys: new Set(),
        firstEventTimestamp: timestamp,
        lastEventTimestamp: timestamp,
      });
    }
    const streamStats = analysis.streams.get(streamId)!;
    streamStats.sessionCount++;
    streamStats.senders.add(event.creatorUserId);
    streamStats.algorithms.add(algorithmParsed.value);
    for (const dk of deviceKeys) {
      streamStats.deviceKeys.add(dk);
    }
    streamStats.firstEventTimestamp = Math.min(
      streamStats.firstEventTimestamp,
      timestamp
    );
    streamStats.lastEventTimestamp = Math.max(
      streamStats.lastEventTimestamp,
      timestamp
    );

    if (streamStats.uniqueSessionIds.has(sessionId)) {
      const count = streamStats.duplicateSessionIds.get(sessionId) || 1;
      streamStats.duplicateSessionIds.set(sessionId, count + 1);
    }
    streamStats.uniqueSessionIds.add(sessionId);
  }
}

function processAck(
  event: ParsedEvent,
  ack: { deviceKey: string; miniblockNum: bigint },
  analysis: InboxAnalysis,
  timestamp: number
): void {
  analysis.totalAcks++;

  const ackInfo: AckInfo = {
    deviceKey: ack.deviceKey,
    miniblockNum: ack.miniblockNum,
    timestamp,
    creatorUserId: event.creatorUserId,
  };

  analysis.acks.push(ackInfo);

  // Track acks by device
  if (!analysis.acksByDevice.has(ack.deviceKey)) {
    analysis.acksByDevice.set(ack.deviceKey, []);
  }
  analysis.acksByDevice.get(ack.deviceKey)!.push(ackInfo);

  // Update device stats with ack info
  if (!analysis.devices.has(ack.deviceKey)) {
    analysis.devices.set(ack.deviceKey, {
      deviceKey: ack.deviceKey,
      sessionsReceived: 0,
      lastAckMiniblock: ack.miniblockNum,
      lastAckTimestamp: timestamp,
      firstSeenTimestamp: timestamp,
      lastSeenTimestamp: timestamp,
      uniqueSenders: new Set(),
    });
  }
  const deviceStats = analysis.devices.get(ack.deviceKey)!;
  if (ack.miniblockNum > deviceStats.lastAckMiniblock) {
    deviceStats.lastAckMiniblock = ack.miniblockNum;
    deviceStats.lastAckTimestamp = timestamp;
  }
}

function detectAnomalies(analysis: InboxAnalysis): void {
  // 1. Detect duplicate session IDs
  for (const [sessionId, sessions] of analysis.sessionIdOccurrences) {
    if (sessions.length > 1) {
      analysis.duplicateSessionIds.set(sessionId, sessions);

      // Check if duplicates are from same sender (more concerning)
      const senders = new Set(sessions.map((s) => s.creatorUserId));
      const severity = senders.size === 1 ? "high" : "medium";

      analysis.anomalies.push({
        type: "duplicate_session",
        severity,
        description: `Session ID ${sessionId.substring(0, 16)}... appears ${
          sessions.length
        } times`,
        details: {
          sessionId,
          occurrences: sessions.length,
          senders: Array.from(senders),
          streams: [...new Set(sessions.map((s) => s.streamId))],
          timestamps: sessions.map((s) => new Date(s.timestamp).toISOString()),
        },
      });
    }
  }

  // 2. Detect devices with sessions but no acks
  for (const [deviceKey, deviceStats] of analysis.devices) {
    if (
      deviceStats.sessionsReceived > 0 &&
      deviceStats.lastAckMiniblock === 0n
    ) {
      const timeSinceLastSession =
        analysis.timeRangeEnd - deviceStats.lastSeenTimestamp;
      const hoursSinceLastSession = timeSinceLastSession / (1000 * 60 * 60);

      if (hoursSinceLastSession > 24) {
        analysis.anomalies.push({
          type: "missing_ack",
          severity: "medium",
          description: `Device ${deviceKey.substring(0, 16)}... has ${
            deviceStats.sessionsReceived
          } sessions but no acks`,
          details: {
            deviceKey,
            sessionsReceived: deviceStats.sessionsReceived,
            lastSeenTimestamp: new Date(
              deviceStats.lastSeenTimestamp
            ).toISOString(),
            hoursSinceLastSession,
          },
        });
      }
    }
  }

  // 3. Detect ack gaps (acks that skip many miniblocks)
  for (const [deviceKey, acks] of analysis.acksByDevice) {
    const sortedAcks = [...acks].sort((a, b) =>
      Number(a.miniblockNum - b.miniblockNum)
    );
    for (let i = 1; i < sortedAcks.length; i++) {
      const gap = Number(
        sortedAcks[i].miniblockNum - sortedAcks[i - 1].miniblockNum
      );
      if (gap > 100) {
        analysis.anomalies.push({
          type: "ack_gap",
          severity: "low",
          description: `Device ${deviceKey.substring(
            0,
            16
          )}... has ${gap} miniblock gap between acks`,
          details: {
            deviceKey,
            previousAck: Number(sortedAcks[i - 1].miniblockNum),
            currentAck: Number(sortedAcks[i].miniblockNum),
            gap,
          },
        });
      }
    }
  }

  // 4. Detect high session rate (spam detection)
  const sessionsByMinute = new Map<string, number>();
  for (const session of analysis.sessions) {
    const minuteKey = new Date(session.timestamp)
      .toISOString()
      .substring(0, 16);
    sessionsByMinute.set(minuteKey, (sessionsByMinute.get(minuteKey) || 0) + 1);
  }

  for (const [minute, count] of sessionsByMinute) {
    if (count > 50) {
      analysis.anomalies.push({
        type: "high_session_rate",
        severity: "medium",
        description: `${count} sessions in minute ${minute}`,
        details: { minute, count },
      });
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

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.substring(0, len - 3) + "...";
}

function printOverview(analysis: InboxAnalysis): void {
  console.log(chalk.bold.cyan("\n" + "═".repeat(80)));
  console.log(chalk.bold.cyan("  USER INBOX ANALYSIS REPORT"));
  console.log(chalk.bold.cyan("═".repeat(80)));

  const duration = analysis.timeRangeEnd - analysis.timeRangeStart;

  const overviewTable = new Table({
    chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
  });

  overviewTable.push(
    [
      chalk.gray("Time Range"),
      `${new Date(analysis.timeRangeStart).toISOString()} → ${new Date(
        analysis.timeRangeEnd
      ).toISOString()}`,
    ],
    [chalk.gray("Duration"), formatDuration(duration)],
    [chalk.gray("Total Events"), chalk.yellow(analysis.totalEvents.toString())],
    [
      chalk.gray("Total Sessions"),
      chalk.green(analysis.totalSessions.toString()),
    ],
    [chalk.gray("Total Acks"), chalk.blue(analysis.totalAcks.toString())],
    [
      chalk.gray("Unique Devices"),
      chalk.magenta(analysis.devices.size.toString()),
    ],
    [
      chalk.gray("Unique Streams"),
      chalk.cyan(analysis.streams.size.toString()),
    ],
    [
      chalk.gray("Duplicate Session IDs"),
      analysis.duplicateSessionIds.size > 0
        ? chalk.red(analysis.duplicateSessionIds.size.toString())
        : chalk.green("0"),
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

function printSessionDistribution(analysis: InboxAnalysis): void {
  console.log(chalk.bold.yellow("\n" + "─".repeat(80)));
  console.log(chalk.bold.yellow("  SESSION DISTRIBUTION BY STREAM"));
  console.log(chalk.bold.yellow("─".repeat(80)));

  const streamTable = new Table({
    head: [
      chalk.white("Stream ID"),
      chalk.white("Sessions"),
      chalk.white("Unique"),
      chalk.white("Duplicates"),
      chalk.white("Senders"),
      chalk.white("Algorithms"),
      chalk.white("Time Span"),
    ],
    colWidths: [22, 10, 10, 12, 10, 12, 14],
  });

  const sortedStreams = [...analysis.streams.values()].sort(
    (a, b) => b.sessionCount - a.sessionCount
  );

  for (const stream of sortedStreams.slice(0, 20)) {
    const duplicateCount = stream.duplicateSessionIds.size;
    const timeSpan = stream.lastEventTimestamp - stream.firstEventTimestamp;

    streamTable.push([
      truncate(stream.streamId, 20),
      stream.sessionCount.toString(),
      stream.uniqueSessionIds.size.toString(),
      duplicateCount > 0
        ? chalk.red(duplicateCount.toString())
        : chalk.green("0"),
      stream.senders.size.toString(),
      [...stream.algorithms].join(", "),
      formatDuration(timeSpan),
    ]);
  }

  console.log(streamTable.toString());

  if (sortedStreams.length > 20) {
    console.log(
      chalk.gray(`  ... and ${sortedStreams.length - 20} more streams`)
    );
  }
}

function printDeviceAnalysis(analysis: InboxAnalysis): void {
  console.log(chalk.bold.magenta("\n" + "─".repeat(80)));
  console.log(chalk.bold.magenta("  DEVICE ANALYSIS"));
  console.log(chalk.bold.magenta("─".repeat(80)));

  const deviceTable = new Table({
    head: [
      chalk.white("Device Key"),
      chalk.white("Sessions"),
      chalk.white("Senders"),
      chalk.white("Last Ack Block"),
      chalk.white("Last Ack Time"),
      chalk.white("Status"),
    ],
    colWidths: [22, 10, 10, 16, 22, 12],
  });

  const sortedDevices = [...analysis.devices.values()].sort(
    (a, b) => b.sessionsReceived - a.sessionsReceived
  );

  for (const device of sortedDevices.slice(0, 15)) {
    const hasAck = device.lastAckMiniblock > 0n;
    const status = hasAck ? chalk.green("Active") : chalk.yellow("No Acks");
    const lastAckTime =
      device.lastAckTimestamp > 0
        ? new Date(device.lastAckTimestamp).toISOString().substring(0, 19)
        : "-";

    deviceTable.push([
      truncate(device.deviceKey, 20),
      device.sessionsReceived.toString(),
      device.uniqueSenders.size.toString(),
      device.lastAckMiniblock.toString(),
      lastAckTime,
      status,
    ]);
  }

  console.log(deviceTable.toString());

  if (sortedDevices.length > 15) {
    console.log(
      chalk.gray(`  ... and ${sortedDevices.length - 15} more devices`)
    );
  }

  // Device summary
  const activeDevices = [...analysis.devices.values()].filter(
    (d) => d.lastAckMiniblock > 0n
  ).length;
  const inactiveDevices = analysis.devices.size - activeDevices;

  console.log(
    chalk.gray(
      `\n  Summary: ${chalk.green(
        activeDevices.toString()
      )} active devices (with acks), ${chalk.yellow(
        inactiveDevices.toString()
      )} inactive devices`
    )
  );
}

function printDuplicateSessionAnalysis(analysis: InboxAnalysis): void {
  if (analysis.duplicateSessionIds.size === 0) {
    console.log(chalk.bold.green("\n" + "─".repeat(80)));
    console.log(chalk.bold.green("  DUPLICATE SESSION ANALYSIS"));
    console.log(chalk.bold.green("─".repeat(80)));
    console.log(chalk.green("  ✓ No duplicate session IDs detected"));
    return;
  }

  console.log(chalk.bold.red("\n" + "─".repeat(80)));
  console.log(chalk.bold.red("  DUPLICATE SESSION ANALYSIS"));
  console.log(chalk.bold.red("─".repeat(80)));

  const dupTable = new Table({
    head: [
      chalk.white("Session ID"),
      chalk.white("Count"),
      chalk.white("Senders"),
      chalk.white("Streams"),
      chalk.white("First Seen"),
      chalk.white("Last Seen"),
    ],
    colWidths: [22, 8, 10, 10, 22, 22],
  });

  const sortedDuplicates = [...analysis.duplicateSessionIds.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15);

  for (const [sessionId, sessions] of sortedDuplicates) {
    const senders = new Set(sessions.map((s) => s.creatorUserId));
    const streams = new Set(sessions.map((s) => s.streamId));
    const timestamps = sessions.map((s) => s.timestamp).sort();

    dupTable.push([
      truncate(sessionId, 20),
      chalk.red(sessions.length.toString()),
      senders.size.toString(),
      streams.size.toString(),
      new Date(timestamps[0]).toISOString().substring(0, 19),
      new Date(timestamps[timestamps.length - 1])
        .toISOString()
        .substring(0, 19),
    ]);
  }

  console.log(dupTable.toString());

  if (analysis.duplicateSessionIds.size > 15) {
    console.log(
      chalk.gray(
        `  ... and ${
          analysis.duplicateSessionIds.size - 15
        } more duplicate session IDs`
      )
    );
  }
}

function printAckAnalysis(analysis: InboxAnalysis): void {
  console.log(chalk.bold.blue("\n" + "─".repeat(80)));
  console.log(chalk.bold.blue("  ACK BEHAVIOR ANALYSIS"));
  console.log(chalk.bold.blue("─".repeat(80)));

  if (analysis.acks.length === 0) {
    console.log(chalk.yellow("  No acks found in the analyzed data"));
    return;
  }

  // Ack timeline
  const acksByHour = new Map<string, number>();
  for (const ack of analysis.acks) {
    const hourKey = new Date(ack.timestamp).toISOString().substring(0, 13);
    acksByHour.set(hourKey, (acksByHour.get(hourKey) || 0) + 1);
  }

  const sortedHours = [...acksByHour.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  const maxAcks = Math.max(...sortedHours.map(([, count]) => count));

  console.log(chalk.gray("  Acks per hour (last 24 entries):"));
  for (const [hour, count] of sortedHours.slice(-24)) {
    const barLength = Math.round((count / maxAcks) * 40);
    const bar = "█".repeat(barLength) + "░".repeat(40 - barLength);
    console.log(`  ${hour} │${chalk.blue(bar)}│ ${count}`);
  }

  // Ack latency analysis per device
  console.log(chalk.gray("\n  Ack Frequency per Device:"));
  const ackFreqTable = new Table({
    head: [
      chalk.white("Device Key"),
      chalk.white("Total Acks"),
      chalk.white("Avg Gap (blocks)"),
      chalk.white("Max Gap"),
      chalk.white("Last Ack Block"),
    ],
    colWidths: [22, 12, 18, 12, 18],
  });

  for (const [deviceKey, acks] of analysis.acksByDevice) {
    if (acks.length < 2) continue;

    const sortedAcks = [...acks].sort((a, b) =>
      Number(a.miniblockNum - b.miniblockNum)
    );
    const gaps: number[] = [];
    for (let i = 1; i < sortedAcks.length; i++) {
      gaps.push(
        Number(sortedAcks[i].miniblockNum - sortedAcks[i - 1].miniblockNum)
      );
    }

    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const maxGap = Math.max(...gaps);

    ackFreqTable.push([
      truncate(deviceKey, 20),
      acks.length.toString(),
      avgGap.toFixed(1),
      maxGap.toString(),
      sortedAcks[sortedAcks.length - 1].miniblockNum.toString(),
    ]);
  }

  console.log(ackFreqTable.toString());
}

function printAnomalies(analysis: InboxAnalysis): void {
  console.log(chalk.bold.red("\n" + "─".repeat(80)));
  console.log(chalk.bold.red("  ANOMALIES & WARNINGS"));
  console.log(chalk.bold.red("─".repeat(80)));

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

    for (const anomaly of anomalies.slice(0, 5)) {
      const color = severityColors[anomaly.severity];
      const icon = severityIcons[anomaly.severity];
      console.log(`    ${icon} ${color(anomaly.description)}`);
    }

    if (anomalies.length > 5) {
      console.log(chalk.gray(`    ... and ${anomalies.length - 5} more`));
    }
  }
}

function printSessionTimeline(analysis: InboxAnalysis): void {
  console.log(chalk.bold.green("\n" + "─".repeat(80)));
  console.log(chalk.bold.green("  SESSION TIMELINE"));
  console.log(chalk.bold.green("─".repeat(80)));

  // Sessions per hour
  const sessionsByHour = new Map<string, number>();
  for (const session of analysis.sessions) {
    const hourKey = new Date(session.timestamp).toISOString().substring(0, 13);
    sessionsByHour.set(hourKey, (sessionsByHour.get(hourKey) || 0) + 1);
  }

  const sortedHours = [...sessionsByHour.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );
  const maxSessions = Math.max(...sortedHours.map(([, count]) => count));

  console.log(chalk.gray("  Sessions per hour (last 24 entries):"));
  for (const [hour, count] of sortedHours.slice(-24)) {
    const barLength = Math.round((count / maxSessions) * 40);
    const bar = "█".repeat(barLength) + "░".repeat(40 - barLength);
    console.log(`  ${hour} │${chalk.green(bar)}│ ${count}`);
  }
}

function printSenderAnalysis(analysis: InboxAnalysis): void {
  console.log(chalk.bold.cyan("\n" + "─".repeat(80)));
  console.log(chalk.bold.cyan("  TOP SENDERS"));
  console.log(chalk.bold.cyan("─".repeat(80)));

  const senderCounts = new Map<string, number>();
  for (const session of analysis.sessions) {
    senderCounts.set(
      session.creatorUserId,
      (senderCounts.get(session.creatorUserId) || 0) + 1
    );
  }

  const sortedSenders = [...senderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const senderTable = new Table({
    head: [
      chalk.white("Sender"),
      chalk.white("Sessions Sent"),
      chalk.white("% of Total"),
    ],
    colWidths: [50, 16, 14],
  });

  for (const [sender, count] of sortedSenders) {
    const percentage = ((count / analysis.totalSessions) * 100).toFixed(1);
    senderTable.push([
      truncate(sender, 48),
      count.toString(),
      `${percentage}%`,
    ]);
  }

  console.log(senderTable.toString());
}

// ============================================================================
// Main
// ============================================================================

const run = async () => {
  const param = process.argv[2];
  const blocksToFetch = parseInt(process.argv[3] || "500", 10);

  if (!param) {
    console.error(
      chalk.red("Usage: yarn inbox <wallet_address> [blocks_to_fetch]")
    );
    console.error(chalk.gray("  blocks_to_fetch defaults to 500"));
    process.exit(1);
  }

  console.log(
    chalk.cyan(`\nAnalyzing inbox for ${param} in ${env.ENVIRONMENT}`)
  );
  console.log(chalk.gray(`Fetching last ${blocksToFetch} miniblocks...\n`));
  // Setup
  const config = townsEnv({ env }).makeTownsConfig();
  const spaceDapp = new SpaceDapp(
    config.base.chainConfig,
    new LocalhostWeb3Provider(config.base.rpcUrl)
  );

  let rootWallet: string;
  let userInboxStreamId: string;
  if (param.startsWith("0x")) {
    const rootKey = await spaceDapp.walletLink.getRootKeyForWallet(param);
    rootWallet = rootKey === INVALID_ADDRESS ? param : rootKey;
    userInboxStreamId = makeUserInboxStreamId(param);
  } else {
    rootWallet = getUserIdFromStreamId(param);
    userInboxStreamId = makeUserInboxStreamId(rootWallet);
  }

  console.log(chalk.gray(`Root wallet: ${rootWallet}`));
  console.log(chalk.gray(`User inbox stream ID: ${userInboxStreamId}`));

  // Make user inbox stream ID
  console.log(chalk.gray(`Inbox stream: ${userInboxStreamId}`));

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
  const streamId = streamIdAsBytes(userInboxStreamId);
  const response1 = await riverRpcProvider.getLastMiniblockHash({ streamId });
  const { miniblockNum } = response1;

  console.log(chalk.gray(`Latest miniblock: ${miniblockNum}`));

  const fromBlock =
    miniblockNum > BigInt(blocksToFetch)
      ? miniblockNum - BigInt(blocksToFetch)
      : 0n;

  console.log(chalk.gray(`Fetching blocks ${fromBlock} to ${miniblockNum}...`));

  const blocks = await riverRpcProvider.getMiniblocks({
    streamId,
    fromInclusive: fromBlock,
    toExclusive: miniblockNum,
  });

  console.log(
    chalk.gray(`Processing ${blocks.miniblocks.length} miniblocks...`)
  );

  // Analyze
  const analysis = createEmptyAnalysis();

  for (const block of blocks.miniblocks) {
    const unpacked = await unpackMiniblock(block, {
      disableHashValidation: true,
      disableSignatureValidation: true,
    });

    for (const event of unpacked.events) {
      processEvent(event, analysis, unpacked.header.miniblockNum);
    }
  }

  // Detect anomalies
  detectAnomalies(analysis);

  // Print reports
  printOverview(analysis);
  printSessionTimeline(analysis);
  printSessionDistribution(analysis);
  printDeviceAnalysis(analysis);
  printDuplicateSessionAnalysis(analysis);
  printAckAnalysis(analysis);
  printSenderAnalysis(analysis);
  printAnomalies(analysis);

  console.log(chalk.bold.cyan("\n" + "═".repeat(80)));
  console.log(chalk.bold.cyan("  END OF REPORT"));
  console.log(chalk.bold.cyan("═".repeat(80) + "\n"));
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(chalk.red("Unhandled error:"), e);
    process.exit(1);
  });
