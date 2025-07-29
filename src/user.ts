import { bin_fromBase64, bin_toHexString } from "@towns-protocol/dlog";
import { MembershipOp } from "@towns-protocol/proto";
import {
  getUserIdFromStreamId,
  isChannelStreamId,
  isSpaceStreamId,
  makeRiverConfig,
  makeStreamRpcClient,
  makeUserInboxStreamId,
  makeUserMetadataStreamId,
  makeUserSettingsStreamId,
  makeUserStreamId,
  streamIdAsBytes,
  StreamRpcClient,
  StreamStateView,
  unpackStream,
  userIdFromAddress,
} from "@towns-protocol/sdk";
import {
  INVALID_ADDRESS,
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceAddressFromSpaceId,
  SpaceDapp,
} from "@towns-protocol/web3";
import { printStreamResponseEvents } from "./stream";

const bListSpaceNames = false;

const run = async () => {
  const env = process.env.ENV ?? "omega";
  // Get the wallet address from the command line arguments
  const param = process.argv[2];
  if (!param) {
    console.error("No wallet address provided");
    process.exit(1);
  }
  console.log(`Running user-space-membership-fetcher for ${param} in ${env}`);

  // make the config
  const config = makeRiverConfig(env);

  // make a space dapp
  const spaceDapp = new SpaceDapp(
    config.base.chainConfig,
    new LocalhostWeb3Provider(config.base.rpcUrl)
  );

  let walletAddress = param;

  if (!walletAddress.startsWith("0x")) {
    if (
      walletAddress.startsWith("a8") ||
      walletAddress.startsWith("a1") ||
      walletAddress.startsWith("a5") ||
      walletAddress.startsWith("ad")
    ) {
      walletAddress = getUserIdFromStreamId(walletAddress);
    } else {
      try {
        const binaddr = bin_fromBase64(param);
        walletAddress = userIdFromAddress(binaddr);
      } catch (e) {
        console.error("Wallet address must start with 0x");
        process.exit(1);
      }
    }
  }

  console.log(`Using wallet address: ${walletAddress}`);

  // find the root wallet
  const rootKey = await spaceDapp.walletLink.getRootKeyForWallet(walletAddress);
  const rootWallet = rootKey === INVALID_ADDRESS ? walletAddress : rootKey;
  console.log(`Root wallet address: ${rootWallet}`);

  const linkedWallets = await spaceDapp.walletLink.getLinkedWallets(rootWallet);
  console.log("Linked wallets:", linkedWallets);

  // Make the user stream ID
  const userStreamId = makeUserStreamId(rootWallet);
  const userSettingsStreamId = makeUserSettingsStreamId(rootWallet);
  const userInboxStreamId = makeUserInboxStreamId(rootWallet);
  const userMetadataStreamId = makeUserMetadataStreamId(rootWallet);

  console.log(`User stream ID: ${userStreamId}`);

  // make a river provider
  const riverRegistry = new RiverRegistry(
    config.river.chainConfig,
    new LocalhostWeb3Provider(config.river.rpcUrl)
  );
  const urlsStr = await riverRegistry.getOperationalNodeUrls();
  const urls = urlsStr.split(",");
  const rpcUrl = urls[Math.floor(Math.random() * urls.length)];
  console.log(`Using RPC URL: ${rpcUrl}`);
  const riverRpcProvider = makeStreamRpcClient(rpcUrl);

  // fetch the user stream
  const response = await riverRpcProvider.getStream({
    streamId: streamIdAsBytes(userStreamId),
  });

  const unpackedResponse = await unpackStream(response.stream, undefined);
  const streamView = new StreamStateView("0", userStreamId, undefined);
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

  const joined = Object.entries(streamView.userContent.streamMemberships)
    .filter(
      (kv) =>
        kv[1]?.op === MembershipOp.SO_JOIN &&
        (isSpaceStreamId(kv[0]) || isChannelStreamId(kv[0]))
    )
    .map((kv) => kv[0]);

  console.log("number of spaces", joined.filter(isSpaceStreamId).length);
  console.log("number of channels", joined.filter(isChannelStreamId).length);
  console.log("number of joined", joined.length);

  for (const streamId of joined.filter(isSpaceStreamId)) {
    const address = SpaceAddressFromSpaceId(streamId);
    if (bListSpaceNames) {
      const spaceInfo = await spaceDapp.getSpaceInfo(streamId);
      if (spaceInfo) {
        console.log(address, spaceInfo.name);
      } else {
        console.log(address);
      }
    } else {
      console.log(address);
    }
  }

  // for (const streamId of Object.keys(
  //   streamView.userContent.streamMemberships
  // )) {
  //   if (isChannelStreamId(streamId)) {
  //     console.log(streamId);
  //   }
  // }

  console.log("User Memberships:");
  console.log(joined);
  // for (const streamId of joined) {
  //   await loadStream(streamId, riverRegistry, riverRpcProvider);
  // }

  for (const [name, streamId] of [
    ["user", userStreamId],
    ["settings", userSettingsStreamId],
    ["inbox", userInboxStreamId],
    ["metadata", userMetadataStreamId],
  ]) {
    console.log("================");
    console.log(streamId, name);
    try {
      const streamStruct = await riverRegistry.getStream(
        streamIdAsBytes(streamId)
      );
      const nodes = await Promise.all(
        streamStruct.nodes.map((x) =>
          riverRegistry.nodeRegistry.read.getNode(x)
        )
      );
      for (const node of nodes) {
        console.log(node.url);
      }
      const response = await riverRpcProvider.getStream({
        streamId: streamIdAsBytes(streamId),
      });
      const unpackedResponse = await unpackStream(response.stream, undefined);
      console.log("pool size", unpackedResponse.streamAndCookie.events.length);
      console.log("success");
      const streamView = new StreamStateView("0", streamId, undefined);
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
      if (streamId === userStreamId) {
        console.log(
          "received/sent",
          streamView.userContent.tipsReceived,
          streamView.userContent.tipsReceivedCount,
          streamView.userContent.tipsSent,
          streamView.userContent.tipsSentCount
        );
        printStreamResponseEvents(unpackedResponse, {
          noEvents: true,
          noMiniblockHeaders: true,
        });
      }
    } catch (e) {
      console.error("failed", streamId, e);
    }
  }
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });

async function loadStream(
  streamId: string,
  riverRegistry: RiverRegistry,
  riverRpcProvider: StreamRpcClient
) {
  console.log("================");
  console.log(streamId);
  try {
    //const spaceInfo = await spaceDapp.getSpaceInfo(streamId);
    const streamStruct = await riverRegistry.getStream(
      streamIdAsBytes(streamId)
    );
    const node = await riverRegistry.nodeRegistry.read.getNode(
      streamStruct.nodes[0]
    );
    console.log("node:", node.url);
    try {
      const response = await riverRpcProvider.getStream({
        streamId: streamIdAsBytes(streamId),
      });
      const unpackedResponse = await unpackStream(response.stream, undefined);
      const streamView = new StreamStateView("0", streamId, undefined);
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

      console.log("success");
    } catch (e) {
      console.error("failed", node.url);
    }
  } catch (e) {
    console.error("failed", streamId, e);
  }
}
