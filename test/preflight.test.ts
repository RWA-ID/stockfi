import { describe, expect, it } from "vitest";
import { sessionAt } from "../src/calendar";
import type { FeedRead, Maybe, PoolRead, QuoteRead, TokenState } from "../src/data/chain";
import { resolveCanonical, type RhAsset, type RhQuote } from "../src/data/robinhood";
import { runPreflight, type PreflightFacts } from "../src/preflight";
import { AAPL_ADDR, FAKE_ADDR, REGULAR, SATURDAY, asset, pool, quote, sec, tokenState } from "./fixtures";

const T = { staleFeedMinutes: 30, premiumCautionBps: 100, impactCautionBps: 200, thinBookBps: 1000 };

function facts(o: {
  assets?: RhAsset[];
  q?: { address?: string; symbol?: string };
  at?: Date;
  quote?: Maybe<RhQuote | null>;
  token?: Maybe<TokenState>;
  feed?: Maybe<FeedRead> | null;
  pools?: Maybe<PoolRead[]>;
  sizeUsdg?: number | null;
  routeQuote?: Maybe<QuoteRead | null>;
}): PreflightFacts {
  const at = o.at ?? REGULAR;
  return {
    query: { side: "buy", sizeUsdg: o.sizeUsdg ?? null, venue: "any" },
    canonical: resolveCanonical(o.assets ?? [asset()], o.q ?? { symbol: "AAPL" }),
    now: sec(at),
    session: sessionAt(at),
    quote: o.quote ?? quote(),
    token: o.token ?? tokenState(),
    feed: o.feed === undefined ? { price: 355.05, updatedAt: sec(at) - 120 } : o.feed,
    feedHeartbeat: 86400,
    pools: o.pools ?? [pool(355.06)],
    routeQuote: o.routeQuote,
    thresholds: T,
  };
}

const codes = (r: ReturnType<typeof runPreflight>) => r.reasons.map((x) => x.code);

describe("Preflight verdicts", () => {
  it("canonical pass → GO with facts and disclaimer", () => {
    const r = runPreflight(facts({}));
    expect(r.verdict).toBe("GO");
    expect(r.reasons).toEqual([]);
    expect(r.asset).toMatchObject({ symbol: "AAPL", canonical: true, address: AAPL_ADDR });
    expect(r.market).toMatchObject({ pricesAreUnderlierRaw: true, session: "regular" });
    expect(r.disclaimer).toMatch(/Not investment advice/);
    expect(r.disclaimer).toMatch(/not intended for U\.S\. persons/);
  });

  it("matching ticker at a different address → STOP LOOKALIKE_OR_NOT_CANONICAL, names the official address", () => {
    const r = runPreflight(facts({ q: { address: FAKE_ADDR, symbol: "AAPL" } }));
    expect(r.verdict).toBe("STOP");
    expect(codes(r)).toEqual(["LOOKALIKE_OR_NOT_CANONICAL"]);
    expect(r.asset).toMatchObject({ canonical: false, officialAddress: AAPL_ADDR });
  });

  it("unknown address alone → STOP", () => {
    expect(runPreflight(facts({ q: { address: FAKE_ADDR } })).verdict).toBe("STOP");
  });

  it("canonical address with a mismatched symbol → STOP (symbol is a consistency check)", () => {
    const r = runPreflight(facts({ q: { address: AAPL_ADDR, symbol: "NVDA" } }));
    expect(codes(r)).toEqual(["LOOKALIKE_OR_NOT_CANONICAL"]);
  });

  it("unknown symbol → STOP", () => {
    expect(codes(runPreflight(facts({ q: { symbol: "ZZZZ" } })))).toEqual(["LOOKALIKE_OR_NOT_CANONICAL"]);
  });

  it("symbol without a chain-4663 deployment → STOP NOT_ON_ROBINHOOD_CHAIN", () => {
    const a = asset({ deployments: [{ contractAddress: AAPL_ADDR, chainId: 1 }] });
    expect(codes(runPreflight(facts({ assets: [a] })))).toEqual(["NOT_ON_ROBINHOOD_CHAIN"]);
  });

  it("inactive asset → STOP ASSET_INACTIVE", () => {
    const r = runPreflight(facts({ assets: [asset({ status: "ASSET_STATUS_INACTIVE" })] }));
    expect(r.verdict).toBe("STOP");
    expect(codes(r)).toContain("ASSET_INACTIVE");
  });

  it("trading halt → STOP TRADING_HALT", () => {
    const r = runPreflight(facts({ quote: quote({ isTradingHalt: true }) }));
    expect(r.verdict).toBe("STOP");
    expect(codes(r)).toContain("TRADING_HALT");
  });

  it("weekend feed freeze → CAUTION WEEKEND_FEED_FREEZE, never STOP or STALE_FEED", () => {
    const friday4pm = sec(new Date("2026-11-13T21:00:00Z"));
    const r = runPreflight(facts({ at: SATURDAY, feed: { price: 355.05, updatedAt: friday4pm } }));
    expect(r.verdict).toBe("CAUTION");
    expect(codes(r)).toContain("WEEKEND_FEED_FREEZE");
    expect(codes(r)).toContain("SESSION_CLOSED");
    expect(codes(r)).not.toContain("STALE_FEED");
    expect(r.oracle).toMatchObject({ weekendFreeze: true, stale: false });
  });

  it("stale feed during the regular session → CAUTION STALE_FEED", () => {
    const r = runPreflight(facts({ feed: { price: 355.05, updatedAt: sec(REGULAR) - 45 * 60 } }));
    expect(r.verdict).toBe("CAUTION");
    expect(codes(r)).toEqual(["STALE_FEED"]);
  });

  it("pending multiplier from /assets → CAUTION PENDING_MULTIPLIER", () => {
    const a = asset({ pendingMultiplier: "2.002181233930777320", pendingMultiplierEffectiveTime: "2026-11-20T13:00:00Z" });
    const r = runPreflight(facts({ assets: [a] }));
    expect(r.verdict).toBe("CAUTION");
    expect(codes(r)).toEqual(["PENDING_MULTIPLIER"]);
    expect(r.reasons[0]?.detail).toMatch(/2026-11-20/);
  });

  it("pending multiplier seen only onchain → CAUTION", () => {
    const tok = tokenState({ newUIMultiplier: 2n * 10n ** 18n, effectiveAt: BigInt(sec(REGULAR) + 86400) });
    expect(codes(runPreflight(facts({ token: tok })))).toEqual(["PENDING_MULTIPLIER"]);
  });

  it("DEX premium above threshold → CAUTION DEX_PREMIUM", () => {
    const r = runPreflight(facts({ pools: [pool(360.05)] })); // +1.41%
    expect(codes(r)).toEqual(["DEX_PREMIUM"]);
    expect((r.route as { premiumBps: number }).premiumBps).toBe(141);
  });

  it("premium under threshold → no reason", () => {
    expect(runPreflight(facts({ pools: [pool(357.5)] })).verdict).toBe("GO"); // +0.69%
  });

  it("price impact above threshold → CAUTION PRICE_IMPACT", () => {
    const r = runPreflight(facts({ sizeUsdg: 5000, routeQuote: { fee: 500, amountIn: 1n, amountOut: 1n, execPrice: 365 } }));
    expect(codes(r)).toEqual(["PRICE_IMPACT"]);
    expect(r.route).toMatchObject({ included: true, fitsSize: true });
  });

  it("size that does not fit → CAUTION THIN_BOOK", () => {
    expect(codes(runPreflight(facts({ sizeUsdg: 9e6, routeQuote: null })))).toEqual(["THIN_BOOK"]);
  });

  it("no pool → route omitted, not a failure", () => {
    const r = runPreflight(facts({ sizeUsdg: 5000, pools: [] }));
    expect(r.verdict).toBe("GO");
    expect(r.route).toMatchObject({ included: false });
  });

  it("missing optional oraclePaused → reported unavailable, verdict unaffected", () => {
    const r = runPreflight(facts({ token: tokenState({ oraclePaused: "unavailable" }) }));
    expect(r.verdict).toBe("GO");
    expect(r.oracle).toMatchObject({ oraclePaused: "unavailable" });
  });

  it("oraclePaused true → CAUTION ORACLE_PAUSED", () => {
    expect(codes(runPreflight(facts({ token: tokenState({ oraclePaused: true }) })))).toEqual(["ORACLE_PAUSED"]);
  });

  it("unreadable required data is never a pass", () => {
    const r = runPreflight(facts({ quote: "unavailable", feed: "unavailable", pools: "unavailable" }));
    expect(r.verdict).toBe("CAUTION");
    expect(codes(r).filter((c) => c === "DATA_UNAVAILABLE")).toHaveLength(3);
  });

  it("STOP outranks CAUTION", () => {
    const r = runPreflight(facts({ at: SATURDAY, quote: quote({ isTradingHalt: true }) }));
    expect(r.verdict).toBe("STOP");
  });
});
