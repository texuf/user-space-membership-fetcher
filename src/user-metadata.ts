import {
  townsEnv,
  makeStreamRpcClient,
  makeUserMetadataStreamId,
  ParsedEvent,
  streamIdAsBytes,
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
import { getCachedMiniblocks } from "./utils/utils";

// ============================================================================
// Types
// ============================================================================

interface DeviceInfo {
  deviceKey: string;
  fallbackKey: string;
  firstSeen: number;
  lastSeen: number;
  eventCount: number;
  creatorUserId: string;
}

interface MetadataAnalysis {
  totalEvents: number;
  timeRangeStart: number;
  timeRangeEnd: number;

  // Event type counts
  eventCounts: Map<string, number>;

  // Device tracking
  devices: Map<string, DeviceInfo>;
  deviceOrder: string[]; // Order devices were first seen

  // Other events
  profileImageUpdates: number;
  bioUpdates: number;
}

// ============================================================================
// Analysis Functions
// ============================================================================

function createEmptyAnalysis(): MetadataAnalysis {
  return {
    totalEvents: 0,
    timeRangeStart: Infinity,
    timeRangeEnd: 0,
    eventCounts: new Map(),
    devices: new Map(),
    deviceOrder: [],
    profileImageUpdates: 0,
    bioUpdates: 0,
  };
}

function formatDateTime(timestamp: number): string {
  if (timestamp <= 0 || timestamp === Infinity) return "-";
  const date = new Date(timestamp);
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const mins = date.getMinutes().toString().padStart(2, "0");
  const secs = date.getSeconds().toString().padStart(2, "0");
  return `${month} ${day} ${hours}:${mins}:${secs}`;
}

function processEvent(
  event: ParsedEvent,
  analysis: MetadataAnalysis
): void {
  const payload = event.event.payload;
  if (payload?.case !== "userMetadataPayload") {
    return;
  }

  analysis.totalEvents++;
  const timestamp = Number(event.event.createdAtEpochMs);
  analysis.timeRangeStart = Math.min(analysis.timeRangeStart, timestamp);
  analysis.timeRangeEnd = Math.max(analysis.timeRangeEnd, timestamp);

  const content = payload.value.content;
  const contentCase = content?.case || "unknown";

  // Track event type counts
  analysis.eventCounts.set(
    contentCase,
    (analysis.eventCounts.get(contentCase) || 0) + 1
  );

  if (content?.case === "encryptionDevice") {
    const device = content.value;
    const deviceKey = device.deviceKey;
    const fallbackKey = device.fallbackKey;

    if (!analysis.devices.has(deviceKey)) {
      analysis.devices.set(deviceKey, {
        deviceKey,
        fallbackKey,
        firstSeen: timestamp,
        lastSeen: timestamp,
        eventCount: 1,
        creatorUserId: event.creatorUserId,
      });
      analysis.deviceOrder.push(deviceKey);
    } else {
      const existing = analysis.devices.get(deviceKey)!;
      existing.lastSeen = Math.max(existing.lastSeen, timestamp);
      existing.firstSeen = Math.min(existing.firstSeen, timestamp);
      existing.eventCount++;
      // Update fallback key if changed
      if (fallbackKey && fallbackKey !== existing.fallbackKey) {
        existing.fallbackKey = fallbackKey;
      }
    }
  } else if (content?.case === "profileImage") {
    analysis.profileImageUpdates++;
  } else if (content?.case === "bio") {
    analysis.bioUpdates++;
  }
}

// ============================================================================
// Display Functions
// ============================================================================

function printOverview(analysis: MetadataAnalysis, streamId: string): void {
  console.log(chalk.bold.cyan("\n" + "═".repeat(80)));
  console.log(chalk.bold.cyan("  USER METADATA ANALYSIS"));
  console.log(chalk.bold.cyan("═".repeat(80)));

  const hasEvents = analysis.timeRangeStart !== Infinity;

  const overviewTable = new Table({
    wordWrap: true,
  });

  overviewTable.push(
    { "Stream ID": streamId },
    {
      "Time Range": hasEvents
        ? `${formatDateTime(analysis.timeRangeStart)} - ${formatDateTime(analysis.timeRangeEnd)}`
        : "No events",
    },
    { "Total Events": analysis.totalEvents.toString() },
    { "Total Devices": analysis.devices.size.toString() },
    { "Profile Updates": analysis.profileImageUpdates.toString() },
    { "Bio Updates": analysis.bioUpdates.toString() }
  );

  console.log(overviewTable.toString());
}

function printEventFrequency(analysis: MetadataAnalysis): void {
  console.log(chalk.bold.yellow("\n" + "─".repeat(80)));
  console.log(chalk.bold.yellow("  EVENT FREQUENCY"));
  console.log(chalk.bold.yellow("─".repeat(80)));

  const freqTable = new Table({
    head: [
      chalk.white("Event Type"),
      chalk.white("Count"),
      chalk.white("% of Total"),
    ],
    wordWrap: true,
  });

  const sortedEvents = [...analysis.eventCounts.entries()].sort(
    (a, b) => b[1] - a[1]
  );

  for (const [eventType, count] of sortedEvents) {
    const percentage = analysis.totalEvents > 0
      ? ((count / analysis.totalEvents) * 100).toFixed(1)
      : "0.0";
    freqTable.push([
      eventType,
      count.toString(),
      `${percentage}%`,
    ]);
  }

  console.log(freqTable.toString());
}

function printDeviceTable(analysis: MetadataAnalysis): void {
  console.log(chalk.bold.magenta("\n" + "─".repeat(80)));
  console.log(chalk.bold.magenta("  DEVICE TABLE"));
  console.log(chalk.bold.magenta("─".repeat(80)));
  console.log(chalk.gray("  Devices shown in order of first appearance\n"));

  if (analysis.devices.size === 0) {
    console.log(chalk.yellow("  No devices found"));
    return;
  }

  const deviceTable = new Table({
    head: [
      chalk.white("#"),
      chalk.white("Device Key"),
      chalk.white("Fallback Key"),
      chalk.white("First Seen"),
      chalk.white("Last Seen"),
      chalk.white("Events"),
    ],
    wordWrap: true,
  });

  let index = 1;
  for (const deviceKey of analysis.deviceOrder) {
    const device = analysis.devices.get(deviceKey)!;
    deviceTable.push([
      index.toString(),
      device.deviceKey,
      device.fallbackKey || "-",
      formatDateTime(device.firstSeen),
      formatDateTime(device.lastSeen),
      device.eventCount.toString(),
    ]);
    index++;
  }

  console.log(deviceTable.toString());

  // Summary
  const now = Date.now();
  const recentDevices = [...analysis.devices.values()].filter(
    (d) => now - d.lastSeen < 24 * 60 * 60 * 1000
  ).length;
  const oldDevices = analysis.devices.size - recentDevices;

  console.log(
    chalk.gray(
      `\n  Summary: ${analysis.devices.size} total devices | ` +
        `${chalk.green(recentDevices.toString())} active (seen <24h) | ` +
        `${chalk.yellow(oldDevices.toString())} older`
    )
  );
}

function printDeviceTimeline(analysis: MetadataAnalysis): void {
  console.log(chalk.bold.blue("\n" + "─".repeat(80)));
  console.log(chalk.bold.blue("  DEVICE REGISTRATION TIMELINE"));
  console.log(chalk.bold.blue("─".repeat(80)));

  if (analysis.devices.size === 0) {
    console.log(chalk.yellow("  No devices found"));
    return;
  }

  // Group devices by day
  const devicesByDay = new Map<string, string[]>();
  for (const deviceKey of analysis.deviceOrder) {
    const device = analysis.devices.get(deviceKey)!;
    const dayKey = new Date(device.firstSeen).toISOString().substring(0, 10);
    if (!devicesByDay.has(dayKey)) {
      devicesByDay.set(dayKey, []);
    }
    devicesByDay.get(dayKey)!.push(deviceKey);
  }

  const timelineTable = new Table({
    head: [
      chalk.white("Date"),
      chalk.white("New Devices"),
      chalk.white("Device Keys (truncated)"),
    ],
    wordWrap: true,
  });

  const sortedDays = [...devicesByDay.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  for (const [day, devices] of sortedDays) {
    const truncatedKeys = devices
      .map((k) => k.substring(0, 12) + "...")
      .slice(0, 3)
      .join(", ");
    const suffix = devices.length > 3 ? ` +${devices.length - 3} more` : "";

    timelineTable.push([
      day,
      devices.length.toString(),
      truncatedKeys + suffix,
    ]);
  }

  console.log(timelineTable.toString());
}

// ============================================================================
// Main
// ============================================================================

const run = async () => {
  const param = process.argv[2];
  const blocksToFetch = parseInt(process.argv[3] || "500", 10);

  if (!param) {
    console.error(
      chalk.red("Usage: yarn metadata <wallet_address> [blocks_to_fetch]")
    );
    console.error(chalk.gray("  blocks_to_fetch defaults to 500"));
    process.exit(1);
  }

  console.log(
    chalk.cyan(`\nAnalyzing user metadata for ${param} in ${env.ENVIRONMENT}`)
  );
  console.log(chalk.gray(`Fetching last ${blocksToFetch} miniblocks...\n`));

  // Setup
  const config = townsEnv({ env }).makeTownsConfig();
  const spaceDapp = new SpaceDapp(
    config.base.chainConfig,
    new LocalhostWeb3Provider(config.base.rpcUrl)
  );

  let rootWallet: string;
  if (param.startsWith("0x")) {
    const rootKey = await spaceDapp.walletLink.getRootKeyForWallet(param);
    rootWallet = rootKey === INVALID_ADDRESS ? param : rootKey;
  } else {
    rootWallet = getUserIdFromStreamId(param);
  }

  const userMetadataStreamId = makeUserMetadataStreamId(rootWallet);

  console.log(chalk.gray(`Root wallet: ${rootWallet}`));
  console.log(chalk.gray(`User metadata stream ID: ${userMetadataStreamId}`));

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
  const streamId = streamIdAsBytes(userMetadataStreamId);
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
    userMetadataStreamId,
    fromBlock,
    miniblockNum,
    {
      batchSize: 50,
      onProgress: (msg) => console.log(chalk.gray(msg)),
    }
  );

  // Process all miniblocks
  const analysis = createEmptyAnalysis();
  let processedBlocks = 0;

  for (const response of responses) {
    for (const block of response.miniblocks) {
      const unpacked = await unpackMiniblock(block, {
        disableSignatureValidation: true,
        disableHashValidation: true,
      });

      for (const event of unpacked.events) {
        processEvent(event, analysis);
      }
      processedBlocks++;
    }
  }

  console.log(chalk.gray(`\nProcessed ${processedBlocks} miniblocks`));

  // Print analysis
  printOverview(analysis, userMetadataStreamId);
  printEventFrequency(analysis);
  printDeviceTable(analysis);
  printDeviceTimeline(analysis);

  console.log(chalk.gray("\n" + "─".repeat(80)));
  console.log(chalk.green("  Analysis complete"));
  console.log(chalk.gray("─".repeat(80) + "\n"));
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(chalk.red("Error:"), e);
    process.exit(1);
  });
