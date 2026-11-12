// Snapshots Longbow market metadata (id, collateral, oracle label, LLTV) into
// src/data/longbow-markets.json using ONLY the read tools list_markets and
// get_market. Used for symbol → feed mapping and the onchain fallback.
// Run: node scripts/sync-longbow-markets.mjs
import { writeFileSync } from "node:fs";

const MCP = process.env.LONGBOW_MCP_URL ?? "https://mcp.longbow.finance/mcp";
let id = 0;
async function call(name, args) {
  if (!["list_markets", "get_market"].includes(name)) throw new Error(`refusing ${name}`);
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await r.text();
  const line = text.split("\n").filter((l) => l.startsWith("data:")).pop() ?? text;
  const j = JSON.parse(line.replace(/^data:\s*/, ""));
  return JSON.parse(j.result.content[0].text);
}

const list = await call("list_markets", {});
const markets = [];
for (const m of list) {
  if (m.closed || m.status !== "live") continue;
  const d = await call("get_market", { symbol: m.symbol });
  if (!d.marketId || !d.collateralAddress) continue;
  markets.push({
    symbol: d.symbol,
    marketId: d.marketId,
    collateralAddress: d.collateralAddress,
    loan: d.loan,
    oracleLabel: d.oracle?.label ?? "",
    maxLTV: d.maxLTV,
  });
}
markets.sort((a, b) => a.symbol.localeCompare(b.symbol));
const out = { source: MCP, generatedAt: new Date().toISOString(), markets };
writeFileSync(new globalThis.URL("../src/data/longbow-markets.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`${markets.length} markets written`);
