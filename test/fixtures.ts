import type { Address } from "viem";
import type { ChainReader, FeedRead, PoolRead, QuoteRead, TokenState } from "../src/data/chain";
import type { LbGuard, LbPosition, LongbowSource } from "../src/data/longbow";
import type { RhAsset, RhQuote } from "../src/data/robinhood";
import { RobinhoodApi } from "../src/data/robinhood";

export const AAPL_ADDR: Address = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";
export const NVDA_ADDR: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
export const FAKE_ADDR: Address = "0x1111111111111111111111111111111111111111";

export function asset(over: Partial<RhAsset> = {}): RhAsset {
  return {
    id: "0x01",
    tokenSymbol: "AAPL",
    tokenName: "Apple • Robinhood Token",
    deployments: [{ contractAddress: AAPL_ADDR, chainId: 4663, networkName: "Robinhood Chain" }],
    currentMultiplier: "1.001090616965388660",
    pendingMultiplier: "",
    status: "ASSET_STATUS_ACTIVE",
    tradingCapabilities: {
      market: { whole: "TRADING_STATUS_TRADABLE", fractional: "TRADING_STATUS_TRADABLE" },
      extended: { whole: "TRADING_STATUS_TRADABLE", fractional: "TRADING_STATUS_TRADABLE" },
      overnight: { whole: "TRADING_STATUS_TRADABLE", fractional: "TRADING_STATUS_TRADABLE" },
    },
    ...over,
  };
}

export function quote(over: Partial<RhQuote> = {}): RhQuote {
  return { tokenSymbol: "AAPL", bid: "354.6", ask: "354.88", isTradingHalt: false, generatedAt: "2026-11-12T15:00:00Z", ...over };
}

export const W = 10n ** 18n;
export function tokenState(over: Partial<TokenState> = {}): TokenState {
  return { uiMultiplier: 1001090616965388660n, newUIMultiplier: 1001090616965388660n, effectiveAt: 1794449600n, oraclePaused: false, ...over };
}

/** Wednesday 2026-11-11 11:00 ET (regular session). */
export const REGULAR = new Date("2026-11-11T16:00:00Z");
/** Saturday 2026-11-14 12:00 ET. */
export const SATURDAY = new Date("2026-11-14T17:00:00Z");

export const sec = (d: Date) => Math.floor(d.getTime() / 1000);

export function pool(mid: number, fee = 500): PoolRead {
  return { pool: "0xAae0d815EE56e4092a5E5C2911E676Fea50B2d6D", fee, mid, liquidity: 10n ** 17n };
}

/** Fixture rhj API: serves /assets and /prices/{sym} from memory, counts calls. */
export function fakeRh(assets: RhAsset[], quotes: Record<string, RhQuote | null> = { AAPL: quote() }) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    const u = String(input);
    calls.push(u);
    if (u.endsWith("/assets")) return Response.json({ assets });
    const sym = decodeURIComponent(u.split("/prices/")[1] ?? "");
    const q = quotes[sym];
    if (!q) return Response.json({ code: 5 }, { status: 404 });
    return Response.json({ quotes: [q] });
  }) as typeof fetch;
  // unique base per instance so the in-isolate cache never leaks between tests
  return { api: new RobinhoodApi(`https://rh.test/${Math.random()}`, fetchFn), calls };
}

export interface FakeChainOpts {
  token?: TokenState | Error;
  feed?: FeedRead | Error;
  pools?: PoolRead[] | Error;
  quote?: QuoteRead | null;
}

export function fakeChain(o: FakeChainOpts = {}): ChainReader {
  const val = <T>(v: T | Error | undefined, d: T): Promise<T> => (v instanceof Error ? Promise.reject(v) : Promise.resolve(v === undefined ? d : v));
  return {
    tokenState: () => val(o.token, tokenState()),
    feed: () => val(o.feed, { price: 355.05, updatedAt: sec(REGULAR) - 60 }),
    pools: () => val(o.pools, [pool(355.06)]),
    decimals: async () => 18,
    quote: async () => (o.quote === undefined ? { fee: 500, amountIn: 1n, amountOut: 1n, execPrice: 356.11 } : o.quote),
  };
}

export function lbPosition(over: Partial<LbPosition> = {}): LbPosition {
  return {
    market: "META / USDG",
    marketId: "0x3d1b0bb7aab4ab37d52b0f4c96a27f1c7ccfd7b6a9e0a1c1a2c9b1d0e8f1e2a3",
    collateralToken: "0xc0d6457c16cc70d6790dd43521c899c87ce02f35",
    collateralSymbol: "META",
    collateral: 10,
    collateralValueUSDG: 6255.105,
    borrowed: 2500,
    health: 1.5638,
    liquidatable: false,
    loan: "USDG",
    liquidationPriceUSDG: 400,
    currentPriceUSDG: 625.5105,
    maxLTV: 0.625,
    ...over,
  };
}

export function fakeLongbow(positions: LbPosition[], guard: LbGuard | "unavailable" = { enrolled: false, status: null, config: null }, markets = [] as ReturnType<LongbowSource["markets"]>): LongbowSource {
  return {
    positions: async () => ({ positions, source: "mcp" }),
    guard: async () => guard,
    markets: () => markets,
  };
}
