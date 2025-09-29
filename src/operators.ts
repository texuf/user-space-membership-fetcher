import {
  townsEnv,
  makeStreamRpcClient,
  streamIdAsBytes,
  StreamStateView,
  unpackStream,
  TownsConfig,
} from "@towns-protocol/sdk";
import {
  LocalhostWeb3Provider,
  RiverRegistry,
  SpaceAddressFromSpaceId,
  SpaceDapp,
  SpaceIdFromSpaceAddress,
  SpaceOwner,
} from "@towns-protocol/web3";
import { z } from "zod";
import {
  createPublicClient,
  http,
  Address,
  isAddress,
  defineChain,
  PublicClient,
} from "viem";
import { base, baseSepolia, Chain } from "viem/chains";
import rewardsDistributionAbi from "@towns-protocol/generated/dev/abis/RewardsDistributionV2.abi";
import riverRegistryAbi from "@towns-protocol/generated/dev/abis/MockRiverRegistry.abi";
import nodeOperatorAbi from "@towns-protocol/generated/dev/abis/INodeOperator.abi";
import { env } from "./env";
import SuperJSON from "superjson";

const run = async () => {
  console.log("fetch operators!");
  const dir: { a: Number; b: string } = SuperJSON.parse<{
    a: Number;
    b: string;
  }>('{ "json": 100 }');
  console.log(dir, dir.a, dir.b);
  await getOperators();

  for (const x of [
    1,
    20n,
    undefined,
    null,
    true,
    false,
    "hello",
    { a: 1 },
    new Date(),
  ]) {
    const str = SuperJSON.stringify(x);
    const parsed = SuperJSON.parse(str);
    console.log(x, str, parsed);
  }
};

const zodAddress = z.string().refine(isAddress);

export const nodesSchema = z.object({
  nodes: z.array(
    z.object({
      record: z.object({
        address: zodAddress,
        url: z.string(),
        operator: zodAddress,
        status: z.number(),
        status_text: z.string(),
      }),
      local: z.boolean().optional(),
      http11: z.object({
        foo: z.string(),
        success: z.boolean(),
        status: z.number(),
        status_text: z.string(),
        elapsed: z.string(),
        response: z.object({
          status: z.string(),
          instance_id: z.string(),
          address: z.string(),
          version: z.string(),
          start_time: z.string(),
          uptime: z.string(),
          graffiti: z.string(),
        }),
        protocol: z.string(),
        used_tls: z.boolean(),
        remote_address: z.string(),
        dns_addresses: z.array(z.string()),
      }),
      http20: z.object({
        success: z.boolean(),
        status: z.number(),
        status_text: z.string(),
        elapsed: z.string(),
        response: z.object({
          status: z.string(),
          instance_id: z.string(),
          address: z.string(),
          version: z.string(),
          start_time: z.string(),
          uptime: z.string(),
          graffiti: z.string(),
        }),
        protocol: z.string(),
        used_tls: z.boolean(),
        remote_address: z.string(),
        dns_addresses: z.array(z.string()),
      }),
      grpc: z.object({
        success: z.boolean(),
        status_text: z.string(),
        elapsed: z.string(),
        version: z.string(),
        start_time: z.string(),
        uptime: z.string(),
        graffiti: z.string(),
        protocol: z.string(),
        x_http_version: z.string(),
        remote_address: z.string(),
        dns_addresses: z.array(z.string()),
      }),
      river_eth_balance: z.string(),
    })
  ),
  query_time: z.string(),
  elapsed: z.string(),
});

export type NodeData = z.infer<typeof nodesSchema>["nodes"][number];

export type StakableOperator = {
  name: string;
  baseName: string;
  image: string;
  nodes: NodeData[];
  commissionPercentage: number;
  estimatedApr: number;
  address: Address;
  isActive: boolean;
  metrics: {
    http20: number;
    grpc: number;
    grpc_start_time: string;
    uptime_percentage: number;
  };
};

export type StakeableOperatorsResponse = {
  operators: StakableOperator[];
  networkEstimatedApy: number;
};

const OPERATOR_STATUS_ACTIVE = 3;

const cachedValue = async <T>(fn: () => Promise<T>) => {
  const value = await fn();
  const toStr = SuperJSON.stringify(value);
  const fromStr = SuperJSON.parse<T>(toStr);
  return fromStr;
};

export async function getOperators(): Promise<StakeableOperatorsResponse> {
  const config = townsEnv({ env }).makeTownsConfig();

  const contractAddresses = {
    baseRegistry: config.base.chainConfig.addresses.baseRegistry as Address,
    riverRegistry: config.river.chainConfig.addresses.riverRegistry as Address,
  };

  const baseClient = createPublicClient({
    chain: config.base.chainConfig.chainId === base.id ? base : baseSepolia,
    transport: http(
      config.base.chainConfig.chainId === base.id
        ? `https://base-mainnet.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`
        : `https://base-sepolia.g.alchemy.com/v2/${env.ALCHEMY_API_KEY}`
    ),
  }) as PublicClient;

  const riverClient = createPublicClient({
    chain: riverChains[env.ENVIRONMENT as keyof typeof riverChains],
    transport: http(),
  });

  let now = performance.now();

  const networkApy = await cachedValue(() =>
    fetchNetworkApy(config, baseClient)
  );

  const riverNodes = await cachedValue(() =>
    getRiverNodes(riverClient, config)
  );

  const nodes = await cachedValue(() => getRiverNodesStatuses(riverNodes));

  const operatorMap = reduceNodesToOperatorMap(nodes);

  const uniqueOperators = Object.keys(operatorMap) as Address[];

  const operatorStatus = await Promise.all(
    uniqueOperators.map((operator) =>
      cachedValue(() => fetchOperatorStatus(config, baseClient, operator))
    )
  );

  const validOperators = uniqueOperators
    .filter((_, index) => operatorStatus[index] === OPERATOR_STATUS_ACTIVE)
    .sort((a, b) => a.localeCompare(b));

  const commissionRates = await Promise.all(
    validOperators.map((operator) =>
      cachedValue(() => fetchCommissionRate(config, baseClient, operator))
    )
  );

  const uptimePercentages = await Promise.all(
    validOperators.map((operator) =>
      Promise.all(
        operatorMap[operator].map((node) =>
          cachedValue(() => Promise.resolve(1))
        )
      )
    )
  );

  const operatorData = buildOperatorData({
    validOperators,
    uniqueOperators,
    uptimePercentages,
    operatorStatus,
    commissionRates,
    operatorMap,
    networkApy,
  });

  const timeTaken = performance.now() - now;
  console.log(`Time taken to get operator data: ${timeTaken}ms`);
  console.dir(operatorData);

  return {
    operators: operatorData,
    networkEstimatedApy: networkApy,
  };
}

// Helper functions
export const getMedian = (arr: number[]): number => {
  if (!arr.length) return 0;
  if (arr.length === 1) return arr[0];
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

export const parseLatency = (latency: string): number => {
  const match = latency.match(/(\d+(?:\.\d+)?)\s*ms/);
  return match ? parseFloat(match[1]) : 0;
};

export const operatorApr = (commissionRate: bigint, networkApr: number) => {
  const commInBps = Number(commissionRate);
  const apr = networkApr * (1 - commInBps / 10_000);
  return apr;
};

export const estimatedApyOfNetwork = (
  rewardRate: bigint,
  totalStaked: bigint
) => {
  if (totalStaked === 0n) return 0;
  if (rewardRate === 0n) return 0;

  const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
  const apy =
    (((rewardRate * BigInt(SECONDS_PER_YEAR)) / BigInt(1e36)) * 10000n) /
    totalStaked;
  return Number(apy) / 10000;
};

export const getAverage = (arr: number[]): number => {
  if (!arr.length) return 0;
  return arr.reduce((sum, value) => sum + value, 0) / arr.length;
};

/**
 * Processes raw operator data into structured operator information with deduplication and metrics
 */
function buildOperatorData({
  validOperators,
  uniqueOperators,
  uptimePercentages,
  operatorStatus,
  commissionRates,
  operatorMap,
  networkApy,
}: {
  validOperators: Address[];
  uniqueOperators: Address[];
  uptimePercentages: number[][];
  operatorStatus: number[];
  commissionRates: bigint[];
  operatorMap: Record<string, NodeData[]>;
  networkApy: number;
}): StakableOperator[] {
  const uptimePercentagesMap = validOperators.reduce<Record<Address, number>>(
    (map, operator, index) => {
      map[operator] = getAverage(uptimePercentages[index]);
      return map;
    },
    {}
  );

  const operatorStatusMap = uniqueOperators.reduce<Record<Address, number>>(
    (map, operator, index) => {
      map[operator] = operatorStatus[index];
      return map;
    },
    {}
  );

  const operatorCommissionMap = validOperators.reduce<Record<Address, bigint>>(
    (map, operator, index) => {
      map[operator] = commissionRates[index];
      return map;
    },
    {}
  );

  // Pre-calculate operator names and their occurrences to avoid race conditions
  const operatorNames: Record<Address, string> = {};
  const operatorNameOccurency: Record<string, number> = {};

  // First pass: collect all operator names
  for (const operatorAddress of validOperators) {
    const nodes = operatorMap[operatorAddress];
    const nodeUrl = nodes[0].record.url;
    const hostname = new URL(nodeUrl).hostname;

    const displayName = Object.entries(HOSTNAME_TO_OPERATOR_NAME).find(
      ([key]) => hostname.includes(key)
    )?.[1];

    const name = displayName ?? hostname;
    operatorNames[operatorAddress] = name;
    operatorNameOccurency[name] = (operatorNameOccurency[name] ?? 0) + 1;
  }

  // Second pass: create final names with occurrence numbers only for duplicates
  const operatorFinalNames: Record<Address, string> = {};
  const nameCounts: Record<string, number> = {};

  for (const operatorAddress of validOperators) {
    const baseName = operatorNames[operatorAddress];
    const totalOccurrences = operatorNameOccurency[baseName];

    if (totalOccurrences === 1) {
      // Only one occurrence, no need for number suffix
      operatorFinalNames[operatorAddress] = baseName;
    } else {
      // Multiple occurrences, add number suffix
      nameCounts[baseName] = (nameCounts[baseName] ?? 0) + 1;
      operatorFinalNames[
        operatorAddress
      ] = `${baseName} ${nameCounts[baseName]}`;
    }
  }

  const operatorData = validOperators.map((operatorAddress) => {
    const nodes = operatorMap[operatorAddress];
    const commissionRateInBps = operatorCommissionMap[operatorAddress];
    const estimatedApr = operatorApr(commissionRateInBps, networkApy);

    const nodeUrl = nodes[0].record.url;
    const hostname = new URL(nodeUrl).hostname;

    const displayName = Object.entries(HOSTNAME_TO_OPERATOR_NAME).find(
      ([key]) => hostname.includes(key)
    )?.[1];

    const name = displayName ?? hostname;
    const finalName = operatorFinalNames[operatorAddress];

    const http20Elapsed = nodes
      .map((node) => parseLatency(node.http20.elapsed))
      .filter((latency) => latency !== undefined) as number[];

    const grpcElapsed = nodes
      .map((node) => parseLatency(node.grpc.elapsed))
      .filter((latency) => latency !== undefined) as number[];

    const uptimePercentage = uptimePercentagesMap[operatorAddress];

    return {
      name: finalName,
      baseName: name,
      nodes,
      commissionPercentage: Number(commissionRateInBps) / 100,
      estimatedApr,
      isActive: operatorStatusMap[operatorAddress] === OPERATOR_STATUS_ACTIVE,
      metrics: {
        http20: http20Elapsed.length ? Math.round(getMedian(http20Elapsed)) : 0,
        grpc: grpcElapsed.length ? Math.round(getMedian(grpcElapsed)) : 0,
        grpc_start_time: nodes[0].grpc.start_time,
        uptime_percentage: uptimePercentage,
      },
      image:
        OPERATOR_NAME_TO_IMAGE?.[name as keyof typeof OPERATOR_NAME_TO_IMAGE] ??
        DEFAULT_OPERATOR_IMAGE,
      address: operatorAddress,
    } satisfies StakableOperator;
  });

  // sort by order of appearance while grouping
  const operatorOrder = Object.keys(operatorNameOccurency);
  operatorData.sort((a, b) => {
    return (
      operatorOrder.indexOf(a.baseName) - operatorOrder.indexOf(b.baseName)
    );
  });

  return operatorData;
}

function reduceNodesToOperatorMap(
  nodes: NodeData[]
): Record<string, NodeData[]> {
  return nodes.reduce<Record<string, NodeData[]>>((map, node) => {
    const operatorAddress = node.record.operator;
    if (!map[operatorAddress]) {
      map[operatorAddress] = [];
    }
    map[operatorAddress].push(node);
    return map;
  }, {});
}

export const getRiverNodesStatuses = async (
  riverNodes: RiverNode[]
): Promise<NodeData[]> => {
  let lastError;
  let attempts = 0;

  for (let i = 0; i < riverNodes.length; i++, attempts++) {
    const randomNode = riverNodes[i];

    try {
      const res = await fetch(`${randomNode.url}/debug/multi/json`, {
        signal: AbortSignal.timeout(3_500),
      });
      if (!res.ok)
        throw new Error(`${randomNode.url} failed with status: ${res.status}`);
      // we should be using nodeSchema.safeParse here... but we don't want this to suddenly break if the schema changes
      const data = (await res.json()) as z.infer<typeof nodesSchema>;
      return data.nodes;
    } catch (error) {
      lastError = error;
      console.warn(`Attempt ${i + 1} failed. Trying another node...`, error);
    }
  }

  throw new Error(
    `Failed to fetch node data after ${riverNodes.length} attempts. Last error: ${lastError}`
  );
};

const NODE_STATUS_ACTIVE = 2;

export interface RiverNode {
  url: string;
  status: number;
  nodeAddress: Address;
  operator: Address;
}

export const getRiverNodes = async (
  riverClient: PublicClient,
  config: TownsConfig
): Promise<RiverNode[]> => {
  try {
    const nodes = await riverClient.readContract({
      abi: riverRegistryAbi,
      address: config.river.chainConfig.addresses.riverRegistry as Address,
      functionName: "getAllNodes",
    });
    return nodes
      .filter((node) => node.status === NODE_STATUS_ACTIVE)
      .sort(() => Math.random() - 0.5);
  } catch (error) {
    console.error("Error fetching river nodes", error);
    throw new Error("Error fetching river nodes");
  }
};

export async function fetchOperatorStatus(
  env: TownsConfig,
  baseClient: PublicClient,
  operator: Address
): Promise<number> {
  try {
    const operatorStatus = await baseClient.readContract({
      abi: nodeOperatorAbi,
      address: env.base.chainConfig.addresses.baseRegistry as Address,
      functionName: "getOperatorStatus",
      args: [operator],
    });
    return operatorStatus;
  } catch (error) {
    console.error("Failed to read operator status:", error);
    throw new Error(
      "Failed to fetch operator data: unable to read operator status from contract"
    );
  }
}

export async function fetchNetworkApy(
  env: TownsConfig,
  baseClient: PublicClient
) {
  const baseRegistry = env.base.chainConfig.addresses.baseRegistry as Address;
  let stakingState;
  try {
    stakingState = await baseClient.readContract({
      address: baseRegistry,
      abi: rewardsDistributionAbi,
      functionName: "stakingState",
    });
  } catch (error) {
    console.error("Failed to read staking state:", error);
    throw new Error(
      "Failed to fetch operator data: unable to read staking state from contract"
    );
  }

  const networkApy = estimatedApyOfNetwork(
    stakingState.rewardRate,
    stakingState.totalStaked
  );
  return networkApy;
}

export async function fetchCommissionRate(
  env: TownsConfig,
  baseClient: PublicClient,
  operator: Address
): Promise<bigint> {
  try {
    const commissionRate = await baseClient.readContract({
      abi: nodeOperatorAbi,
      address: env.base.chainConfig.addresses.baseRegistry as Address,
      functionName: "getCommissionRate",
      args: [operator],
    });
    return commissionRate;
  } catch (error) {
    console.error("Failed to read commission rates:", error);
    throw new Error(
      "Failed to fetch operator data: unable to read commission rates from contract"
    );
  }
}

const riverOmega = defineChain({
  id: 550,
  name: "River",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://mainnet.rpc.river.build"],
    },
  },
});

const riverGamma = defineChain({
  id: 6524490,
  name: "River Gamma",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://devnet.rpc.river.build"],
    },
  },
  testnet: true,
});

const riverAlpha = defineChain({
  id: 6524490,
  name: "River Alpha",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://devnet.rpc.river.build"],
    },
  },
  testnet: true,
});

const riverDelta = defineChain({
  id: 6524490,
  name: "River Delta",
  nativeCurrency: {
    name: "Ether",
    symbol: "ETH",
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ["https://devnet.rpc.river.build"],
    },
  },
  testnet: true,
});

export const riverChains = {
  gamma: riverGamma,
  omega: riverOmega,
  alpha: riverAlpha,
  delta: riverDelta,
};

export const HOSTNAME_TO_OPERATOR_NAME: Record<string, string> = {
  localhost: "Localhost",
  "lgns.net": "Luganode",
  "towns-u4.com": "Unit410",
  "figment.io": "Figment",
  "axol.io": "Axol",
  "hnt-labs": "HNT Labs",
  "unit410.com": "Unit410",
  "towns.com": "Towns",
  "nansen.ai": "Nansen",
};

export const DEFAULT_OPERATOR_IMAGE = "";

export const OPERATOR_NAME_TO_IMAGE: Record<string, string> = {
  Luganode: "/assets/operator-luganode.png",
  Figment: "/assets/operator-figment.png",
  Axol: "/assets/operator-axol.png",
  "HNT Labs": "/assets/operator-hnt.jpg",
  Unit410: "/assets/operator-unit410.png",
  Towns: "/assets/operator-towns.svg",
  Framework: "/assets/operator-framework.png",
  Nansen: "/assets/operator-nansen.png",
  Localhost: DEFAULT_OPERATOR_IMAGE,
};

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("unhandled error:", e);
    process.exit(1);
  });
