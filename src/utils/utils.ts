import { utils } from "ethers";
import { bin_toHexString } from "@towns-protocol/utils";
import { enumToJson, fromJsonString, toBinary, toJsonString } from "@bufbuild/protobuf";
import { snakeCase } from 'lodash-es'
import {
  FullyReadMarkers,
  FullyReadMarkersSchema,
  GetMiniblocksResponseSchema,
  MemberPayload,
  MembershipOpSchema,
  MembershipReasonSchema,
  Snapshot,
  StreamEvent,
  TagsSchema,
  UserPayload,
  UserSettingsPayload,
  UserSettingsPayload_FullyReadMarkers,
} from "@towns-protocol/proto";
import {
  ExclusionFilter,
  getFallbackContent,
  makeRemoteTimelineEvent,
  ParsedEvent,
  ParsedMiniblock,
  ParsedStreamResponse,
  streamIdAsBytes,
  streamIdAsString,
  StreamRpcClient,
  toEvent,
  UnpackEnvelopeOpts,
  unpackMiniblock,
  unpackSnapshot,
  userIdFromAddress,
} from "@towns-protocol/sdk";
import { publicKeyToAddress } from "@towns-protocol/utils";
import { riverRecoverPubKey } from "@towns-protocol/sdk";

export type PrintStreamResponseEventsOpts = {
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

export function printStreamEventDetails(
  parsedEvent: ParsedEvent, // Consider defining a more specific type if available
  streamEvent: StreamEvent,
  hash: Uint8Array,
  signature: Uint8Array | undefined,
  opts?: PrintStreamResponseEventsOpts
) {
  if (
    streamEvent.payload.case === "miniblockHeader" &&
    !opts?.noMiniblockHeaders
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

export function ensureHexPrefix(value: string): string {
  return value.startsWith("0x") ? value : `0x${value}`;
}


export async function getMiniblocks(
  client: StreamRpcClient,
  streamId: string | Uint8Array,
  fromInclusive: bigint,
  toExclusive: bigint,
  omitSnapshots: boolean,
  exclusionFilter: ExclusionFilter | undefined,
  unpackEnvelopeOpts: UnpackEnvelopeOpts | undefined,
): Promise<{
  miniblocks: ParsedMiniblock[]
  terminus: boolean
  snapshots?: Record<string, Snapshot>
}> {
  const allMiniblocks: ParsedMiniblock[] = []
  let currentFromInclusive = fromInclusive
  let reachedTerminus = false
  const parsedSnapshots: Record<string, Snapshot> = {}

  while (currentFromInclusive < toExclusive) {
      const { miniblocks, terminus, nextFromInclusive, snapshots } = await fetchMiniblocksFromRpc(
          client,
          streamId,
          currentFromInclusive,
          toExclusive,
          omitSnapshots,
          exclusionFilter,
          unpackEnvelopeOpts,
      )

      allMiniblocks.push(...miniblocks)
      if (!omitSnapshots) {
          Object.entries(snapshots).forEach(([key, snapshot]) => {
              parsedSnapshots[key] = snapshot
          })
      }

      // Set the terminus to true if we got at least one response with reached terminus
      // The behaviour around this flag is not implemented yet
      if (terminus && !reachedTerminus) {
          reachedTerminus = true
      }

      if (currentFromInclusive === nextFromInclusive) {
          break
      }

      currentFromInclusive = nextFromInclusive
  }

  return {
      miniblocks: allMiniblocks,
      terminus: reachedTerminus,
      snapshots: parsedSnapshots,
  }
}

export async function fetchMiniblocksFromRpc(
  client: StreamRpcClient,
  streamId: string | Uint8Array,
  fromInclusive: bigint,
  toExclusive: bigint,
  omitSnapshots: boolean,
  exclusionFilter: ExclusionFilter | undefined,
  unpackEnvelopeOpts: UnpackEnvelopeOpts | undefined,
) {
  const response = await client.getMiniblocks({
      streamId: streamIdAsBytes(streamId),
      fromInclusive,
      toExclusive,
      omitSnapshots,
      exclusionFilter:
          exclusionFilter?.map(({ payload, content }) => ({
              payload: snakeCase(payload),
              content: snakeCase(content),
          })) ?? [],
  })

  const byteLength = toBinary(
    GetMiniblocksResponseSchema,
    response
  ).byteLength;
  const mb = byteLength / 1024 / 1024;
  console.log(
    `Batch ${fromInclusive} to ${toExclusive} size: ${mb.toFixed(2)} MB`
  );

  const miniblocks: ParsedMiniblock[] = []
  const parsedSnapshots: Record<string, Snapshot> = {}
  for (const miniblock of response.miniblocks) {
      const unpackedMiniblock = await unpackMiniblock(miniblock, unpackEnvelopeOpts)
      const unpackedMiniblockNum = unpackedMiniblock.header.miniblockNum.toString()
      miniblocks.push(unpackedMiniblock)
      if (!omitSnapshots && response.snapshots[unpackedMiniblockNum]) {
          parsedSnapshots[unpackedMiniblockNum] = (
              await unpackSnapshot(
                  unpackedMiniblock.events.at(-1)?.event,
                  unpackedMiniblock.header.snapshotHash,
                  response.snapshots[unpackedMiniblockNum],
                  unpackEnvelopeOpts,
              )
          ).snapshot
      }
  }

  const respondedFromInclusive =
      miniblocks.length > 0 ? miniblocks[0].header.miniblockNum : fromInclusive

  return {
      miniblocks: miniblocks,
      terminus: response.terminus,
      nextFromInclusive: respondedFromInclusive + BigInt(response.miniblocks.length),
      snapshots: parsedSnapshots,
  }
}