import { toBinary, toJsonString } from "@bufbuild/protobuf";
import {
  GetStreamResponseSchema,
  Snapshot,
  SnapshotSchema,
  StreamAndCookie,
  StreamAndCookieSchema,
  StreamEventSchema,
} from "@river-build/proto";
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
  SpaceAddressFromSpaceId,
  SpaceDapp,
  SpaceIdFromSpaceAddress,
} from "@river-build/web3";

const run = async () => {
  const env = process.env.ENV ?? "omega";
  // Get the wallet address from the command line arguments
  const param2 = process.argv[2];
  if (!param2) {
    console.error("no stream id provided");
    process.exit(1);
  }

  const spaceAddress = param2.startsWith("0x")
    ? param2
    : SpaceAddressFromSpaceId(param2);
  const streamId = param2.startsWith("0x")
    ? SpaceIdFromSpaceAddress(param2)
    : param2;

  console.log(`Running stream-info for ${spaceAddress} ${streamId} in ${env}`);

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

  const space = await spaceDapp.getSpace(streamId);
  if (!space) {
    console.error("space not found");
    return;
  }
  const spaceInfo = await space.getSpaceInfo();
  console.log("Space:");
  console.log(JSON.stringify(spaceInfo, undefined, 2));
  const tokenUri = await spaceDapp.tokenURI(streamId);
  console.log("Token URI:", tokenUri);
  const memberTokenUri = await spaceDapp.memberTokenURI(streamId, "0");
  console.log("Member Token URI:", memberTokenUri);

  const info = await spaceDapp.getSpaceInfo(streamId);
  console.log("Space Info:");
  console.log(JSON.stringify(info, undefined, 2));

  // find nodes for the stream
  const streamStruct = await riverRegistry.getStream(streamIdAsBytes(streamId));
  console.log("Nodes:");
  console.log(JSON.stringify(streamStruct, undefined, 2));
  console.log("Node:");
  const node = await riverRegistry.nodeRegistry.read.getNode(
    streamStruct.nodes[0]
  );
  console.log(JSON.stringify(node, undefined, 2));

  const rpcUrl = node.url;
  const riverRpcProvider1 = makeStreamRpcClient(rpcUrl);

  // fetch the user stream
  const response = await riverRpcProvider1.getStream({
    streamId: streamIdAsBytes(streamId),
  });

  // print size of the response
  const byteLength = toBinary(GetStreamResponseSchema, response).byteLength;
  // print size in mb
  const mb = byteLength / 1024 / 1024;
  console.log("Response size:", mb.toFixed(2), "MB");

  const unpackedResponse = await unpackStream(response.stream, undefined);
  const streamView = new StreamStateView("0", streamId);
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

  console.log("Stream Info:");
  console.log(unpackedResponse.snapshot);

  const spaceImage = await streamView.spaceContent.getSpaceImage();
  console.log("space image", spaceImage);
  // console.log(
  //   unpackedResponse.streamAndCookie.miniblocks.map((m) =>
  //     m.events
  //       .filter((e) => e.event.payload.case !== "miniblockHeader")
  //       .map((e) =>
  //         toJsonString(StreamEventSchema, e.event, { prettySpaces: 2 })
  //       )
  //   )
  // );
  // console.log(
  //   "initial snapshot (without later events)",
  //   toJsonString(SnapshotSchema, unpackedResponse.snapshot, { prettySpaces: 2 })
  // );
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });
