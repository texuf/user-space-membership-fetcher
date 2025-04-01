import { ethers, providers } from "ethers";
import {
  isChannelStreamId,
  makeRiverConfig,
  makeStreamRpcClient,
  spaceIdFromChannelId,
  streamIdAsBytes,
  StreamStateView,
  unpackStream,
} from "@river-build/sdk";
import {
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceAddressFromSpaceId,
  SpaceDapp,
} from "@river-build/web3";

// Replace with your provider URL (Infura, Alchemy, or local node)
//const PROVIDER_URL = "https://mainnet.infura.io/v3/YOUR_INFURA_API_KEY";
//const PROVIDER_URL =
// "https://base-mainnet.g.alchemy.com/v2/EJX2K5g7r-491-FI3kzrOfoKipFSKGVw";
const PROVIDER_URL =
  "https://base-mainnet.g.alchemy.com/v2/Kq12vH3nOW2cbJv79ZgUM5FcT-Y424m1";

// Replace with the target contract address
const CONTRACT_ADDRESS = "0x37f792728f5dd4049dd25442e7ed3f1a38a827d1"; //ax1

// Replace with the correct contract ABI for the "Tip" event
const TIP_EVENT_ABI = [
  "event Tip(uint256 indexed tokenId, address indexed currency, address sender, address receiver, uint256 amount, bytes32 messageId, bytes32 channelId)",
];

// Replace with the event topic hash
const TIP_EVENT_TOPIC =
  "0x854db29cbd1986b670c0d596bf56847152a0d66e5ddef710408c1fa4ada78f2b";

async function fetchTipEvents() {
  // Set up provider
  const provider = new providers.JsonRpcProvider(PROVIDER_URL);

  const env = process.env.ENV ?? "omega";
  const config = makeRiverConfig(env);

  // make a space dapp
  const spaceDapp = new SpaceDapp(
    config.base.chainConfig,
    new LocalhostWeb3Provider(config.base.rpcUrl)
  );

  const space = await spaceDapp.getSpace(CONTRACT_ADDRESS);
  if (!space) {
    console.error("Space not found");
    process.exit(1);
  }

  // Get the latest block number (or specify a range)
  const latestBlock = await provider.getBlockNumber();
  console.log("Latest block:", latestBlock, latestBlock - 1000000, 24707541);
  const fromBlock = 24707541;

  // Fetch logs for the Tip event
  const logs = await provider.getLogs({
    //address: CONTRACT_ADDRESS,
    topics: [TIP_EVENT_TOPIC],
    fromBlock,
    toBlock: "latest",
  });

  console.log(`Fetched ${logs.length} Tip events.`);

  // Decode logs
  const tipEvents = logs.map((log) => space.Tipping.interface.parseLog(log));

  // Aggregate tip amounts per sender
  const tipTotals: Record<string, bigint> = {};

  for (const event of tipEvents) {
    const sender = event.args.sender;
    const amount = BigInt(event.args.amount);

    if (!tipTotals[sender]) {
      tipTotals[sender] = BigInt(0);
    }
    tipTotals[sender] += amount;
  }

  // Sort senders by total tipped amount
  const sortedSenders = Object.entries(tipTotals)
    .sort(([, a], [, b]) => Number(b - a))
    .slice(0, 100);

  console.log("Top 100 tippers:", sortedSenders.at(0));
  console.table(
    sortedSenders.map(([sender, total]) => ({
      sender,
      totalTippedWei: total.toString(),
    }))
  );
}

// Run the function
fetchTipEvents().catch(console.error);
