import { toBinary, toJsonString } from "@bufbuild/protobuf";
import {
  GetStreamResponseSchema,
  Snapshot,
  SnapshotSchema,
  StreamAndCookie,
  StreamAndCookieSchema,
  StreamEventSchema,
} from "@towns-protocol/proto";
import {
  makeRiverConfig,
  makeStreamRpcClient,
  makeUserInboxStreamId,
  makeUserMetadataStreamId,
  streamIdAsBytes,
  StreamStateView,
  unpackStream,
} from "@towns-protocol/sdk";
import {
  LocalhostWeb3Provider,
  Permission,
  RiverRegistry,
  SpaceAddressFromSpaceId,
  SpaceDapp,
  SpaceIdFromSpaceAddress,
} from "@towns-protocol/web3";
import { join } from "path";

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

  console.log(`Running space-info for ${spaceAddress} ${streamId} in ${env}`);

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
  const spaceInfo = await spaceDapp.getSpaceInfo(streamId);
  console.log("Space:");
  console.log(JSON.stringify(spaceInfo, undefined, 2));
  const tokenUri = await spaceDapp.tokenURI(streamId);
  console.log("Token URI:", tokenUri);
  const memberTokenUri = await spaceDapp.memberTokenURI(streamId, "0");
  console.log("Member Token URI:", memberTokenUri);

  console.log("Space Info:");
  console.log(JSON.stringify(spaceInfo, undefined, 2));

  const channelInfo = await spaceDapp.getChannels(streamId);
  console.log("Channel Info:");
  console.log(JSON.stringify(channelInfo, undefined, 2));

  const roles = await spaceDapp.getRoles(streamId);
  console.log("Roles:");
  console.log(JSON.stringify(roles, undefined, 2));
  for (const role of roles) {
    const roleInfo = await spaceDapp.getRole(streamId, role.roleId);
    console.log("Role Info:", roleInfo);
    const permissions = await spaceDapp.getPermissionsByRoleId(
      streamId,
      role.roleId
    );
    console.log("Permissions for role:", role);
    console.log(JSON.stringify(permissions, undefined, 2));
  }

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

  const members = Array.from(streamView.getMembers().joined.entries()).map(
    ([k, v]) => v.userId
  );
  console.log("member count", members.length);

  console.log("members: ", members);

  // for (const member of members) {
  //   const inboxStreamId = makeUserInboxStreamId(member);
  //   console.log("inbox stream id", inboxStreamId);
  //   const inboxStream = await riverRpcProvider1.getLastMiniblockHash({
  //     streamId: streamIdAsBytes(inboxStreamId),
  //   });
  //   console.log("inbox stream", inboxStream.hash, inboxStream.miniblockNum);
  // }
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });
