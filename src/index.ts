import { MembershipOp } from "@river-build/proto";
import {
  isSpaceStreamId,
  makeRiverConfig,
  makeStreamRpcClient,
  makeUserStreamId,
  streamIdAsBytes,
  StreamStateView,
  unpackStream,
} from "@river-build/sdk";
import {
  createRiverRegistry,
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceAddressFromSpaceId,
  SpaceDapp,
} from "@river-build/web3";

const run = async () => {
  // Get the wallet address from the command line arguments
  const param = process.argv[2];
  if (!param) {
    console.error("No wallet address provided");
    process.exit(1);
  }
  console.log(`Running user-space-membership-fetcher for ${param}`);

  // make the config
  const config = makeRiverConfig("omega");

  // make a space dapp
  const spaceDapp = new SpaceDapp(
    config.base.chainConfig,
    new LocalhostWeb3Provider(config.base.rpcUrl)
  );

  // find the root wallet
  const rootWallet = await spaceDapp.walletLink.getRootKeyForWallet(param);
  console.log(`Root wallet address: ${rootWallet}`);

  // Make the user stream ID
  const userStreamId = makeUserStreamId(rootWallet);
  console.log(`User stream ID: ${userStreamId}`);

  // make a river provider
  const riverRegistry = new RiverRegistry(
    config.river.chainConfig,
    new LocalhostWeb3Provider(config.river.rpcUrl)
  );
  const urlsStr = await riverRegistry.getOperationalNodeUrls();
  const urls = urlsStr.split(",");
  const rpcUrl = urls[Math.floor(Math.random() * urls.length)];
  const riverRpcProvider = makeStreamRpcClient(rpcUrl);

  // fetch the user stream
  const response = await riverRpcProvider.getStream({
    streamId: streamIdAsBytes(userStreamId),
  });

  const unpackedResponse = await unpackStream(response.stream);
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

  const joined = Object.entries(streamView.userContent.streamMemberships)
    .filter((kv) => kv[1].op === MembershipOp.SO_JOIN && isSpaceStreamId(kv[0]))
    .map((kv) => SpaceAddressFromSpaceId(kv[0]));

  console.log("User Memberships:");
  console.log(joined);
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });
