import {
  makeRiverConfig,
  makeStreamRpcClient,
  streamIdAsBytes,
  StreamStateView,
  unpackStream,
} from "@towns-protocol/sdk";
import {
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceAddressFromSpaceId,
  SpaceDapp,
  SpaceIdFromSpaceAddress,
  SpaceOwner,
} from "@towns-protocol/web3";

const run = async () => {
  const env = process.env.ENV ?? "omega";
  // Get the wallet address from the command line arguments
  const param2 = process.argv[2];
  if (!param2) {
    console.error("no token provided");
    process.exit(1);
  }

  // make the config
  const config = makeRiverConfig(env);

  // make a space dapp
  const spaceDapp = new SpaceDapp(
    config.base.chainConfig,
    new LocalhostWeb3Provider(config.base.rpcUrl)
  );

  const spaceOwner = new SpaceOwner(
    config.base.chainConfig.addresses.spaceOwner,
    new LocalhostWeb3Provider(config.base.rpcUrl)
  );

  const uri = await spaceOwner.read.tokenURI(param2);
  console.log("Token URI:", uri);

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
