import {
  isChannelStreamId,
  isSpaceStreamId,
  townsEnv,
  makeStreamRpcClient,
  streamIdAsBytes,
  StreamStateView,
  unpackStream,
  spaceIdFromChannelId,
} from "@towns-protocol/sdk";
import {
  LocalhostWeb3Provider,
  Permission,
  RiverRegistry,
  SpaceDapp,
} from "@towns-protocol/web3";
import { env } from "./env";
import SuperJSON from "superjson";
import { ensureHexPrefix } from "./utils/utils";
import { BigNumber } from "ethers";

// Register ethers BigNumber with SuperJSON
SuperJSON.registerCustom<BigNumber, string>(
  {
    isApplicable: (v): v is BigNumber => BigNumber.isBigNumber(v),
    serialize: (v) => v.toHexString(),
    deserialize: (v) => BigNumber.from(v),
  },
  "ethers.BigNumber"
);

const run = async () => {
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

  console.log(`Running permissions for ${param} in ${env.RIVER_ENV}`);

  // make the config
  const config = townsEnv({ env }).makeTownsConfig();

  // make a space dapp
  const spaceDapp = new SpaceDapp(
    config.base.chainConfig,
    new LocalhostWeb3Provider(config.base.rpcUrl)
  );

  if (isSpaceStreamId(param)) {
    const space = await spaceDapp.getSpace(param);
    if (param2) {
      const entitlements = {
        read: await spaceDapp.isEntitledToSpace(param, param2, Permission.Read),
        write: await spaceDapp.isEntitledToSpace(
          param,
          param2,
          Permission.Write
        ),
        modify: await spaceDapp.isEntitledToSpace(
          param,
          param2,
          Permission.ModifySpaceSettings
        ),
      };

      const wallets = await spaceDapp.getWalletLink().getLinkedWallets(param2);

      const isMember = await Promise.all(
        wallets.map(async (x) => {
          const status = await spaceDapp.getMembershipStatus(param, [x]);
          return { address: x, status };
        })
      );

      console.log(`isEntitled:`, entitlements, "\nmember:", isMember);
    }
  } else if (isChannelStreamId(param)) {
    console.log("channel?");
    const channelId = param;
    const spaceId = spaceIdFromChannelId(channelId);
    const channelInfo = await spaceDapp.getChannelDetails(spaceId, channelId);
    console.log(JSON.stringify(channelInfo, undefined, 2));
    console.log("space rules");
    const roles = await spaceDapp.getRoles(spaceId);
    for (const role of roles) {
      const roleInfo = await spaceDapp.getRole(spaceId, role.roleId);
      console.log("role info");
      console.log(JSON.stringify(roleInfo, undefined, 2));
      const permissions = await spaceDapp.getPermissionsByRoleId(
        spaceId,
        role.roleId
      );
      console.log("permissions");
      console.log(JSON.stringify(permissions, undefined, 2));
    }
    console.log("read permission");
    const space = spaceDapp.getSpace(spaceId);
    if (!space) {
      console.error("space not found");
      process.exit(1);
    }
    const entitlementData =
      await space.EntitlementDataQueryable.read.getChannelEntitlementDataByPermission(
        ensureHexPrefix(channelId),
        Permission.Read
      );

    console.log("entitlement data", SuperJSON.stringify(entitlementData));
    if (param2) {
      const tokenId = await space.getTokenIdsOfOwner([param2]);
      console.log("tokenId", tokenId);
      const isEntitled = {
        read: await spaceDapp.isEntitledToChannel(
          spaceId,
          channelId,
          param2,
          Permission.Read
        ),
        write: await spaceDapp.isEntitledToChannel(
          spaceId,
          channelId,
          param2,
          Permission.Write
        ),
        redact: await spaceDapp.isEntitledToChannel(
          spaceId,
          channelId,
          param2,
          Permission.Redact
        ),
      };
      console.log("isEntitledToChannel", isEntitled);
    }
  } else {
    console.log("not space or channel");
  }

  // make a river provider
  const riverRegistry = new RiverRegistry(
    config.river.chainConfig,
    new LocalhostWeb3Provider(config.river.rpcUrl)
  );

  // find nodes for the stream
  const streamStruct = await riverRegistry.getStream(streamIdAsBytes(param));

  console.log("\n==============\nStream:");
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
