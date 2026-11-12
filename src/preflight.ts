/**
 * Stock Token Preflight: pure verdict engine. Facts in, verdict out; no I/O.
 * STOP if any STOP rule fires, CAUTION if any CAUTION rule fires, GO only when
 * every check passes. A check whose data is unavailable is not a pass.
 */
import type { Address } from "viem";
import { isFeedFreezeSession, type Session } from "./calendar";
import type { FeedRead, Maybe, PoolRead, QuoteRead, TokenState } from "./data/chain";
import type { CanonicalResult, RhQuote } from "./data/robinhood";
import { deploymentOn4663 } from "./data/robinhood";
import { PREFLIGHT_DISCLAIMER } from "./disclaimers";

export type Verdict = "GO" | "CAUTION" | "STOP";
export type ReasonCode =
  | "LOOKALIKE_OR_NOT_CANONICAL"
  | "NOT_ON_ROBINHOOD_CHAIN"
  | "ASSET_INACTIVE"
  | "TRADING_HALT"
  | "SESSION_CLOSED"
  | "PENDING_MULTIPLIER"
  | "ORACLE_PAUSED"
  | "STALE_FEED"
  | "WEEKEND_FEED_FREEZE"
  | "DEX_PREMIUM"
  | "PRICE_IMPACT"
  | "THIN_BOOK"
  | "DATA_UNAVAILABLE";

export interface Reason {
  code: ReasonCode;
  severity: "CAUTION" | "STOP";
  detail: string;
}

export interface Thresholds {
  staleFeedMinutes: number;
  premiumCautionBps: number;
  impactCautionBps: number;
  thinBookBps: number;
}

export interface PreflightFacts {
  query: { side: "buy" | "sell"; sizeUsdg: number | null; venue: string };
  canonical: CanonicalResult;
  now: number; // unix seconds
  session: Session;
  quote: Maybe<RhQuote | null>;
  token: Maybe<TokenState>;
  /** null = no Chainlink feed is published for this symbol. */
  feed: Maybe<FeedRead> | null;
  feedHeartbeat: number;
  pools: Maybe<PoolRead[]>;
  /** undefined = no size requested (checks-only path). */
  routeQuote?: Maybe<QuoteRead | null>;
  thresholds: Thresholds;
}

const fmtPct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const sessionCapKey: Partial<Record<Session, string>> = { regular: "market", extended: "extended", overnight: "overnight" };

export function runPreflight(f: PreflightFacts) {
  const reasons: Reason[] = [];
  const stop = (code: ReasonCode, detail: string) => reasons.push({ code, severity: "STOP", detail });
  const caution = (code: ReasonCode, detail: string) => reasons.push({ code, severity: "CAUTION", detail });

  // 1. Canonical address
  const c = f.canonical;
  if (c.kind !== "canonical") {
    if (c.kind === "not_on_chain") {
      stop("NOT_ON_ROBINHOOD_CHAIN", `${c.asset.tokenSymbol} has no official deployment on chain 4663.`);
    } else if (c.kind === "unknown_symbol") {
      stop("LOOKALIKE_OR_NOT_CANONICAL", `No official Stock Token with symbol ${c.symbol || "(none)"} in the Robinhood asset registry.`);
    } else {
      const real = c.symbolAsset;
      stop(
        "LOOKALIKE_OR_NOT_CANONICAL",
        real
          ? `${c.address ?? "This address"} is not the official ${real.tokenSymbol} Stock Token on chain 4663. A matching ticker at a different address is not a Robinhood Stock Token.`
          : `${c.address ?? "This address"} is not an official Stock Token deployment on chain 4663.`,
      );
    }
    const assetFor = c.kind === "not_on_chain" ? c.asset : c.kind === "lookalike" ? c.symbolAsset : null;
    return finish(reasons, {
      asset: {
        symbol: assetFor?.tokenSymbol ?? (c.kind === "unknown_symbol" ? c.symbol : null),
        name: assetFor?.tokenName ?? null,
        address: c.kind === "lookalike" ? c.address : null,
        canonical: false,
        officialAddress: assetFor ? deploymentOn4663(assetFor) : null,
        status: assetFor?.status ?? null,
        currentMultiplier: assetFor?.currentMultiplier ?? null,
        pendingMultiplier: assetFor?.pendingMultiplier ?? null,
        pendingMultiplierEffectiveTime: assetFor?.pendingMultiplierEffectiveTime ?? null,
      },
      market: null,
      oracle: null,
      route: { included: false, reason: "not evaluated for a non-canonical token" },
    });
  }

  const asset = c.asset;
  const address: Address = c.address;

  // 2. Asset status
  if (asset.status !== "ASSET_STATUS_ACTIVE") stop("ASSET_INACTIVE", `Registry status is ${asset.status || "unset"}.`);

  // 3. Halt and session
  const q = f.quote === "unavailable" ? null : f.quote;
  if (f.quote === "unavailable" || !q) caution("DATA_UNAVAILABLE", "Robinhood price/halt data could not be read for this call.");
  if (q?.isTradingHalt) stop("TRADING_HALT", "The underlier is in a trading halt (isTradingHalt = true).");
  const capKey = sessionCapKey[f.session];
  const cap = capKey ? asset.tradingCapabilities?.[capKey] : undefined;
  const capTradable = cap ? cap.whole === "TRADING_STATUS_TRADABLE" || cap.fractional === "TRADING_STATUS_TRADABLE" : capKey !== undefined;
  if (!capKey || !capTradable) {
    caution(
      "SESSION_CLOSED",
      `The underlier is not in a tradable US-equity session (${f.session}). Onchain swaps can still occur while the underlying market is closed.`,
    );
  }

  // 4. Pending multiplier
  const tok = f.token === "unavailable" ? null : f.token;
  if (!tok) caution("DATA_UNAVAILABLE", "Onchain token state could not be read for this call.");
  const onchainPending =
    tok &&
    typeof tok.uiMultiplier === "bigint" &&
    typeof tok.newUIMultiplier === "bigint" &&
    typeof tok.effectiveAt === "bigint" &&
    tok.newUIMultiplier !== tok.uiMultiplier &&
    tok.effectiveAt > BigInt(f.now);
  if (asset.pendingMultiplier || onchainPending) {
    const eff = asset.pendingMultiplierEffectiveTime ?? (tok && typeof tok.effectiveAt === "bigint" ? new Date(Number(tok.effectiveAt) * 1000).toISOString() : "unknown");
    caution(
      "PENDING_MULTIPLIER",
      `A multiplier change is pending: ${asset.currentMultiplier} → ${asset.pendingMultiplier || (tok && typeof tok.newUIMultiplier === "bigint" ? wadToString(tok.newUIMultiplier) : "?")}, effective ${eff}.`,
    );
  }

  // 5. oraclePaused (optional, not in the Robinhood docs)
  const oraclePaused = tok ? tok.oraclePaused : "unavailable";
  if (oraclePaused === true) caution("ORACLE_PAUSED", "The token reports oraclePaused() = true (corporate action processing).");

  // 6. Chainlink staleness against the market calendar
  const feed = f.feed === null || f.feed === "unavailable" ? null : f.feed;
  const freezeSession = isFeedFreezeSession(f.session);
  let stale = false;
  if (f.feed === null) caution("DATA_UNAVAILABLE", `No Chainlink feed is published for ${asset.tokenSymbol} on chain 4663.`);
  else if (!feed) caution("DATA_UNAVAILABLE", "The Chainlink feed could not be read for this call.");
  else {
    const ageMin = (f.now - feed.updatedAt) / 60;
    if (freezeSession) {
      caution(
        "WEEKEND_FEED_FREEZE",
        `Chainlink last updated ${new Date(feed.updatedAt * 1000).toISOString()}. Stock Token feeds run 24/5 and freeze outside the session while the token can still trade. Expected, not a stale-feed failure.`,
      );
    } else if (f.session === "regular" && ageMin > f.thresholds.staleFeedMinutes) {
      stale = true;
      caution("STALE_FEED", `Feed is ${Math.round(ageMin)} min old during the regular session (threshold ${f.thresholds.staleFeedMinutes} min).`);
    } else if (f.session !== "regular" && ageMin * 60 > f.feedHeartbeat + 3600) {
      stale = true;
      caution("STALE_FEED", `Feed is ${Math.round(ageMin)} min old, past its ${f.feedHeartbeat / 3600} h heartbeat.`);
    }
  }

  // 7. DEX premium and price impact
  const pools = f.pools === "unavailable" ? null : f.pools;
  if (!pools) caution("DATA_UNAVAILABLE", "Uniswap pool data could not be read for this call; DEX premium not evaluated.");
  const best = pools?.[0] ?? null;
  let premiumBps: number | null = null;
  if (best && feed) {
    premiumBps = Math.round(((best.mid - feed.price) / feed.price) * 10_000);
    if (Math.abs(premiumBps) > f.thresholds.premiumCautionBps) {
      caution(
        "DEX_PREMIUM",
        `Uniswap mid is ${fmtPct(Math.abs(premiumBps))} ${premiumBps > 0 ? "above" : "below"} the Chainlink mark (caution threshold ${fmtPct(f.thresholds.premiumCautionBps)}).`,
      );
    }
  }
  let route: Record<string, unknown>;
  if (f.query.sizeUsdg === null) {
    route = { included: false, dexPrice: best ? best.mid.toFixed(4) : null, premiumBps, venue: best ? "uniswap" : null, note: "No sizeUsdg: impact and depth not evaluated." };
  } else if (!pools || pools.length === 0) {
    route = {
      included: false,
      dexPrice: null,
      premiumBps: null,
      venue: null,
      note: pools ? "No Uniswap v3 pool pairs this token with USDG; impact omitted." : "Pool data could not be read; impact omitted.",
    };
  } else {
    const rq = f.routeQuote === "unavailable" || f.routeQuote === undefined ? null : f.routeQuote;
    const mid = best!.mid;
    const impactBps = rq ? Math.round((Math.abs(rq.execPrice - mid) / mid) * 10_000) : null;
    const fitsSize = !!rq && impactBps !== null && impactBps <= f.thresholds.thinBookBps;
    if (!fitsSize) caution("THIN_BOOK", `A ${f.query.sizeUsdg} USDG ${f.query.side} does not fit the available onchain depth.`);
    else if (impactBps! > f.thresholds.impactCautionBps) {
      caution("PRICE_IMPACT", `Price impact for ${f.query.sizeUsdg} USDG is ${fmtPct(impactBps!)} (caution threshold ${fmtPct(f.thresholds.impactCautionBps)}).`);
    }
    route = {
      included: true,
      dexPrice: mid.toFixed(4),
      execPrice: rq ? rq.execPrice.toFixed(4) : null,
      premiumBps,
      impactBps,
      fitsSize,
      feeTier: rq?.fee ?? null,
      venue: "uniswap",
    };
  }

  const mult = Number(asset.currentMultiplier) || null;
  return finish(reasons, {
    asset: {
      symbol: asset.tokenSymbol,
      name: asset.tokenName,
      address,
      canonical: true,
      status: asset.status,
      currentMultiplier: asset.currentMultiplier,
      pendingMultiplier: asset.pendingMultiplier,
      pendingMultiplierEffectiveTime: asset.pendingMultiplierEffectiveTime ?? null,
    },
    market: {
      isTradingHalt: q ? q.isTradingHalt : null,
      session: f.session,
      bid: q?.bid ?? null,
      ask: q?.ask ?? null,
      pricesAreUnderlierRaw: true,
      // REST bid/ask are raw underlier prices; × currentMultiplier for a per-token comparison.
      bidPerToken: q && mult ? (Number(q.bid) * mult).toFixed(4) : null,
      askPerToken: q && mult ? (Number(q.ask) * mult).toFixed(4) : null,
      generatedAt: q?.generatedAt ?? null,
    },
    oracle: {
      chainlink: feed ? feed.price.toFixed(4) : null,
      updatedAt: feed?.updatedAt ?? null,
      stale,
      weekendFreeze: !!feed && freezeSession,
      oraclePaused,
    },
    route,
  });
}

type Section = Record<string, unknown>;
export interface PreflightBody {
  asset: Section;
  market: Section | null;
  oracle: Section | null;
  route: Section;
}

function finish(reasons: Reason[], body: PreflightBody): PreflightBody & { verdict: Verdict; reasons: Reason[]; disclaimer: string } {
  const verdict: Verdict = reasons.some((r) => r.severity === "STOP") ? "STOP" : reasons.length ? "CAUTION" : "GO";
  return { verdict, reasons, ...body, disclaimer: PREFLIGHT_DISCLAIMER };
}

export function wadToString(w: bigint): string {
  const s = w.toString().padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18).replace(/0+$/, "") || "0"}`;
}
