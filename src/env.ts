import { getAddress, type Address } from "viem";
import { scanMode, type ScanMode } from "./delivery";

/** Worker bindings. Secrets via `wrangler secret put`; the rest in wrangler.toml [vars]. */
export interface Env {
  ASSETS?: Fetcher;
  // payment
  PAY_TO: string;
  PAYEE_NAME?: string;
  FACILITATOR_URL?: string;
  PUBLIC_ORIGIN?: string;
  PRICE_PREFLIGHT?: string;
  PRICE_PREFLIGHT_QUOTE?: string;
  PRICE_REOPEN?: string;
  PRICE_REOPEN_WEEKEND?: string;
  /** Secret: x402Fi's per-listing upstream secret (sent as X-X402Fi-Secret). */
  UPSTREAM_KEY?: string;
  // data sources (config only, never from user input)
  ROBINHOOD_RPC_URL?: string;
  PUBLIC_RPC_URL?: string;
  ROBINHOOD_API_BASE?: string;
  LONGBOW_MCP_URL?: string;
  // thresholds
  STALE_FEED_MINUTES?: string;
  PREMIUM_CAUTION_BPS?: string;
  IMPACT_CAUTION_BPS?: string;
  THIN_BOOK_BPS?: string;
  STRESS_PCTS?: string;
  SAFE_BUFFER_HF?: string;
  GUARD_SUGGEST_HF?: string;
  // weekend summary
  DELIVERY_SCAN?: string;
  ANTHROPIC_API_KEY?: string;
  SUMMARY_MODEL?: string;
}

export interface Config {
  payTo: Address;
  payeeName: string | null;
  facilitatorUrl: string;
  publicOrigin: string;
  prices: { preflight: bigint; preflightQuote: bigint; reopen: bigint; reopenWeekend: bigint };
  upstreamKey: string | null;
  rpcUrls: string[];
  robinhoodApi: string;
  longbowMcp: string;
  staleFeedMinutes: number;
  premiumCautionBps: number;
  impactCautionBps: number;
  thinBookBps: number;
  stressPcts: number[];
  safeBufferHf: number;
  guardSuggestHf: number;
  deliveryScan: ScanMode;
  anthropicKey: string | null;
  summaryModel: string;
}

/** "$0.02" | "0.02" → atomic USDG (6 dp). */
export function usdToAtomic(input: string): bigint {
  const s = input.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`bad price: ${input}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w as string) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

export function atomicToUsd(a: bigint): string {
  const w = a / 1_000_000n;
  const f = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${w}.${f.padEnd(2, "0")}`;
}

const num = (v: string | undefined, d: number) => {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

export function loadConfig(env: Env): Config {
  const rpcUrls = [env.ROBINHOOD_RPC_URL, env.PUBLIC_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"].filter(
    (u): u is string => !!u,
  );
  return {
    payTo: getAddress(env.PAY_TO),
    payeeName: env.PAYEE_NAME?.trim() || null,
    facilitatorUrl: (env.FACILITATOR_URL ?? "https://x402fi.dev/api/facilitator").replace(/\/$/, ""),
    publicOrigin: (env.PUBLIC_ORIGIN ?? "https://stockfi.trade").replace(/\/$/, ""),
    prices: {
      preflight: usdToAtomic(env.PRICE_PREFLIGHT ?? "0.02"),
      preflightQuote: usdToAtomic(env.PRICE_PREFLIGHT_QUOTE ?? "0.05"),
      reopen: usdToAtomic(env.PRICE_REOPEN ?? "0.03"),
      reopenWeekend: usdToAtomic(env.PRICE_REOPEN_WEEKEND ?? "0.10"),
    },
    upstreamKey: env.UPSTREAM_KEY?.trim() || null,
    rpcUrls,
    robinhoodApi: (env.ROBINHOOD_API_BASE ?? "https://api.robinhood.com/rhj").replace(/\/$/, ""),
    longbowMcp: env.LONGBOW_MCP_URL ?? "https://mcp.longbow.finance/mcp",
    staleFeedMinutes: num(env.STALE_FEED_MINUTES, 30),
    premiumCautionBps: num(env.PREMIUM_CAUTION_BPS, 100),
    impactCautionBps: num(env.IMPACT_CAUTION_BPS, 200),
    thinBookBps: num(env.THIN_BOOK_BPS, 1000),
    stressPcts: (env.STRESS_PCTS ?? "20,40")
      .split(",")
      .map((x) => Number(x.trim()))
      .filter((x) => Number.isFinite(x) && x > 0 && x < 100),
    safeBufferHf: num(env.SAFE_BUFFER_HF, 1.1),
    guardSuggestHf: num(env.GUARD_SUGGEST_HF, 1.25),
    deliveryScan: scanMode(env.DELIVERY_SCAN),
    anthropicKey: env.ANTHROPIC_API_KEY?.trim() || null,
    summaryModel: env.SUMMARY_MODEL ?? "claude-haiku-5-5",
  };
}
