/**
 * Longbow, read-only. Primary source: the public MCP at mcp.longbow.finance
 * (no key). Only the four READ tools below may ever be called: the client
 * refuses anything else before a request is made, so a build_*, plan_*,
 * simulate_* or broadcast_* tool can never be reached, even if the server
 * lists it. Verified against tools/list on 2026-11-12 (server v0.3.0).
 *
 * Fallback when the MCP is unreachable: Morpho Blue reads on chain 4663 for the
 * Stock Token markets snapshotted in longbow-markets.json.
 */
import { getAddress, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import marketsJson from "./longbow-markets.json";

export const ALLOWED_TOOLS = ["list_markets", "get_market", "get_position", "get_guard"] as const;
export type AllowedTool = (typeof ALLOWED_TOOLS)[number];
const ALLOWED = new Set<string>(ALLOWED_TOOLS);

export class ToolNotAllowedError extends Error {}

export interface LbPosition {
  market: string;
  marketId: Hex;
  collateralToken: Address;
  collateralSymbol: string;
  collateral: number;
  collateralValueUSDG: number;
  borrowed: number;
  health: number | null;
  liquidatable: boolean;
  loan: string;
  liquidationPriceUSDG: number | null;
  currentPriceUSDG: number | null;
  maxLTV: number;
}

export interface LbGuard {
  enrolled: boolean;
  status: string | null;
  config: unknown;
}

export interface LbMarketMeta {
  symbol: string;
  marketId: Hex;
  collateralAddress: Address;
  loan: string;
  oracleLabel: string;
  maxLTV: number;
}

export interface LongbowSource {
  positions(wallet: Address): Promise<{ positions: LbPosition[]; source: "mcp" | "onchain" }>;
  guard(wallet: Address): Promise<LbGuard | "unavailable">;
  markets(): LbMarketMeta[];
}

const SNAPSHOT = (marketsJson as { markets: LbMarketMeta[] }).markets;

export class McpClient {
  private id = 0;
  constructor(
    private url: string,
    private fetchFn: typeof fetch = (i, o) => fetch(i, o),
  ) {}

  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!ALLOWED.has(name)) throw new ToolNotAllowedError(`Longbow tool "${name}" is not on the read-only allowlist`);
    const r = await this.fetchFn(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) throw new Error(`longbow mcp ${r.status}`);
    const text = await r.text();
    const json = parseRpc(text) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
    if (json.error) throw new Error(`longbow mcp error: ${json.error.message ?? "unknown"}`);
    const body = json.result?.content?.[0]?.text;
    if (json.result?.isError || body === undefined) throw new Error(`longbow tool ${name} failed`);
    return JSON.parse(body) as T;
  }
}

/** Accepts a plain JSON-RPC body or an SSE stream ("data: {...}" lines). */
export function parseRpc(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const data = t
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter(Boolean);
  if (!data.length) throw new Error("longbow mcp: empty response");
  return JSON.parse(data[data.length - 1] as string);
}

export class LongbowReader implements LongbowSource {
  constructor(
    private mcp: McpClient,
    private client: PublicClient | null,
  ) {}

  markets(): LbMarketMeta[] {
    return SNAPSHOT;
  }

  async positions(wallet: Address): Promise<{ positions: LbPosition[]; source: "mcp" | "onchain" }> {
    try {
      const r = await this.mcp.call<{ positions?: LbPosition[] }>("get_position", { address: wallet });
      return { positions: Array.isArray(r.positions) ? r.positions : [], source: "mcp" };
    } catch (e) {
      if (e instanceof ToolNotAllowedError || !this.client) throw e;
      return { positions: await morphoPositions(this.client, wallet), source: "onchain" };
    }
  }

  async guard(wallet: Address): Promise<LbGuard | "unavailable"> {
    try {
      const g = await this.mcp.call<LbGuard>("get_guard", { address: wallet });
      return { enrolled: !!g.enrolled, status: g.status ?? null, config: g.config ?? null };
    } catch {
      return "unavailable";
    }
  }
}

// ---- Morpho Blue fallback ---------------------------------------------------

export const MORPHO: Address = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
const MORPHO_ABI = parseAbi([
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
]);
const ORACLE_ABI = parseAbi(["function price() view returns (uint256)"]);
const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);

async function morphoPositions(client: PublicClient, wallet: Address): Promise<LbPosition[]> {
  const out: LbPosition[] = [];
  const rows = await Promise.all(
    SNAPSHOT.map(async (m) => ({ m, p: await client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "position", args: [m.marketId, wallet] }) })),
  );
  for (const { m, p } of rows) {
    const [, borrowShares, collateral] = p;
    if (collateral === 0n && borrowShares === 0n) continue;
    const [mk, params] = await Promise.all([
      client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "market", args: [m.marketId] }),
      client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "idToMarketParams", args: [m.marketId] }),
    ]);
    const [loanToken, collateralToken, oracle, , lltv] = params;
    const [price, collDec, loanDec] = await Promise.all([
      client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "price" }),
      client.readContract({ address: collateralToken, abi: ERC20_ABI, functionName: "decimals" }),
      client.readContract({ address: loanToken, abi: ERC20_ABI, functionName: "decimals" }),
    ]);
    // Morpho virtual shares: assets = shares × (totalAssets + 1) / (totalShares + 1e6)
    const borrowAssets = (borrowShares * (mk[2] + 1n)) / (mk[3] + 1_000_000n);
    const collateralValueLoan = (collateral * price) / 10n ** 36n; // in loan-token atomic units
    const f = (x: bigint, d: number) => Number(x) / 10 ** d;
    const collValue = f(collateralValueLoan, loanDec);
    const borrowed = f(borrowAssets, loanDec);
    const lltvN = f(lltv, 18);
    const collAmount = f(collateral, collDec);
    const priceN = collAmount > 0 ? collValue / collAmount : null;
    const health = borrowed > 0 ? (collValue * lltvN) / borrowed : null;
    out.push({
      market: `${m.symbol} / ${m.loan}`,
      marketId: m.marketId,
      collateralToken: getAddress(collateralToken),
      collateralSymbol: m.symbol,
      collateral: collAmount,
      collateralValueUSDG: collValue,
      borrowed,
      health,
      liquidatable: health !== null && health < 1,
      loan: m.loan,
      liquidationPriceUSDG: priceN !== null && health ? priceN / health : null,
      currentPriceUSDG: priceN,
      maxLTV: lltvN,
    });
  }
  return out;
}
