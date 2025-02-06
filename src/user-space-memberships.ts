import { MembershipOp } from "@river-build/proto";
import {
  isChannelStreamId,
  isSpaceStreamId,
  makeRiverConfig,
  makeStreamRpcClient,
  makeUserInboxStreamId,
  makeUserMetadataStreamId,
  makeUserSettingsStreamId,
  makeUserStreamId,
  streamIdAsBytes,
  StreamStateView,
  unpackStream,
} from "@river-build/sdk";
import {
  INVALID_ADDRESS,
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceAddressFromSpaceId,
  SpaceDapp,
} from "@river-build/web3";

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

  // find the root wallet
  const rootKey = await spaceDapp.walletLink.getRootKeyForWallet(param);
  const rootWallet = rootKey === INVALID_ADDRESS ? param : rootKey;
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
  const streamView = new StreamStateView("0", userStreamId);
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

  for (const streamId of Object.keys(
    streamView.userContent.streamMemberships
  )) {
    if (isSpaceStreamId(streamId)) {
      const address = SpaceAddressFromSpaceId(streamId);
      console.log(address);
    }
  }

  for (const streamId of Object.keys(
    streamView.userContent.streamMemberships
  )) {
    if (isChannelStreamId(streamId)) {
      console.log(streamId);
    }
  }

  const joined = Object.entries(streamView.userContent.streamMemberships)
    .filter(
      (kv) =>
        kv[1].op === MembershipOp.SO_JOIN &&
        (isSpaceStreamId(kv[0]) || isChannelStreamId(kv[0]))
    )
    .map((kv) => kv[0]);

  const responses = [];
  // console.log("User Memberships:");
  // console.log(joined);
  // for (const streamId of joined) {
  //   console.log("================");
  //   console.log(streamId);
  //   try {
  //     //const spaceInfo = await spaceDapp.getSpaceInfo(streamId);
  //     const streamStruct = await riverRegistry.getStream(
  //       streamIdAsBytes(streamId)
  //     );
  //     const node = await riverRegistry.nodeRegistry.read.getNode(
  //       streamStruct.nodes[0]
  //     );
  //     console.log("node:", node.url);
  //     try {
  //       const stream = await riverRpcProvider.getStream({
  //         streamId: streamIdAsBytes(streamId),
  //       });
  //       console.log("success");
  //     } catch (e) {
  //       console.error("failed", node.url);
  //       responses.push({
  //         streamId,
  //         nodeUrl: node.url,
  //         from: rpcUrl,
  //       });
  //     }
  //   } catch (e) {
  //     console.error("failed", streamId);
  //     responses.push({
  //       streamId,
  //       nodeUrl: "failed to lookup",
  //       from: rpcUrl,
  //     });
  //   }
  // }
  // console.log(responses);

  for (const streamId of [
    userSettingsStreamId,
    userInboxStreamId,
    userMetadataStreamId,
  ]) {
    console.log("================");
    console.log(streamId);
    try {
      const stream = await riverRpcProvider.getStream({
        streamId: streamIdAsBytes(streamId),
      });
      console.log("success");
    } catch (e) {
      console.error("failed", streamId);
    }
  }
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });
