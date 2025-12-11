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
import { Envelope, Snapshot, SnapshotSchema } from "@towns-protocol/proto";
import { fromBinary } from "@bufbuild/protobuf";
import {
  INVALID_ADDRESS,
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceDapp,
} from "@towns-protocol/web3";
import { env } from "./env";
import Table from "cli-table3";
import chalk from "chalk";
import { getCachedMiniblocks } from "./utils/utils";

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

interface DeviceSessionDuplicate {
  deviceKey: string;
  sessionId: string;
  count: number;
  streamId: string;
  senders: Set<string>;
  firstSeen: number;
  lastSeen: number;
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
  // Per-device session tracking: "deviceKey:sessionId" -> count (lightweight)
  deviceSessionCounts: Map<
    string,
    {
      count: number;
      streamId: string;
      senders: Set<string>;
      firstSeen: number;
      lastSeen: number;
    }
  >;
  // Duplicates per device (same session to same device twice)
  deviceSessionDuplicates: DeviceSessionDuplicate[];

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
    deviceSessionCounts: new Map(),
    deviceSessionDuplicates: [],
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

    // Update device stats and track per-device session occurrences
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

      // Track per-device session counts for duplicate detection (lightweight)
      const countKey = `${deviceKey}:${sessionId}`;
      const existing = analysis.deviceSessionCounts.get(countKey);
      if (existing) {
        existing.count++;
        existing.senders.add(event.creatorUserId);
        existing.lastSeen = Math.max(existing.lastSeen, timestamp);
      } else {
        analysis.deviceSessionCounts.set(countKey, {
          count: 1,
          streamId,
          senders: new Set([event.creatorUserId]),
          firstSeen: timestamp,
          lastSeen: timestamp,
        });
      }
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
  // 1. Detect duplicate session IDs PER DEVICE (same session to same device twice)
  for (const [countKey, data] of analysis.deviceSessionCounts) {
    if (data.count > 1) {
      const [deviceKey, sessionId] = countKey.split(":");

      // This is a true duplicate: same session ID sent to same device multiple times
      analysis.deviceSessionDuplicates.push({
        deviceKey,
        sessionId,
        count: data.count,
        streamId: data.streamId,
        senders: data.senders,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen,
      });

      // Check if duplicates are from same sender (more concerning)
      const severity = data.senders.size === 1 ? "high" : "medium";

      analysis.anomalies.push({
        type: "duplicate_session",
        severity,
        description: `Session ${sessionId.substring(
          0,
          16
        )}... sent to device ${deviceKey.substring(0, 12)}... ${
          data.count
        } times`,
        details: {
          deviceKey,
          sessionId,
          occurrences: data.count,
          senders: Array.from(data.senders),
          streamId: data.streamId,
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
      chalk.white("Dups"),
      chalk.white("Senders"),
      chalk.white("Algo"),
      chalk.white("Time Span"),
    ],
    wordWrap: true,
  });

  const sortedStreams = [...analysis.streams.values()].sort(
    (a, b) => b.sessionCount - a.sessionCount
  );

  for (const stream of sortedStreams.slice(0, 20)) {
    const duplicateCount = stream.duplicateSessionIds.size;
    const timeSpan = stream.lastEventTimestamp - stream.firstEventTimestamp;

    streamTable.push([
      stream.streamId,
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

function formatDateTime(timestamp: number): string {
  if (timestamp <= 0) return "-";
  const date = new Date(timestamp);
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const mins = date.getMinutes().toString().padStart(2, "0");
  const secs = date.getSeconds().toString().padStart(2, "0");
  return `${month} ${day} ${hours}:${mins}:${secs}`;
}

function printSnapshotDeviceSummary(snapshots: {
  [key: string]: Envelope;
}): void {
  console.log(chalk.bold.green("\n" + "═".repeat(80)));
  console.log(chalk.bold.green("  SNAPSHOT DEVICE SUMMARY"));
  console.log(chalk.bold.green("═".repeat(80)));

  // Find the snapshot with the highest block number
  const snapshotKeys = Object.keys(snapshots);
  if (snapshotKeys.length === 0) {
    console.log(chalk.yellow("  No snapshots found in fetched data"));
    return;
  }

  // Sort by block number descending and take the highest
  const sortedKeys = snapshotKeys.sort((a, b) => Number(BigInt(b) - BigInt(a)));
  const highestBlockNum = sortedKeys[0];
  const snapshotEnvelope = snapshots[highestBlockNum];

  console.log(
    chalk.gray(`  Using snapshot from miniblock ${highestBlockNum}\n`)
  );

  let snapshot: Snapshot;
  try {
    snapshot = fromBinary(SnapshotSchema, snapshotEnvelope.event);
  } catch (e) {
    console.log(chalk.yellow("  Failed to decode snapshot"));
    return;
  }

  // Check if it's a user inbox snapshot
  if (snapshot.content?.case !== "userInboxContent") {
    console.log(
      chalk.yellow(
        `  Snapshot is not a user inbox snapshot (case: ${snapshot.content?.case})`
      )
    );
    return;
  }

  const inboxContent = snapshot.content.value;
  const deviceSummary = inboxContent.deviceSummary;

  if (!deviceSummary || Object.keys(deviceSummary).length === 0) {
    console.log(chalk.yellow("  No device summary in snapshot"));
    return;
  }

  const deviceTable = new Table({
    head: [
      chalk.white("Device Key"),
      chalk.white("Lower Bound"),
      chalk.white("Upper Bound"),
      chalk.white("Gap"),
    ],
    wordWrap: true,
  });

  const entries = Object.entries(deviceSummary).sort((a, b) => {
    // Sort by upper_bound descending (most recent activity first)
    return Number(b[1].upperBound - a[1].upperBound);
  });

  for (const [deviceKey, summary] of entries) {
    const gap = Number(summary.upperBound - summary.lowerBound);
    deviceTable.push([
      deviceKey,
      summary.lowerBound.toString(),
      summary.upperBound.toString(),
      gap > 0 ? chalk.yellow(gap.toString()) : chalk.green("0"),
    ]);
  }

  console.log(deviceTable.toString());

  console.log(
    chalk.gray(
      `\n  Summary: ${entries.length} devices in snapshot | ` +
        `Lower bound = latest ack | Upper bound = latest event sent to device`
    )
  );
}

function printDeviceAnalysis(analysis: InboxAnalysis): void {
  console.log(chalk.bold.magenta("\n" + "─".repeat(80)));
  console.log(chalk.bold.magenta("  DEVICE ANALYSIS (ALL DEVICES)"));
  console.log(chalk.bold.magenta("─".repeat(80)));

  const deviceTable = new Table({
    head: [
      chalk.white("Device Key"),
      chalk.white("Sessions"),
      chalk.white("Unique"),
      chalk.white("Dupes"),
      chalk.white("Senders"),
      chalk.white("First Seen"),
      chalk.white("Last Seen"),
      chalk.white("Last Ack"),
      chalk.white("Status"),
    ],
    wordWrap: true,
  });

  const sortedDevices = [...analysis.devices.values()].sort(
    (a, b) => b.lastSeenTimestamp - a.lastSeenTimestamp
  );

  // Count unique sessions and duplicates per device
  const uniquePerDevice = new Map<string, number>();
  const duplicatesPerDevice = new Map<string, number>();

  for (const [countKey, data] of analysis.deviceSessionCounts) {
    const deviceKey = countKey.split(":")[0];
    uniquePerDevice.set(deviceKey, (uniquePerDevice.get(deviceKey) || 0) + 1);
    if (data.count > 1) {
      duplicatesPerDevice.set(
        deviceKey,
        (duplicatesPerDevice.get(deviceKey) || 0) + (data.count - 1)
      );
    }
  }

  for (const device of sortedDevices) {
    const hasAck = device.lastAckMiniblock > 0n;
    const uniqueCount = uniquePerDevice.get(device.deviceKey) || 0;
    const dupCount = duplicatesPerDevice.get(device.deviceKey) || 0;

    const status = hasAck ? chalk.green("Active") : chalk.yellow("No Acks");

    deviceTable.push([
      device.deviceKey,
      device.sessionsReceived.toString(),
      uniqueCount.toString(),
      dupCount > 0 ? chalk.red(dupCount.toString()) : chalk.green("0"),
      device.uniqueSenders.size.toString(),
      formatDateTime(device.firstSeenTimestamp),
      formatDateTime(device.lastSeenTimestamp),
      formatDateTime(device.lastAckTimestamp),
      status,
    ]);
  }

  console.log(deviceTable.toString());

  // Device summary
  const activeDevices = [...analysis.devices.values()].filter(
    (d) => d.lastAckMiniblock > 0n
  ).length;
  const inactiveDevices = analysis.devices.size - activeDevices;
  const devicesWithDups = duplicatesPerDevice.size;

  console.log(
    chalk.gray(
      `\n  Summary: ${analysis.devices.size} total devices | ` +
        `${chalk.green(activeDevices.toString())} active (with acks) | ` +
        `${chalk.yellow(inactiveDevices.toString())} inactive | ` +
        (devicesWithDups > 0
          ? chalk.red(`${devicesWithDups} with duplicate sessions`)
          : chalk.green("0 with duplicates"))
    )
  );
}

function printDuplicateSessionAnalysis(analysis: InboxAnalysis): void {
  if (analysis.deviceSessionDuplicates.length === 0) {
    console.log(chalk.bold.green("\n" + "─".repeat(80)));
    console.log(chalk.bold.green("  DUPLICATE SESSION ANALYSIS (PER DEVICE)"));
    console.log(chalk.bold.green("─".repeat(80)));
    console.log(
      chalk.green(
        "  ✓ No duplicate sessions detected (same session to same device)"
      )
    );
    return;
  }

  console.log(chalk.bold.red("\n" + "─".repeat(80)));
  console.log(chalk.bold.red("  DUPLICATE SESSION ANALYSIS (PER DEVICE)"));
  console.log(chalk.bold.red("─".repeat(80)));
  console.log(
    chalk.gray(
      "  Showing sessions that were sent to the SAME device multiple times\n"
    )
  );

  const dupTable = new Table({
    head: [
      chalk.white("Device Key"),
      chalk.white("Session ID"),
      chalk.white("Count"),
      chalk.white("Stream"),
      chalk.white("Senders"),
      chalk.white("First Seen"),
      chalk.white("Last Seen"),
    ],
    wordWrap: true,
  });

  // Sort by occurrence count descending, limit to 20
  const sortedDuplicates = [...analysis.deviceSessionDuplicates]
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  for (const dup of sortedDuplicates) {
    dupTable.push([
      dup.deviceKey.substring(0, 20) + "...",
      dup.sessionId.substring(0, 20) + "...",
      chalk.red(dup.count.toString()),
      dup.streamId.substring(0, 20) + "...",
      dup.senders.size === 1 ? "Same sender" : `${dup.senders.size} senders`,
      formatDateTime(dup.firstSeen),
      formatDateTime(dup.lastSeen),
    ]);
  }

  console.log(dupTable.toString());

  if (analysis.deviceSessionDuplicates.length > 20) {
    console.log(
      chalk.gray(
        `  ... and ${
          analysis.deviceSessionDuplicates.length - 20
        } more duplicates`
      )
    );
  }

  // Summary by device
  const deviceDupCounts = new Map<string, number>();
  for (const dup of analysis.deviceSessionDuplicates) {
    deviceDupCounts.set(
      dup.deviceKey,
      (deviceDupCounts.get(dup.deviceKey) || 0) + 1
    );
  }

  console.log(chalk.gray(`\n  Summary:`));
  console.log(
    chalk.gray(
      `    Total duplicate session instances: ${chalk.red(
        analysis.deviceSessionDuplicates.length.toString()
      )}`
    )
  );
  console.log(
    chalk.gray(
      `    Devices affected: ${chalk.red(deviceDupCounts.size.toString())}`
    )
  );
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
    wordWrap: true,
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
      deviceKey,
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
    wordWrap: true,
  });

  for (const [sender, count] of sortedSenders) {
    const percentage = ((count / analysis.totalSessions) * 100).toFixed(1);
    senderTable.push([sender, count.toString(), `${percentage}%`]);
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

  const responses = await getCachedMiniblocks(
    riverRpcProvider,
    userInboxStreamId,
    fromBlock,
    miniblockNum,
    {
      batchSize: 50,
      onProgress: (msg) => console.log(chalk.gray(msg)),
    }
  );

  const total = responses.reduce(
    (acc, response) => acc + response.miniblocks.length,
    0
  );

  console.log(chalk.gray(`Processing ${total} miniblocks...`));

  // Collect all snapshots from responses
  const allSnapshots: { [key: string]: Envelope } = {};
  for (const response of responses) {
    for (const [blockNum, envelope] of Object.entries(response.snapshots)) {
      allSnapshots[blockNum] = envelope as Envelope;
    }
  }

  // Analyze
  const analysis = createEmptyAnalysis();

  for (const response of responses) {
    for (const block of response.miniblocks) {
      const unpacked = await unpackMiniblock(block, {
        disableHashValidation: true,
        disableSignatureValidation: true,
      });

      for (const event of unpacked.events) {
        processEvent(event, analysis, unpacked.header.miniblockNum);
      }
    }
  }

  // Detect anomalies
  detectAnomalies(analysis);

  // Print snapshot device summary first
  printSnapshotDeviceSummary(allSnapshots);

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
