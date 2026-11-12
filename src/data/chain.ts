/**
 * Read-only chain access for Robinhood Chain (4663). Every address here comes
 * from official sources (Uniswap v3 deployments page, Chainlink directory via
 * scripts/sync-feeds.mjs, Robinhood /rhj/assets); RPC URLs come from config,
 * never from user input. Nothing here signs or sends a transaction.
 */
import {
  createPublicClient,
  defineChain,
  fallback,
  getAddress,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import feedsJson from "./feeds.json";

export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDG_DECIMALS = 6;
/** https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments */
export const UNISWAP_V3_FACTORY: Address = getAddress("0x1f7d7550b1b028f7571e69a784071f0205fd2efa");
export const UNISWAP_V3_QUOTER_V2: Address = getAddress("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
export const FEE_TIERS = [500, 3000, 10000] as const;

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export interface FeedInfo {
  proxy: Address;
  decimals: number;
  heartbeat: number;
}
const FEEDS = (feedsJson as { feeds: Record<string, { proxy: string; decimals: number; heartbeat: number }> }).feeds;

export function feedFor(symbol: string): FeedInfo | null {
  const f = FEEDS[symbol.toUpperCase()];
  return f ? { proxy: getAddress(f.proxy), decimals: f.decimals, heartbeat: f.heartbeat } : null;
}

export function makeClient(rpcUrls: string[]): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: fallback(
      rpcUrls.map((u) => http(u, { timeout: 6_000, retryCount: 1 })),
      { rank: false },
    ),
    batch: { multicall: true },
  }) as PublicClient;
}

const TOKEN_ABI = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
  "function oraclePaused() view returns (bool)",
]);
const FEED_ABI = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
const FACTORY_ABI = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function token0() view returns (address)",
]);
const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);
const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

export type Maybe<T> = T | "unavailable";

export interface TokenState {
  uiMultiplier: Maybe<bigint>;
  newUIMultiplier: Maybe<bigint>;
  effectiveAt: Maybe<bigint>;
  oraclePaused: Maybe<boolean>;
}

export interface FeedRead {
  price: number; // USD per token, already multiplier-adjusted by Chainlink
  updatedAt: number; // unix seconds
}

export interface PoolRead {
  pool: Address;
  fee: number;
  mid: number; // USDG per token
  liquidity: bigint;
}

export interface QuoteRead {
  fee: number;
  amountIn: bigint;
  amountOut: bigint;
  execPrice: number; // USDG per token
}

/** The chain reads Preflight and Reopen Risk need. An interface so tests can fixture it. */
export interface ChainReader {
  tokenState(token: Address): Promise<TokenState>;
  feed(proxy: Address, decimals: number): Promise<FeedRead>;
  pools(token: Address, tokenDecimals?: number): Promise<PoolRead[]>;
  decimals(token: Address): Promise<number>;
  quote(token: Address, side: "buy" | "sell", sizeUsdg: number, refPrice: number, pools: PoolRead[]): Promise<QuoteRead | null>;
}

const settledValue = <T>(r: PromiseSettledResult<T>): Maybe<T> => (r.status === "fulfilled" ? r.value : "unavailable");

export class ViemChainReader implements ChainReader {
  constructor(private client: PublicClient) {}

  async tokenState(token: Address): Promise<TokenState> {
    const call = <T>(functionName: "uiMultiplier" | "newUIMultiplier" | "effectiveAt" | "oraclePaused") =>
      this.client.readContract({ address: token, abi: TOKEN_ABI, functionName }) as Promise<T>;
    const [a, b, c, d] = await Promise.allSettled([
      call<bigint>("uiMultiplier"),
      call<bigint>("newUIMultiplier"),
      call<bigint>("effectiveAt"),
      call<boolean>("oraclePaused"),
    ]);
    return { uiMultiplier: settledValue(a), newUIMultiplier: settledValue(b), effectiveAt: settledValue(c), oraclePaused: settledValue(d) };
  }

  async feed(proxy: Address, decimals: number): Promise<FeedRead> {
    const r = await this.client.readContract({ address: proxy, abi: FEED_ABI, functionName: "latestRoundData" });
    const answer = r[1];
    if (answer <= 0n) throw new Error("feed answer <= 0");
    return { price: Number(answer) / 10 ** decimals, updatedAt: Number(r[3]) };
  }

  async decimals(token: Address): Promise<number> {
    return Number(await this.client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }));
  }

  async pools(token: Address, tokenDecimals = 18): Promise<PoolRead[]> {
    const addrs = await Promise.all(
      FEE_TIERS.map((fee) =>
        this.client.readContract({ address: UNISWAP_V3_FACTORY, abi: FACTORY_ABI, functionName: "getPool", args: [token, USDG, fee] }),
      ),
    );
    const out: PoolRead[] = [];
    await Promise.all(
      addrs.map(async (pool, i) => {
        if (/^0x0{40}$/i.test(pool)) return;
        const [slot0, liquidity, token0] = await Promise.all([
          this.client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }),
          this.client.readContract({ address: pool, abi: POOL_ABI, functionName: "liquidity" }),
          this.client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }),
        ]);
        if (liquidity === 0n) return;
        out.push({ pool, fee: FEE_TIERS[i] as number, liquidity, mid: midFromSqrt(slot0[0], getAddress(token0) === getAddress(USDG), tokenDecimals) });
      }),
    );
    return out.sort((a, b) => (a.liquidity > b.liquidity ? -1 : 1));
  }

  async quote(token: Address, side: "buy" | "sell", sizeUsdg: number, refPrice: number, pools: PoolRead[]): Promise<QuoteRead | null> {
    const amountIn =
      side === "buy"
        ? BigInt(Math.round(sizeUsdg * 10 ** USDG_DECIMALS))
        : BigInt(Math.round((sizeUsdg / refPrice) * 1e6)) * 10n ** 12n; // token has 18 dp
    if (amountIn <= 0n) return null;
    const results = await Promise.allSettled(
      pools.map(async (p) => {
        const { result } = await this.client.simulateContract({
          address: UNISWAP_V3_QUOTER_V2,
          abi: QUOTER_ABI,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn: side === "buy" ? USDG : token, tokenOut: side === "buy" ? token : USDG, amountIn, fee: p.fee, sqrtPriceLimitX96: 0n }],
        });
        return { fee: p.fee, amountOut: result[0] };
      }),
    );
    let best: QuoteRead | null = null;
    for (const r of results) {
      if (r.status !== "fulfilled" || r.value.amountOut === 0n) continue;
      const q: QuoteRead = { fee: r.value.fee, amountIn, amountOut: r.value.amountOut, execPrice: execPrice(side, amountIn, r.value.amountOut) };
      // buy: lowest price paid wins; sell: highest price received wins
      if (!best || (side === "buy" ? q.execPrice < best.execPrice : q.execPrice > best.execPrice)) best = q;
    }
    return best;
  }
}

/** USDG per token from a v3 sqrtPriceX96 (USDG 6 dp; Stock Tokens 18 dp). */
export function midFromSqrt(sqrtPriceX96: bigint, usdgIsToken0: boolean, tokenDecimals = 18): number {
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1_raw per token0_raw
  const scale = 10 ** (tokenDecimals - USDG_DECIMALS);
  // usdgIsToken0: ratio = token_raw / usdg_raw, so tokens per USDG = ratio / scale
  return usdgIsToken0 ? scale / ratio : ratio * scale;
}

export function execPrice(side: "buy" | "sell", amountIn: bigint, amountOut: bigint): number {
  return side === "buy"
    ? Number(amountIn) / 1e6 / (Number(amountOut) / 1e18)
    : Number(amountOut) / 1e6 / (Number(amountIn) / 1e18);
}
