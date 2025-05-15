import { fromBinary, toBinary, toJson, toJsonString } from "@bufbuild/protobuf";
import fs from "fs";
import {
  GetStreamResponse,
  GetStreamResponseSchema,
  SnapshotSchema,
  StreamEvent,
  StreamEventSchema,
  UserPayload,
} from "@towns-protocol/proto";
import {
  getFallbackContent,
  getMiniblocks,
  isChannelStreamId,
  isPersistedEvent,
  makeRemoteTimelineEvent,
  makeRiverConfig,
  makeStreamRpcClient,
  spaceIdFromChannelId,
  streamIdAsBytes,
  StreamStateView,
  toEventSA,
  unpackStream,
  userIdFromAddress,
} from "@towns-protocol/sdk";
import {
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceAddressFromSpaceId,
  SpaceDapp,
} from "@towns-protocol/web3";
import { utils } from "ethers";
import { bin_toHexString } from "@towns-protocol/dlog";

const printMembers = false;
const printMiniblockHeaders = true;
const historicalBlocks = 100;

const bytesToMB = (bytes: number): number => {
  return bytes / 1024 / 1024;
};

const run = async () => {
  const env = process.env.ENV ?? "omega";
  const loadFileName = process.env.FILENAME ?? undefined;
  let response: GetStreamResponse;
  let param: string;

  if (loadFileName) {
    const file = fs.readFileSync(loadFileName);
    console.log("file size", file.length);
    response = fromBinary(GetStreamResponseSchema, file);
    console.log("file", file);
    param = loadFileName.split("/")[1]?.split("-").at(0) ?? "";
  } else {
    const nodeIndex = process.env.NODE_INDEX
      ? parseInt(process.env.NODE_INDEX)
      : 0;
    // Get the wallet address from the command line arguments
    param = process.argv[2];
    if (!param) {
      console.error("no stream id provided");
      process.exit(1);
    }
    console.log(`Running stream-info for ${param} in ${env}`);

    // make the config
    const config = makeRiverConfig(env);

    console.log(`Base rpc url: ${config.base.rpcUrl}`);
    console.log(`River rpc url: ${config.river.rpcUrl}`);

    // make a river provider
    const riverRegistry = new RiverRegistry(
      config.river.chainConfig,
      new LocalhostWeb3Provider(config.river.rpcUrl)
    );

    // find nodes for the stream
    const streamStruct = await riverRegistry.getStream(streamIdAsBytes(param));

    console.log("Stream:");
    console.log(JSON.stringify(streamStruct, undefined, 2));
    console.log("Nodes:");
    const nodes = await Promise.all(
      streamStruct.nodes.map((x) => riverRegistry.nodeRegistry.read.getNode(x))
    );
    console.log(JSON.stringify(nodes, undefined, 2));
    const node = nodes[nodeIndex];

    const rpcUrl = node.url;
    console.log("Connecting to URL:", rpcUrl);
    const riverRpcProvider = makeStreamRpcClient(rpcUrl, undefined, {
      retryParams: {
        maxAttempts: 3,
        initialRetryDelay: 2000,
        maxRetryDelay: 6000,
        defaultTimeoutMs: 120000, // 30 seconds for long running requests
      },
    });

    // fetch the user stream
    response = await riverRpcProvider.getStream(
      {
        streamId: streamIdAsBytes(param),
      },
      { timeoutMs: 120000 }
    );

    const binStreamResponse = toBinary(GetStreamResponseSchema, response);
    const byteLength = binStreamResponse.byteLength;
    // print size in mb
    const mb = bytesToMB(byteLength);
    console.log("Response size:", mb.toFixed(2), "MB");

    // save to file
    const filename = `temp/${param}-stream-${new Date()
      .toISOString()
      .replace(/:/g, "-")
      .replace("T", "-")
      .replace(".", "-")
      .replace("/", "-")}.bin`;
    fs.writeFileSync(filename, binStreamResponse);
    console.log(`Saved stream response to ${filename}`);
  }
  if (!response) {
    throw new Error("No response");
  }
  if (response.stream) {
    const headerSizes = response.stream.miniblocks.map((m) => {
      return m.header?.event.byteLength ?? 0;
    });
    console.log("header sizes", headerSizes); // Note: This is still in bytes
    const headerSize = response.stream.miniblocks.reduce((acc, curr) => {
      return acc + (curr.header?.event.byteLength ?? 0);
    }, 0);
    console.log("header size", bytesToMB(headerSize).toFixed(2), "MB");
    const eventSize = response.stream.miniblocks.reduce((acc, curr) => {
      return (
        acc +
        curr.events.reduce((acc, curr) => {
          return acc + (curr.event.byteLength ?? 0);
        }, 0)
      );
    }, 0);
    console.log("event size", bytesToMB(eventSize).toFixed(2), "MB");
    const minipoolSize = response.stream.events.reduce((acc, curr) => {
      return acc + (curr.event.byteLength ?? 0);
    }, 0);
    console.log("minipool size", bytesToMB(minipoolSize).toFixed(2), "MB");
    if (response.stream.snapshot) {
      console.log(
        "snapshot size",
        bytesToMB(response.stream.snapshot.event.byteLength).toFixed(2),
        "MB"
      );
    }
  }

  const unpackedResponse = await unpackStream(response.stream, undefined);

  console.log("snapshot", toJson(SnapshotSchema, unpackedResponse.snapshot));

  if (printMembers) {
    const members = unpackedResponse.snapshot?.members?.joined ?? [];
    for (const member of members) {
      console.log(`member ${userIdFromAddress(member.userAddress)}`, member);
    }
  }

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

  const solicitations = streamView
    .getMembers()
    .joined.get("0xebb21B382752d5E603C0e87B7Af9e0c412EFbce6");
  console.log("ha", solicitations);

  // for (const event of streamView.timeline) {
  //   console.log(
  //     "last event",
  //     event.remoteEvent?.event.toJsonString({ prettySpaces: 2 })
  //   );
  // }
  console.log("member count", streamView.getMembers().joined.size);
  // console.log(
  //   "members: ",
  //   Array.from(streamView.getMembers().joined.entries()).map(
  //     ([k, v]) => v.userId
  //   )
  // );
  console.log("pool size", unpackedResponse.streamAndCookie.events.length);
  console.log(
    "currentBlock",
    unpackedResponse.streamAndCookie.nextSyncCookie.minipoolGen
  );
  console.log(
    "events returned",
    unpackedResponse.streamAndCookie.miniblocks.flatMap((x) => x.events).length
  );

  if (isChannelStreamId(param)) {
    const spaceId = spaceIdFromChannelId(param);
    console.log("spaceId", spaceId);
    console.log("space address", SpaceAddressFromSpaceId(spaceId));
  }

  if (historicalBlocks > 0) {
    const toExclusive =
      unpackedResponse.streamAndCookie.miniblocks[0].header.miniblockNum;
    const fromInclusive = toExclusive - BigInt(historicalBlocks);
    const blocks = getMiniblocks(
      riverRpcProvider,
      param,
      fromInclusive,
      toExclusive,
      true,
      {}
    );
  }

  console.log("======== Stream events =========");
  for (const mb of unpackedResponse.streamAndCookie.miniblocks) {
    //const header = mb.header?.miniblockNum;
    //console.log("miniblock", header);
    for (const event of mb.events) {
      const streamEvent = event.event;
      printStreamEventDetails(event, streamEvent);
    }
  }

  if (unpackedResponse.streamAndCookie.events.length > 0) {
    console.log("======== Minipool events =========");
    for (const event of unpackedResponse.streamAndCookie.events) {
      printStreamEventDetails(event, event.event);
    }
  }
};

function printStreamEventDetails(
  parsedEventData: any, // Consider defining a more specific type if available
  streamEvent: StreamEvent
) {
  if (
    streamEvent.payload.case === "miniblockHeader" &&
    !printMiniblockHeaders
  ) {
    return; // Use return instead of continue
  }
  const userId = userIdFromAddress(streamEvent.creatorAddress);
  // timestamp in readable format
  const timestamp = new Date(
    Number(streamEvent.createdAtEpochMs)
  ).toISOString();
  const content = toEventSA(
    makeRemoteTimelineEvent({
      parsedEvent: parsedEventData,
      eventNum: 0n,
      miniblockNum: 0n,
    }),
    userId
  ).content;
  const fallbackContent = content
    ? getFallbackContent(userId, content)
    : "undefined";
  console.log(
    "event",
    userId,
    timestamp,
    streamEvent.payload.case,
    streamEvent.payload.value?.content.case,
    fallbackContent
  );
  specialPrint(streamEvent);
}

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });

function specialPrint(event: StreamEvent) {
  switch (event.payload.case) {
    case "miniblockHeader":
      console.log(
        "miniblockHeader",
        event.payload.value?.miniblockNum,
        `events: ${event.payload.value?.eventHashes.length}`
      );
      break;
    case "userPayload":
      {
        const payload: UserPayload = event.payload.value;
        switch (payload.content.case) {
          case "receivedBlockchainTransaction":
            {
              const transactionContent =
                payload.content.value.transaction?.content;
              switch (transactionContent?.case) {
                case "tip":
                  {
                    const event = transactionContent.value.event;
                    if (!event) {
                      console.log("nil event");
                      return;
                    }
                    const currency = utils.getAddress(
                      bin_toHexString(event.currency)
                    );

                    console.log("tip", event.amount, "currency", currency);
                  }
                  break;

                default:
                  break;
              }
              break;
            }
            break;
          default:
            //console.log(event.payload.value?.content.case);
            break;
        }
      }
      break;
    default:
      console.log(event.payload.case);
  }
}
