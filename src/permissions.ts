import {
  isChannelStreamId,
  isSpaceStreamId,
  makeRiverConfig,
  makeStreamRpcClient,
  streamIdAsBytes,
  StreamStateView,
  unpackStream,
} from "@river-build/sdk";
import {
  LocalhostWeb3Provider,
  Permission,
  RiverRegistry,
  SpaceDapp,
} from "@river-build/web3";

const run = async () => {
  const env = process.env.ENV ?? "omega";
  // Get the wallet address from the command line arguments
  const param = process.argv[2];
  if (!param) {
    console.error("no stream id provided");
    process.exit(1);
  }
  if (!(isSpaceStreamId(param) || isChannelStreamId(param))) {
    console.error("stream id is not a valid channel or space stream id");
    process.exit(1);
  }
  const param2 = process.argv[3];
  if (!param2) {
    console.error("no permission id provided");
    process.exit(1);
  }
  console.log(`Running permissions for ${param} in ${env}`);

  // make the config
  const config = makeRiverConfig(env);

  // make a space dapp
  const spaceDapp = new SpaceDapp(
    config.base.chainConfig,
    new LocalhostWeb3Provider(config.base.rpcUrl)
  );

  if (isSpaceStreamId(param)) {
    const space = await spaceDapp.getSpace(param);
    const isEntitledRead = await spaceDapp.isEntitledToSpace(
      param,
      param2,
      Permission.Read
    );

    const wallets = await spaceDapp.getWalletLink().getLinkedWallets(param2);

    const isMember: { address: string; isMember?: boolean }[] = wallets.map(
      (x) => ({ address: x, isMember: undefined })
    );
    for (const x of isMember) {
      x.isMember = await spaceDapp.hasSpaceMembership(param, x.address);
    }

    console.log(
      `isEntitled:`,
      JSON.stringify({ isEntitledRead, isMember }, undefined, 2)
    );
  } else {
    console.log("channel?");
  }

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
  //const rpcUrl = node.url;
  //const riverRpcProvider = makeStreamRpcClient(rpcUrl);
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });
