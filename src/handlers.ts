/**
 * Fact gathering for the two services. Input is validated here, before any
 * 402, so a malformed request is never charged. All upstream reads fan out in
 * parallel; a failed optional read becomes "unavailable", never a guess.
 */
import { getAddress, isAddress, type Address } from "viem";
import { isFeedFreezeSession, sessionAt } from "./calendar";
import type { Config } from "./env";
import { feedFor, type ChainReader, type FeedRead, type Maybe, type PoolRead, type QuoteRead, type TokenState } from "./data/chain";
import type { LongbowSource } from "./data/longbow";
import { deploymentOn4663, resolveCanonical, type RhQuote, type RobinhoodApi } from "./data/robinhood";
import { runPreflight } from "./preflight";
import { buildReopen, type PositionFacts } from "./reopen";
import { weekendSummary } from "./summary";

export interface Deps {
  cfg: Config;
  rh: RobinhoodApi;
  chain: ChainReader;
  longbow: LongbowSource;
  now?: () => Date;
}

export class BadRequest extends Error {}

const settle = <T>(r: PromiseSettledResult<T>): Maybe<T> => (r.status === "fulfilled" ? r.value : "unavailable");

// ---- Preflight --------------------------------------------------------------

export interface PreflightQuery {
  address: Address | null;
  symbol: string | null;
  side: "buy" | "sell";
  sizeUsdg: number | null;
  venue: "uniswap" | "rfq" | "any";
}

export function parsePreflight(u: URL, quotePath: boolean): PreflightQuery {
  const q = u.searchParams;
  const rawAddr = q.get("address")?.trim() || null;
  const rawSym = q.get("symbol")?.trim().toUpperCase() || null;
  if (!rawAddr && !rawSym) throw new BadRequest("Send `address` (Stock Token on chain 4663) or `symbol` (e.g. AAPL).");
  if (rawAddr && !isAddress(rawAddr, { strict: false })) throw new BadRequest("`address` is not a valid EVM address.");
  if (rawSym && !/^[A-Z0-9.]{1,12}$/.test(rawSym)) throw new BadRequest("`symbol` must be a ticker like AAPL (no X prefix).");
  const side = (q.get("side") ?? "buy").toLowerCase();
  if (side !== "buy" && side !== "sell") throw new BadRequest("`side` must be buy or sell.");
  const venue = (q.get("venue") ?? "any").toLowerCase();
  if (venue !== "uniswap" && venue !== "rfq" && venue !== "any") throw new BadRequest("`venue` must be uniswap, rfq or any.");
  const sizeRaw = q.get("sizeUsdg");
  let sizeUsdg: number | null = null;
  if (sizeRaw !== null && sizeRaw !== "") {
    sizeUsdg = Number(sizeRaw);
    if (!Number.isFinite(sizeUsdg) || sizeUsdg <= 0 || sizeUsdg > 10_000_000) throw new BadRequest("`sizeUsdg` must be a positive number up to 10,000,000.");
  }
  if (quotePath && sizeUsdg === null) throw new BadRequest("/v1/preflight/quote needs `sizeUsdg`.");
  return { address: rawAddr ? getAddress(rawAddr.toLowerCase()) : null, symbol: rawSym, side, sizeUsdg, venue };
}

export async function computePreflight(q: PreflightQuery, d: Deps) {
  const now = d.now?.() ?? new Date();
  const assets = await d.rh.assets(); // required: canonical check cannot run without it
  const canonical = resolveCanonical(assets, q);
  const session = sessionAt(now);
  const thresholds = d.cfg;

  let quote: Maybe<RhQuote | null> = "unavailable";
  let token: Maybe<TokenState> = "unavailable";
  let feed: Maybe<FeedRead> | null = null;
  let pools: Maybe<PoolRead[]> = "unavailable";
  let routeQuote: Maybe<QuoteRead | null> | undefined;
  let feedHeartbeat = 86_400;

  if (canonical.kind === "canonical") {
    const sym = canonical.asset.tokenSymbol;
    const f = feedFor(sym);
    if (f) feedHeartbeat = f.heartbeat;
    const [qr, tr, fr, pr] = await Promise.allSettled([
      d.rh.price(sym),
      d.chain.tokenState(canonical.address),
      f ? d.chain.feed(f.proxy, f.decimals) : Promise.resolve(null),
      d.chain.pools(canonical.address),
    ]);
    quote = settle(qr);
    token = settle(tr);
    feed = f ? (settle(fr) as Maybe<FeedRead>) : null;
    pools = settle(pr);
    if (q.sizeUsdg !== null && pools !== "unavailable" && pools.length > 0) {
      const ref = feed && feed !== "unavailable" ? feed.price : pools[0]!.mid;
      routeQuote = settle(await Promise.allSettled([d.chain.quote(canonical.address, q.side, q.sizeUsdg, ref, pools)]).then((r) => r[0]!));
    }
  }

  return runPreflight({
    query: { side: q.side, sizeUsdg: q.sizeUsdg, venue: q.venue },
    canonical,
    now: Math.floor(now.getTime() / 1000),
    session,
    quote,
    token,
    feed,
    feedHeartbeat,
    pools,
    routeQuote,
    thresholds: {
      staleFeedMinutes: thresholds.staleFeedMinutes,
      premiumCautionBps: thresholds.premiumCautionBps,
      impactCautionBps: thresholds.impactCautionBps,
      thinBookBps: thresholds.thinBookBps,
    },
  });
}

// ---- Reopen Risk --------------------------------------------------------------

export function parseReopen(u: URL, weekendPath: boolean): { wallet: Address; report: "snapshot" | "weekend" } {
  const w = u.searchParams.get("wallet")?.trim();
  if (!w || !isAddress(w, { strict: false })) throw new BadRequest("`wallet` (0x… address on chain 4663) is required.");
  const r = (u.searchParams.get("report") ?? (weekendPath ? "weekend" : "snapshot")).toLowerCase();
  if (r !== "snapshot" && r !== "weekend") throw new BadRequest("`report` must be snapshot or weekend.");
  if (weekendPath && r !== "weekend") throw new BadRequest("/v1/reopen-risk/weekend is the weekend report.");
  return { wallet: getAddress(w.toLowerCase()), report: r };
}

export function oracleKind(label: string): { kind: PositionFacts["oracleKind"]; feedSymbol: string | null } {
  const m = /^Chainlink ([A-Z.]+)\/USD$/.exec(label.trim());
  if (m && feedFor(m[1] as string)) return { kind: "chainlink-24/5", feedSymbol: m[1] as string };
  if (/^Uniswap V3 TWAP/i.test(label)) return { kind: "uniswap-twap", feedSymbol: null };
  return { kind: "other", feedSymbol: null };
}

export async function computeReopen(q: { wallet: Address; report: "snapshot" | "weekend" }, d: Deps) {
  const now = d.now?.() ?? new Date();
  const session = sessionAt(now);
  const [posR, guardR, assetsR] = await Promise.allSettled([d.longbow.positions(q.wallet), d.longbow.guard(q.wallet), d.rh.assets()]);
  if (posR.status === "rejected") throw new Error("Longbow positions unavailable (MCP and onchain fallback both failed)");
  const { positions, source } = posR.value;
  const guard = guardR.status === "fulfilled" ? guardR.value : "unavailable";
  const canonicalSet = new Set(assetsR.status === "fulfilled" ? assetsR.value.map(deploymentOn4663).filter((x): x is Address => !!x) : []);
  const meta = new Map(d.longbow.markets().map((m) => [m.marketId.toLowerCase(), m]));

  let excluded = 0;
  const facts = await Promise.all(
    positions.map(async (p): Promise<PositionFacts | null> => {
      const m = meta.get(String(p.marketId).toLowerCase());
      const token = getAddress(p.collateralToken);
      const canonical = canonicalSet.has(token);
      const ok = oracleKind(m?.oracleLabel ?? "");
      if (!canonical && ok.kind !== "chainlink-24/5") {
        excluded++;
        return null;
      }
      const f = ok.feedSymbol ? feedFor(ok.feedSymbol) : null;
      const [fr, pr] = await Promise.allSettled([
        f ? d.chain.feed(f.proxy, f.decimals) : Promise.resolve(null),
        (canonical ? Promise.resolve(18) : d.chain.decimals(token)).then((dec) => d.chain.pools(token, dec)),
      ]);
      const chainlink = fr.status === "fulfilled" ? fr.value : null;
      const pools = pr.status === "fulfilled" ? pr.value : [];
      return {
        position: p,
        canonical,
        oracleKind: ok.kind,
        chainlink,
        weekendFreeze: ok.kind === "chainlink-24/5" && isFeedFreezeSession(session),
        dexPrice: pools[0]?.mid ?? null,
      };
    }),
  );

  const report = buildReopen({
    wallet: q.wallet,
    asOf: now,
    session,
    report: q.report,
    positions: facts.filter((x): x is PositionFacts => !!x),
    excludedPositions: excluded,
    guard,
    stressPcts: d.cfg.stressPcts,
    safeBufferHf: d.cfg.safeBufferHf,
    guardSuggestHf: d.cfg.guardSuggestHf,
    source,
  });
  if (q.report !== "weekend") return report;
  const s = await weekendSummary(report, { apiKey: d.cfg.anthropicKey, model: d.cfg.summaryModel });
  return { ...report, ...s };
}
