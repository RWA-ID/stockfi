// Regenerates src/data/feeds.json from Chainlink's official feed directory for
// Robinhood Chain. Only the Standard proxy (`proxyAddress`) of each 24/5
// US-equity feed is kept; the SVR proxy (`secondaryProxyAddress`) is not used.
// Run: npm run sync-feeds
import { writeFileSync } from "node:fs";

const DIRECTORY = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const res = await fetch(DIRECTORY);
if (!res.ok) throw new Error(`directory ${res.status}`);
const all = await res.json();

const feeds = {};
for (const f of all) {
  const m = /^Robinhood ([A-Z.]+)\s*(?:\/|-)\s*USD$/.exec(f.name ?? "");
  if (!m || f.docs?.marketHours !== "us_equities_24/5") continue;
  feeds[m[1]] = {
    proxy: f.proxyAddress,
    decimals: f.decimals,
    heartbeat: f.heartbeat,
    marketHours: f.docs.marketHours,
  };
}
const sorted = Object.fromEntries(Object.entries(feeds).sort(([a], [b]) => a.localeCompare(b)));
const out = { source: DIRECTORY, generatedAt: new Date().toISOString(), feeds: sorted };
writeFileSync(new URL("../src/data/feeds.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(`${Object.keys(sorted).length} feeds written`);
