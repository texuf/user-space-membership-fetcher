import {
  makeRiverConfig,
  makeStreamRpcClient,
  streamIdAsBytes,
  StreamStateView,
  unpackStream,
} from "@river-build/sdk";
import {
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceDapp,
} from "@river-build/web3";

const run = async () => {
  // Get the wallet address from the command line arguments
  const param = process.argv[2];
  if (!param) {
    console.error("no stream id provided");
    process.exit(1);
  }
  const env = "gamma";
  console.log(`Running stream-info for ${param} in ${env}`);

  // make the config
  const config = makeRiverConfig(env);

  // make a space dapp
  const spaceDapp = new SpaceDapp(
    config.base.chainConfig,
    new LocalhostWeb3Provider(config.base.rpcUrl)
  );

  // make a river provider
  const riverRegistry = new RiverRegistry(
    config.river.chainConfig,
    new LocalhostWeb3Provider(config.river.rpcUrl)
  );

  // find nodes for the stream
  const streamStruct = await riverRegistry.getStream(streamIdAsBytes(param));

  console.log("Stream:");
  console.log(JSON.stringify(streamStruct, undefined, 2));
  console.log("Node:");
  const node = await riverRegistry.nodeRegistry.read.getNode(
    streamStruct.nodes[0]
  );
  console.log(JSON.stringify(node, undefined, 2));

  //const urlsStr = await riverRegistry.getOperationalNodeUrls();
  //const urls = urlsStr.split(",");
  const rpcUrl = node.url;
  const riverRpcProvider = makeStreamRpcClient(rpcUrl);

  // fetch the user stream
  const response = await riverRpcProvider.getStream({
    streamId: streamIdAsBytes(param),
  });

  const unpackedResponse = await unpackStream(response.stream);
  const streamView = new StreamStateView("0", param);
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

  console.log("member count", streamView.getMembers().joined.size);

  // console.log("Stream Info:");
  // console.log(unpackedResponse);
  // console.log(
  //   unpackedResponse.streamAndCookie.miniblocks.map((m) =>
  //     m.events.map((e) => e.event.toJsonString({ prettySpaces: 2 }))
  //   )
  // );
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });
