import {
  townsEnv,
  makeStreamRpcClient,
  streamIdAsBytes,
  StreamStateView,
  unpackStream,
  userIdFromAddress,
} from "@towns-protocol/sdk";
import { LocalhostWeb3Provider, RiverRegistry } from "@towns-protocol/web3";
import { env } from "./env";
import Table from "cli-table3";
import chalk from "chalk";

// ============================================================================
// Types
// ============================================================================

interface OutstandingSolicitation {
  userId: string;
  deviceKey: string;
  fallbackKey: string;
  isNewDevice: boolean;
  sessionIds: string[];
}

interface SnapshotSolicitation {
  userId: string;
  deviceKey: string;
  fallbackKey: string;
  isNewDevice: boolean;
  sessionIds: string[];
}

interface UserSummary {
  userId: string;
  deviceCount: number;
  totalSessions: number;
  newDevices: number;
}

interface VerificationResult {
  matched: boolean;
  viewCount: number;
  computedCount: number;
  discrepancies: string[];
}

// ============================================================================
// Display Functions
// ============================================================================

function printOverviewSummary(
  solicitations: OutstandingSolicitation[],
  snapshotMiniblockNum: bigint,
  poolEventCount: number,
  solicitationEventsCount: number,
  fulfillmentEventsCount: number
): void {
  console.log(chalk.bold.cyan("\n" + "═".repeat(80)));
  console.log(chalk.bold.cyan("  SOLICITATIONS OVERVIEW"));
  console.log(chalk.bold.cyan("═".repeat(80)));

  // Build user summaries
  const userSummaries = new Map<string, UserSummary>();
  for (const sol of solicitations) {
    const existing = userSummaries.get(sol.userId);
    if (existing) {
      existing.deviceCount++;
      existing.totalSessions += sol.sessionIds.length;
      if (sol.isNewDevice) existing.newDevices++;
    } else {
      userSummaries.set(sol.userId, {
        userId: sol.userId,
        deviceCount: 1,
        totalSessions: sol.sessionIds.length,
        newDevices: sol.isNewDevice ? 1 : 0,
      });
    }
  }

  const uniqueUsers = userSummaries.size;
  const totalDevices = solicitations.length;
  const newDeviceCount = solicitations.filter((s) => s.isNewDevice).length;
  const totalSessions = solicitations.reduce(
    (acc, s) => acc + s.sessionIds.length,
    0
  );

  // Count unique session IDs across all solicitations
  const allSessionIds = new Set<string>();
  for (const sol of solicitations) {
    for (const sessionId of sol.sessionIds) {
      allSessionIds.add(sessionId);
    }
  }
  const uniqueSessions = allSessionIds.size;

  const infoTable = new Table({ wordWrap: true });
  infoTable.push(
    { "Snapshot Miniblock": snapshotMiniblockNum.toString() },
    { "Events in Pool": poolEventCount.toString() },
    { "  - Key Solicitations": solicitationEventsCount.toString() },
    { "  - Key Fulfillments": fulfillmentEventsCount.toString() },
    { "": "" },
    { "Outstanding Solicitations": totalDevices.toString() },
    { "Unique Users": uniqueUsers.toString() },
    { "New Devices": newDeviceCount.toString() },
    { "": "" },
    { "Total Session Requests": totalSessions.toString() },
    { "Unique Sessions": uniqueSessions.toString() },
    {
      "Avg Requests per Session": (totalSessions / uniqueSessions).toFixed(1),
    }
  );
  console.log(infoTable.toString());

  // Top users by session count
  console.log(chalk.bold.yellow("\n  TOP 10 USERS BY SESSION REQUESTS"));
  const sortedUsers = [...userSummaries.values()]
    .sort((a, b) => b.totalSessions - a.totalSessions)
    .slice(0, 10);

  const topTable = new Table({
    head: [
      chalk.white("User"),
      chalk.white("Devices"),
      chalk.white("Sessions"),
      chalk.white("New Devices"),
    ],
    wordWrap: true,
  });

  for (const user of sortedUsers) {
    topTable.push([
      user.userId,
      user.deviceCount.toString(),
      user.totalSessions.toString(),
      user.newDevices > 0 ? chalk.yellow(user.newDevices.toString()) : "0",
    ]);
  }
  console.log(topTable.toString());

  if (uniqueUsers > 10) {
    console.log(chalk.gray(`  ... and ${uniqueUsers - 10} more users`));
  }

  console.log(
    chalk.gray(
      `\n  Use: yarn solicitations <streamId> <userAddress> to see details for a specific user`
    )
  );
}

function printUserDetails(
  solicitations: OutstandingSolicitation[],
  filterUserId: string
): void {
  const userSolicitations = solicitations.filter(
    (s) => s.userId.toLowerCase() === filterUserId.toLowerCase()
  );

  console.log(chalk.bold.cyan("\n" + "═".repeat(80)));
  console.log(chalk.bold.cyan(`  SOLICITATIONS FOR USER: ${filterUserId}`));
  console.log(chalk.bold.cyan("═".repeat(80)));

  if (userSolicitations.length === 0) {
    console.log(chalk.yellow("  No outstanding solicitations for this user"));
    return;
  }

  // Summary
  const totalSessions = userSolicitations.reduce(
    (acc, s) => acc + s.sessionIds.length,
    0
  );
  const newDevices = userSolicitations.filter((s) => s.isNewDevice).length;

  console.log(chalk.gray(`  Devices: ${userSolicitations.length}`));
  console.log(chalk.gray(`  New Devices: ${newDevices}`));
  console.log(chalk.gray(`  Total Session Requests: ${totalSessions}`));

  // Device table
  console.log(chalk.bold.yellow("\n  DEVICES"));

  const deviceTable = new Table({
    head: [
      chalk.white("Device Key"),
      chalk.white("Fallback Key"),
      chalk.white("New"),
      chalk.white("Sessions"),
    ],
    wordWrap: true,
  });

  for (const sol of userSolicitations) {
    deviceTable.push([
      sol.deviceKey,
      sol.fallbackKey,
      sol.isNewDevice ? chalk.yellow("Yes") : "No",
      sol.sessionIds.length.toString(),
    ]);
  }

  console.log(deviceTable.toString());

  // Show sample session IDs (first 5 from first device with sessions)
  const deviceWithSessions = userSolicitations.find(
    (s) => s.sessionIds.length > 0
  );
  if (deviceWithSessions && deviceWithSessions.sessionIds.length > 0) {
    console.log(chalk.gray("\n  Sample Session IDs (first 5):"));
    for (const sessionId of deviceWithSessions.sessionIds.slice(0, 5)) {
      console.log(chalk.gray(`    - ${sessionId}`));
    }
    if (deviceWithSessions.sessionIds.length > 5) {
      console.log(
        chalk.gray(`    ... and ${deviceWithSessions.sessionIds.length - 5} more`)
      );
    }
  }
}

function printSnapshotSolicitations(
  solicitations: SnapshotSolicitation[],
  snapshotMiniblockNum: bigint,
  filterUserId?: string
): void {
  const filtered = filterUserId
    ? solicitations.filter(
        (s) => s.userId.toLowerCase() === filterUserId.toLowerCase()
      )
    : solicitations;

  console.log(chalk.bold.yellow("\n" + "─".repeat(80)));
  console.log(
    chalk.bold.yellow(
      `  SNAPSHOT SOLICITATIONS (miniblock ${snapshotMiniblockNum})${
        filterUserId ? ` for ${filterUserId}` : ""
      }`
    )
  );
  console.log(chalk.bold.yellow("─".repeat(80)));

  if (filtered.length === 0) {
    console.log(chalk.gray("  No solicitations in snapshot"));
    return;
  }

  if (filterUserId) {
    // Show full details for filtered user
    for (const sol of filtered) {
      console.log(chalk.bold.white(`\n  Device Key: ${sol.deviceKey}`));
      console.log(
        chalk.gray(
          `    Is New Device: ${sol.isNewDevice ? chalk.yellow("Yes") : "No"}`
        )
      );
      console.log(chalk.gray(`    Sessions: ${sol.sessionIds.length}`));
    }
  } else {
    // Show summary
    console.log(chalk.gray(`  Total: ${filtered.length} solicitations`));
  }
}

function printPoolEvents(
  solicitationEventsCount: number,
  fulfillmentEventsCount: number,
  filterUserId?: string,
  userSolicitationEvents?: number,
  userFulfillmentEvents?: number
): void {
  console.log(chalk.bold.magenta("\n" + "─".repeat(80)));
  console.log(chalk.bold.magenta("  EVENTS IN POOL (after snapshot)"));
  console.log(chalk.bold.magenta("─".repeat(80)));

  console.log(chalk.gray(`  Total Key Solicitations: ${solicitationEventsCount}`));
  console.log(chalk.gray(`  Total Key Fulfillments: ${fulfillmentEventsCount}`));

  if (filterUserId && userSolicitationEvents !== undefined) {
    console.log(chalk.gray(`\n  For ${filterUserId}:`));
    console.log(chalk.gray(`    Solicitations: ${userSolicitationEvents}`));
    console.log(chalk.gray(`    Fulfillments (targeting user): ${userFulfillmentEvents}`));
  }
}

function printVerification(result: VerificationResult): void {
  console.log(chalk.bold.blue("\n" + "─".repeat(80)));
  console.log(chalk.bold.blue("  VERIFICATION: snapshot + events = view"));
  console.log(chalk.bold.blue("─".repeat(80)));

  if (result.matched) {
    console.log(
      chalk.green("  ✓ VERIFIED: Computed state matches StreamStateView")
    );
    console.log(
      chalk.gray(
        `    View count: ${result.viewCount} | Computed: ${result.computedCount}`
      )
    );
  } else {
    console.log(
      chalk.red("  ✗ MISMATCH: Computed state differs from StreamStateView")
    );
    console.log(
      chalk.gray(
        `    View count: ${result.viewCount} | Computed: ${result.computedCount}`
      )
    );
    if (result.discrepancies.length > 0) {
      console.log(chalk.yellow("\n  Discrepancies:"));
      for (const d of result.discrepancies.slice(0, 10)) {
        console.log(chalk.yellow(`    - ${d}`));
      }
      if (result.discrepancies.length > 10) {
        console.log(
          chalk.gray(`    ... and ${result.discrepancies.length - 10} more`)
        );
      }
    }
  }
}

// ============================================================================
// Main
// ============================================================================

const run = async () => {
  const streamIdParam = process.argv[2];
  const userFilterParam = process.argv[3]?.toLowerCase();

  if (!streamIdParam) {
    console.error(chalk.red("Usage: yarn solicitations <streamId> [userAddress]"));
    console.error(chalk.gray("  streamId: The stream to analyze"));
    console.error(
      chalk.gray("  userAddress: Optional - show details for specific user only")
    );
    process.exit(1);
  }

  console.log(
    chalk.cyan(
      `\nAnalyzing solicitations for stream ${streamIdParam}`
    )
  );
  if (userFilterParam) {
    console.log(chalk.cyan(`Filtering for user: ${userFilterParam}`));
  }

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

  // Fetch the stream
  console.log(chalk.gray(`Fetching stream...`));
  const streamId = streamIdAsBytes(streamIdParam);
  const response = await riverRpcProvider.getStream({ streamId });

  // Unpack and create StreamStateView
  const unpackedResponse = await unpackStream(response.stream, undefined);
  const streamView = new StreamStateView("0", streamIdParam, undefined);
  streamView.initialize(
    unpackedResponse.streamAndCookie.nextSyncCookie,
    unpackedResponse.streamAndCookie.events,
    unpackedResponse.snapshot,
    unpackedResponse.streamAndCookie.miniblocks,
    [],
    unpackedResponse.prevSnapshotMiniblockNum,
    undefined,
    [],
    undefined
  );

  const snapshotMiniblockNum = unpackedResponse.prevSnapshotMiniblockNum;
  const poolEventCount = unpackedResponse.streamAndCookie.events.length;

  // ============================================================================
  // 1. Extract outstanding solicitations from StreamStateView
  // ============================================================================
  const outstandingSolicitations: OutstandingSolicitation[] = [];
  const members = streamView.getMembers();

  for (const [userId, member] of members.joined) {
    if (member.solicitations && member.solicitations.length > 0) {
      for (const sol of member.solicitations) {
        outstandingSolicitations.push({
          userId,
          deviceKey: sol.deviceKey,
          fallbackKey: sol.fallbackKey,
          isNewDevice: sol.isNewDevice,
          sessionIds: [...sol.sessionIds],
        });
      }
    }
  }

  // ============================================================================
  // 2. Extract solicitations from snapshot for verification
  // ============================================================================
  const snapshotSolicitations: SnapshotSolicitation[] = [];
  const snapshot = unpackedResponse.snapshot;

  if (snapshot?.members?.joined) {
    for (const member of snapshot.members.joined) {
      const userId = userIdFromAddress(member.userAddress);
      if (member.solicitations && member.solicitations.length > 0) {
        for (const sol of member.solicitations) {
          snapshotSolicitations.push({
            userId,
            deviceKey: sol.deviceKey,
            fallbackKey: sol.fallbackKey,
            isNewDevice: sol.isNewDevice,
            sessionIds: [...sol.sessionIds],
          });
        }
      }
    }
  }

  // ============================================================================
  // 3. Process events from pool to compute expected state
  // ============================================================================
  const computedState = new Map<
    string,
    {
      userId: string;
      deviceKey: string;
      fallbackKey: string;
      isNewDevice: boolean;
      sessionIds: Set<string>;
    }
  >();

  // Initialize with snapshot solicitations
  for (const sol of snapshotSolicitations) {
    const key = `${sol.userId}:${sol.deviceKey}`;
    computedState.set(key, {
      userId: sol.userId,
      deviceKey: sol.deviceKey,
      fallbackKey: sol.fallbackKey,
      isNewDevice: sol.isNewDevice,
      sessionIds: new Set(sol.sessionIds),
    });
  }

  // Process events from the pool
  let solicitationEventsCount = 0;
  let fulfillmentEventsCount = 0;
  let userSolicitationEvents = 0;
  let userFulfillmentEvents = 0;

  for (const parsedEvent of unpackedResponse.streamAndCookie.events) {
    const payload = parsedEvent.event.payload;
    if (payload?.case !== "memberPayload") continue;

    const content = payload.value.content;
    if (!content) continue;

    const creatorUserId = parsedEvent.creatorUserId;

    if (content.case === "keySolicitation") {
      solicitationEventsCount++;
      const sol = content.value;
      const key = `${creatorUserId}:${sol.deviceKey}`;

      if (userFilterParam && creatorUserId.toLowerCase() === userFilterParam) {
        userSolicitationEvents++;
      }

      // New solicitation replaces old
      computedState.set(key, {
        userId: creatorUserId,
        deviceKey: sol.deviceKey,
        fallbackKey: sol.fallbackKey,
        isNewDevice: sol.isNewDevice,
        sessionIds: new Set(sol.sessionIds),
      });
    } else if (content.case === "keyFulfillment") {
      fulfillmentEventsCount++;
      const ful = content.value;
      const targetUserId = userIdFromAddress(ful.userAddress);
      const key = `${targetUserId}:${ful.deviceKey}`;

      if (userFilterParam && targetUserId.toLowerCase() === userFilterParam) {
        userFulfillmentEvents++;
      }

      const existing = computedState.get(key);
      if (existing) {
        for (const sessionId of ful.sessionIds) {
          existing.sessionIds.delete(sessionId);
        }
        existing.isNewDevice = false;

        if (existing.sessionIds.size === 0 && !existing.isNewDevice) {
          computedState.delete(key);
        }
      }
    }
  }

  // ============================================================================
  // 4. Display results
  // ============================================================================
  if (userFilterParam) {
    // Filtered view for specific user
    printUserDetails(outstandingSolicitations, userFilterParam);
    printSnapshotSolicitations(
      snapshotSolicitations,
      snapshotMiniblockNum,
      userFilterParam
    );
    printPoolEvents(
      solicitationEventsCount,
      fulfillmentEventsCount,
      userFilterParam,
      userSolicitationEvents,
      userFulfillmentEvents
    );
  } else {
    // Summary view
    printOverviewSummary(
      outstandingSolicitations,
      snapshotMiniblockNum,
      poolEventCount,
      solicitationEventsCount,
      fulfillmentEventsCount
    );
  }

  // ============================================================================
  // 5. Verify: computed state should match StreamStateView
  // ============================================================================
  const discrepancies: string[] = [];

  const viewState = new Map<string, OutstandingSolicitation>();
  for (const sol of outstandingSolicitations) {
    const key = `${sol.userId}:${sol.deviceKey}`;
    viewState.set(key, sol);
  }

  for (const [key, computed] of computedState) {
    const viewSol = viewState.get(key);
    if (!viewSol) {
      discrepancies.push(
        `Computed has ${key} but view does not (sessions: ${computed.sessionIds.size})`
      );
      continue;
    }

    const computedSessions = [...computed.sessionIds].sort();
    const viewSessions = [...viewSol.sessionIds].sort();

    if (computedSessions.length !== viewSessions.length) {
      discrepancies.push(
        `${key}: session count mismatch (computed: ${computedSessions.length}, view: ${viewSessions.length})`
      );
    } else {
      for (let i = 0; i < computedSessions.length; i++) {
        if (computedSessions[i] !== viewSessions[i]) {
          discrepancies.push(`${key}: session ID mismatch at index ${i}`);
          break;
        }
      }
    }

    if (computed.isNewDevice !== viewSol.isNewDevice) {
      discrepancies.push(
        `${key}: isNewDevice mismatch (computed: ${computed.isNewDevice}, view: ${viewSol.isNewDevice})`
      );
    }
  }

  for (const [key, viewSol] of viewState) {
    if (!computedState.has(key)) {
      discrepancies.push(
        `View has ${key} but computed does not (sessions: ${viewSol.sessionIds.length})`
      );
    }
  }

  const result: VerificationResult = {
    matched: discrepancies.length === 0,
    viewCount: outstandingSolicitations.length,
    computedCount: computedState.size,
    discrepancies,
  };

  printVerification(result);

  // Final summary
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
