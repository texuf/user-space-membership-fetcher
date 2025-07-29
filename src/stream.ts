import {
  clone,
  enumToJson,
  fromJsonString,
  toBinary,
  toJson,
  toJsonString,
} from "@bufbuild/protobuf";
import {
  FullyReadMarkers,
  FullyReadMarkersSchema,
  GetStreamResponse,
  GetStreamResponseSchema,
  MemberPayload,
  MembershipOpSchema,
  MembershipReasonSchema,
  SnapshotSchema,
  StreamEvent,
  TagsSchema,
  UserPayload,
  UserSettingsPayload,
  UserSettingsPayload_FullyReadMarkers,
} from "@towns-protocol/proto";
import {
  getFallbackContent,
  getMiniblocks,
  isChannelStreamId,
  isSpaceStreamId,
  makeRemoteTimelineEvent,
  makeRiverConfig,
  makeStreamRpcClient,
  ParsedEvent,
  ParsedStreamResponse,
  publicKeyToAddress,
  riverRecoverPubKey,
  spaceIdFromChannelId,
  streamIdAsBytes,
  streamIdAsString,
  StreamRpcClient,
  StreamStateView,
  toEvent,
  unpackStream,
  userIdFromAddress,
} from "@towns-protocol/sdk";
import {
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceAddressFromSpaceId,
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
  //const loadFileName = process.env.FILENAME ?? undefined;
  let response: GetStreamResponse | undefined;
  let param: string;

  // if (loadFileName) {
  //   const file = fs.readFileSync(loadFileName);
  //   console.log("file size", file.length);
  //   response = fromBinary(GetStreamResponseSchema, file);
  //   console.log("file", file);
  //   param = loadFileName.split("/")[1]?.split("-").at(0) ?? "";
  // } else {
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
  const streamIdBytes = streamIdAsBytes(param);
  const startGetNodes = performance.now();
  const streamStruct = await riverRegistry.getStream(streamIdBytes);
  const endGetNodes = performance.now();
  console.log("getStreamFromRegistry time:", endGetNodes - startGetNodes, "ms");

  console.log("Stream:");
  console.log(JSON.stringify(streamStruct, undefined, 2));
  console.log("Nodes:");
  const nodes = await Promise.all(
    streamStruct.nodes.map((x) => riverRegistry.nodeRegistry.read.getNode(x))
  );
  console.log(JSON.stringify(nodes, undefined, 2));
  let riverRpcProvider: StreamRpcClient | undefined;
  for (const node of nodes) {
    //  const node = nodes[nodeIndex];

    const rpcUrl = node.url;
    console.log("");
    console.log("Connecting to URL:", rpcUrl);
    riverRpcProvider = makeStreamRpcClient(rpcUrl, undefined, {
      retryParams: {
        maxAttempts: 3,
        initialRetryDelay: 2000,
        maxRetryDelay: 6000,
        defaultTimeoutMs: 120000, // 30 seconds for long running requests
      },
    });

    // fetch the user stream
    const time3 = performance.now();
    response = await riverRpcProvider.getStream(
      {
        streamId: streamIdBytes,
      },
      { timeoutMs: 120000 }
    );
    if (!response) {
      throw new Error("No response");
    }
    const time4 = performance.now();
    console.log("Get stream time:", time4 - time3, "ms");

    const time1 = performance.now();
    const lastMiniblockResponse = await riverRpcProvider.getLastMiniblockHash({
      streamId: streamIdBytes,
    });
    const time2 = performance.now();
    console.log("Last miniblock hash time:", time2 - time1, "ms");
    console.log("Last miniblock hash:", lastMiniblockResponse);

    const binStreamResponse = toBinary(GetStreamResponseSchema, response);
    const byteLength = binStreamResponse.byteLength;
    // print size in mb
    const mb = bytesToMB(byteLength);
    console.log("Response size:", mb.toFixed(2), "MB");

    // save to file
    // const filename = `temp/${param}-stream-${new Date()
    //   .toISOString()
    //   .replace(/:/g, "-")
    //   .replace("T", "-")
    //   .replace(".", "-")
    //   .replace("/", "-")}.bin`;
    // fs.writeFileSync(filename, binStreamResponse);
    // console.log(`Saved stream response to ${filename}`);
    //}

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
      console.log("pool size", response.stream.events.length);
      if (response.stream.snapshot) {
        console.log(
          "snapshot size",
          bytesToMB(response.stream.snapshot.event.byteLength).toFixed(2),
          "MB"
        );
      }
    }
  }

  riverRpcProvider = makeStreamRpcClient(nodes[0].url, undefined, {
    retryParams: {
      maxAttempts: 3,
      initialRetryDelay: 2000,
      maxRetryDelay: 6000,
      defaultTimeoutMs: 120000, // 30 seconds for long running requests
    },
  });

  console.log("riverRpcProvider", riverRpcProvider);

  if (!riverRpcProvider) {
    throw new Error("No river rpc provider");
  }

  if (!response) {
    throw new Error("No response");
  }

  const unpackedResponse = await unpackStream(response.stream, undefined);

  console.log("snapshot", toJson(SnapshotSchema, unpackedResponse.snapshot));
  console.log(
    "snapshot size",
    bytesToMB(response.stream?.snapshot?.event.byteLength ?? 0).toFixed(2),
    "MB"
  );
  // make a copy of the snapshot
  const snapshotCopy = clone(SnapshotSchema, unpackedResponse.snapshot);
  snapshotCopy.members?.joined.forEach((m) => {
    m.solicitations = [];
  });
  const snapshotCopyBin = toBinary(SnapshotSchema, snapshotCopy);
  const snapshotCopyBinSize = snapshotCopyBin.byteLength;
  const snapshotCopyMB = bytesToMB(snapshotCopyBinSize);
  console.log("snapshotCopy size", snapshotCopyMB.toFixed(2), "MB");

  if (printMembers) {
    const members = unpackedResponse.snapshot?.members?.joined ?? [];
    for (const member of members) {
      console.log(`member ${userIdFromAddress(member.userAddress)}`, member);
    }
  }

  const streamView = new StreamStateView("0", param, undefined);
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

  if (isSpaceStreamId(param)) {
    console.log("space address", SpaceAddressFromSpaceId(param));
  }

  if (isChannelStreamId(param)) {
    const spaceId = spaceIdFromChannelId(param);
    console.log("spaceId", spaceId);
    console.log("space address", SpaceAddressFromSpaceId(spaceId));
  }

  const opts: PrintStreamResponseEventsOpts = {
    noEvents: false,
    noMiniblockHeaders: false,
  };

  if (historicalBlocks > 0) {
    const toExclusive =
      unpackedResponse.streamAndCookie.miniblocks[0].header.miniblockNum;
    let fromInclusive = toExclusive - BigInt(historicalBlocks);
    if (fromInclusive < 0n) {
      fromInclusive = 0n;
    }
    console.log("fromInclusive", fromInclusive);
    console.log("toExclusive", toExclusive);
    const blocksResponse = await getMiniblocks(
      riverRpcProvider,
      param,
      fromInclusive,
      toExclusive,
      true,
      undefined,
      undefined
    );
    console.log("======== Historical events =========");
    for (const mb of blocksResponse.miniblocks) {
      //console.log("block", block.header?.miniblockNum);
      for (const event of mb.events) {
        printStreamEventDetails(
          event,
          event.event,
          event.hash,
          event.signature,
          opts
        );
      }
    }
  }
  printStreamResponseEvents(unpackedResponse, opts);
};

type PrintStreamResponseEventsOpts = {
  noEvents?: boolean;
  noMiniblockHeaders?: boolean;
};

export function printStreamResponseEvents(
  unpackedResponse: ParsedStreamResponse,
  opts?: PrintStreamResponseEventsOpts
) {
  console.log("======== Stream events =========");
  for (const mb of unpackedResponse.streamAndCookie.miniblocks) {
    //const header = mb.header?.miniblockNum;
    //console.log("miniblock", header);
    for (const event of mb.events) {
      const streamEvent = event.event;
      printStreamEventDetails(
        event,
        streamEvent,
        event.hash,
        event.signature,
        opts
      );
    }
  }

  if (unpackedResponse.streamAndCookie.events.length > 0) {
    console.log("======== Minipool events =========");
    for (const event of unpackedResponse.streamAndCookie.events) {
      printStreamEventDetails(
        event,
        event.event,
        event.hash,
        event.signature,
        opts
      );
    }
  }
}

function printStreamEventDetails(
  parsedEvent: ParsedEvent, // Consider defining a more specific type if available
  streamEvent: StreamEvent,
  hash: Uint8Array,
  signature: Uint8Array | undefined,
  opts?: PrintStreamResponseEventsOpts
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
  const content = toEvent(
    makeRemoteTimelineEvent({
      parsedEvent: parsedEvent,
      eventNum: 0n,
      miniblockNum: 0n,
    }),
    userId
  ).content;
  const fallbackContent = content
    ? getFallbackContent(userId, content)
    : "undefined";
  if (opts?.noEvents !== true) {
    console.log(
      "event",
      parsedEvent.hashStr,
      userId,
      timestamp,
      streamEvent.payload.case,
      streamEvent.payload.value?.content.case,
      fallbackContent,
      streamEvent.tags ? toJsonString(TagsSchema, streamEvent.tags) : ""
    );
  }
  specialPrint(streamEvent, hash, signature, opts);
}

let prevFullyReadMarkers: { [key: string]: FullyReadMarkers } = {};

export function specialPrint(
  event: StreamEvent,
  hash: Uint8Array,
  signature: Uint8Array | undefined,
  opts?: PrintStreamResponseEventsOpts
) {
  switch (event.payload.case) {
    case "miniblockHeader":
      if (opts?.noMiniblockHeaders !== true) {
        console.log(
          "miniblockHeader",
          bin_toHexString(hash),
          event.payload.value?.miniblockNum,
          `snapshot: ${
            event.payload.value?.snapshotHash
              ? bin_toHexString(event.payload.value?.snapshotHash)
              : event.payload.value?.snapshot
              ? "yes"
              : "nil"
          }`,
          `events: ${event.payload.value?.eventHashes.length}`
        );
      }
      break;
    case "memberPayload": {
      const payload: MemberPayload = event.payload.value;
      switch (payload.content.case) {
        case "membership":
          {
            if (payload.content.value.reason !== undefined) {
              console.log("  reason", payload.content.value.reason);
            } else {
              console.log("  no reason", payload.content.value.reason);
            }
          }
          break;
      }
      break;
    }
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
          case "userMembership": {
            const membership = payload.content.value;
            console.log(
              "userMembership",
              // the date
              new Date(Number(event.createdAtEpochMs)).toISOString(),
              streamIdAsString(membership.streamId),
              "op",
              enumToJson(MembershipOpSchema, membership.op),
              "reason",
              membership.reason
                ? enumToJson(MembershipReasonSchema, membership.reason)
                : undefined,
              "streamId",
              streamIdAsString(membership.streamId)
            );
            break;
          }
          default:
            //console.log(event.payload.value?.content.case);
            break;
        }
      }
      break;
    case "userSettingsPayload":
      {
        const payload: UserSettingsPayload = event.payload.value;
        switch (payload.content.case) {
          case "fullyReadMarkers":
            {
              const markers: UserSettingsPayload_FullyReadMarkers =
                payload.content.value;
              if (markers.content?.data) {
                const newFullyReadMarkers = fromJsonString(
                  FullyReadMarkersSchema,
                  markers.content.data
                );
                if (signature) {
                  try {
                    const signerAddress = riverRecoverPubKey(hash, signature);
                    console.log(
                      "  =signerAddress",
                      userIdFromAddress(publicKeyToAddress(signerAddress))
                    );
                  } catch (e) {
                    console.log("error", e);
                  }
                } else {
                  console.log("  ===no signature");
                }
                const streamId = bin_toHexString(markers.streamId);
                console.log(
                  "  =fullyReadMarkers",
                  Object.keys(newFullyReadMarkers.markers).length,
                  streamId
                  // Object.keys(newFullyReadMarkers.markers)
                );
                if (prevFullyReadMarkers[streamId]) {
                  for (const [key, value] of Object.entries(
                    newFullyReadMarkers.markers
                  )) {
                    const prev = prevFullyReadMarkers[streamId].markers[key];
                    if (prev) {
                      const next = value;
                      if (next.beginUnreadWindow < prev.beginUnreadWindow) {
                        console.log(
                          "    !!!!overwritten beginUnreadWindow!!!!",
                          streamId,
                          key,
                          next.beginUnreadWindow,
                          prev.beginUnreadWindow
                        );
                      }
                    } else {
                      console.log("    *new marker", streamId, key);
                    }
                  }
                }
                prevFullyReadMarkers[streamId] = newFullyReadMarkers;
              }
            }
            break;
        }
      }
      break;
    default:
      console.log(event.payload.case);
  }
}

// only run if this file is the main file
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("unhandled error:", e);
      process.exit(1);
    });
}
