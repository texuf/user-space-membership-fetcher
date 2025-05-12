import { parseGroupEncryptionAlgorithmId } from "@towns-protocol/encryption";
import { MembershipOp } from "@towns-protocol/proto";
import {
  isChannelStreamId,
  isSpaceStreamId,
  makeRiverConfig,
  makeStreamRpcClient,
  makeUserInboxStreamId,
  makeUserMetadataStreamId,
  makeUserSettingsStreamId,
  makeUserStreamId,
  ParsedEvent,
  streamIdAsBytes,
  streamIdAsString,
  StreamStateView,
  unpackMiniblock,
  unpackStream,
} from "@towns-protocol/sdk";
import {
  INVALID_ADDRESS,
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceAddressFromSpaceId,
  SpaceDapp,
} from "@towns-protocol/web3";

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

  // Make the user stream ID
  const userInboxStreamId = makeUserInboxStreamId(rootWallet);

  console.log(`User inbox ID: ${userInboxStreamId}`);

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
  // const response = await riverRpcProvider.getStream({
  //   streamId: streamIdAsBytes(userInboxStreamId),
  // });

  // const unpackedResponse = await unpackStream(response.stream, undefined);
  // const streamView = new StreamStateView("0", userInboxStreamId);
  // streamView.initialize(
  //   unpackedResponse.streamAndCookie.nextSyncCookie,
  //   unpackedResponse.streamAndCookie.events,
  //   unpackedResponse.snapshot,
  //   unpackedResponse.streamAndCookie.miniblocks,
  //   [],
  //   unpackedResponse.prevSnapshotMiniblockNum,
  //   undefined,
  //   [],
  //   undefined
  // );
  // for (const event of streamView.timeline) {
  //   const payload = event.remoteEvent?.event.payload;
  //   printUserInboxEvent(event?.remoteEvent);
  // }

  const streamId = streamIdAsBytes(userInboxStreamId);
  const response1 = await riverRpcProvider.getLastMiniblockHash({ streamId });
  const { miniblockNum } = response1;
  const blocks = await riverRpcProvider.getMiniblocks({
    streamId,
    fromInclusive: miniblockNum - 500n,
    toExclusive: miniblockNum,
  });

  for (const block of blocks.miniblocks) {
    const unpacked = await unpackMiniblock(block, {
      disableHashValidation: true,
      disableSignatureValidation: true,
    });
    for (const event of unpacked.events) {
      printUserInboxEvent(event);
    }
  }
};

const printUserInboxEvent = (event?: ParsedEvent) => {
  if (!event) {
    return;
  }
  const payload = event.event.payload;
  if (payload?.case !== "userInboxPayload") {
    return;
  }
  const content = payload.value.content;
  if (content?.case !== "groupEncryptionSessions") {
    return;
  }

  const timestamp = event.event.createdAtEpochMs;
  const timestampReadable = new Date(Number(timestamp)).toISOString();
  console.log(
    "groupEncryptionSessions",
    timestampReadable,
    `from: ${event.creatorUserId}`,
    streamIdAsString(content.value.streamId),
    Object.keys(content.value.ciphertexts),
    content.value.sessionIds,
    parseGroupEncryptionAlgorithmId(content.value.algorithm).value
  );
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });
