/**
 * Public Robinhood Stock Token REST API (https://docs.robinhood.com/chain/stock-token-apis/).
 * Rate limit 60 req/s; responses carry no Cache-Control, so we cache in-isolate:
 * assets 60 s, prices 15 s (the documented price cache window).
 */
import { getAddress, isAddress, type Address } from "viem";

export const CHAIN_ID = 4663;

export interface RhAsset {
  id: string;
  tokenSymbol: string;
  tokenName: string;
  deployments: { contractAddress: string; chainId: number; networkName?: string }[];
  currentMultiplier: string;
  pendingMultiplier: string;
  pendingMultiplierEffectiveTime?: string;
  status: string;
  tradingCapabilities?: Record<string, { whole?: string; fractional?: string }>;
  tokenDecimals?: number;
}

export interface RhQuote {
  tokenSymbol: string;
  bid: string;
  ask: string;
  isTradingHalt: boolean;
  generatedAt: string;
  tokenBid?: string;
  tokenAsk?: string;
}

export type FetchFn = typeof fetch;

interface Entry<T> {
  at: number;
  value: Promise<T>;
}
const memo = new Map<string, Entry<unknown>>();

export function clearRobinhoodCache(): void {
  memo.clear();
}

function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, now = Date.now()): Promise<T> {
  const hit = memo.get(key) as Entry<T> | undefined;
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = load();
  memo.set(key, { at: now, value });
  value.catch(() => memo.delete(key));
  return value;
}

export class RobinhoodApi {
  constructor(
    private base: string,
    private fetchFn: FetchFn = (i, o) => fetch(i, o),
  ) {}

  assets(): Promise<RhAsset[]> {
    return cached(`assets:${this.base}`, 60_000, async () => {
      const r = await this.fetchFn(`${this.base}/assets`, { headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`rhj/assets ${r.status}`);
      const j = (await r.json()) as { assets?: RhAsset[] };
      if (!Array.isArray(j.assets)) throw new Error("rhj/assets: no assets array");
      return j.assets;
    });
  }

  /** null when the symbol is unknown (404). */
  price(symbol: string): Promise<RhQuote | null> {
    const s = symbol.toUpperCase();
    if (!/^[A-Z0-9.]{1,12}$/.test(s)) return Promise.resolve(null);
    return cached(`price:${this.base}:${s}`, 15_000, async () => {
      const r = await this.fetchFn(`${this.base}/prices/${encodeURIComponent(s)}`, { headers: { accept: "application/json" } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`rhj/prices ${r.status}`);
      const j = (await r.json()) as { quotes?: RhQuote[] };
      return j.quotes?.[0] ?? null;
    });
  }
}

export function deploymentOn4663(a: RhAsset): Address | null {
  const d = a.deployments.find((x) => x.chainId === CHAIN_ID);
  return d && isAddress(d.contractAddress, { strict: false }) ? getAddress(d.contractAddress) : null;
}

export type CanonicalResult =
  | { kind: "canonical"; asset: RhAsset; address: Address }
  | { kind: "lookalike"; symbolAsset: RhAsset | null; address: Address | null }
  | { kind: "not_on_chain"; asset: RhAsset }
  | { kind: "unknown_symbol"; symbol: string };

/**
 * Canonical resolution (brief §1). `address` wins over `symbol`; when both are
 * given and the address's asset has a different ticker, it is a look-alike.
 */
export function resolveCanonical(assets: RhAsset[], q: { address?: string | null; symbol?: string | null }): CanonicalResult {
  const sym = q.symbol?.trim().toUpperCase() || null;
  if (q.address) {
    const addr = getAddress(q.address.toLowerCase() as Address);
    const byAddr = assets.find((a) => deploymentOn4663(a) === addr);
    if (byAddr) {
      if (sym && byAddr.tokenSymbol.toUpperCase() !== sym) {
        return { kind: "lookalike", symbolAsset: assets.find((a) => a.tokenSymbol.toUpperCase() === sym) ?? null, address: addr };
      }
      return { kind: "canonical", asset: byAddr, address: addr };
    }
    // Unknown address: look-alike either way, attach the real asset if the symbol is known.
    return { kind: "lookalike", symbolAsset: sym ? assets.find((a) => a.tokenSymbol.toUpperCase() === sym) ?? null : null, address: addr };
  }
  if (!sym) return { kind: "unknown_symbol", symbol: "" };
  const bySym = assets.find((a) => a.tokenSymbol.toUpperCase() === sym);
  if (!bySym) return { kind: "unknown_symbol", symbol: sym };
  const addr = deploymentOn4663(bySym);
  if (!addr) return { kind: "not_on_chain", asset: bySym };
  return { kind: "canonical", asset: bySym, address: addr };
}

/** "1.001090616965388660" → 18-dp bigint. */
export function multiplierToWad(m: string): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(m)) return null;
  const [w, f = ""] = m.split(".");
  return BigInt(w as string) * 10n ** 18n + BigInt(f.slice(0, 18).padEnd(18, "0"));
}
