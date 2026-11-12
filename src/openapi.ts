import { atomicToUsd, type Config } from "./env";
import { PREFLIGHT_DISCLAIMER, REOPEN_DISCLAIMER, SITE_DISCLAIMER } from "./disclaimers";

const x402 = (cfg: Config, amount: bigint) => ({
  "402": {
    description: `Payment required: $${atomicToUsd(amount)} USDG via x402 v2 (scheme exact, eip155:4663, payTo ${cfg.payTo}). The PAYMENT-REQUIRED header carries the requirements (base64 JSON).`,
  },
});

const common = {
  "400": { description: "Invalid input. Never charged." },
  "503": { description: "Upstream or facilitator unavailable. Not charged; retry." },
};

export function openApi(cfg: Config) {
  const p = cfg.prices;
  return {
    openapi: "3.1.0",
    info: {
      title: "StockFi",
      version: "0.1.0",
      description: `Read-only data checks for Robinhood Chain Stock Tokens, paid per request in USDG over x402. ${SITE_DISCLAIMER} Responses are canonical JSON (keys sorted); Content-Digest and X-Response-SHA256 carry the SHA-256 of the exact body.`,
      license: { name: "Apache-2.0" },
    },
    servers: [{ url: cfg.publicOrigin }],
    paths: {
      "/v1/preflight": {
        get: {
          summary: `Stock Token Preflight ($${atomicToUsd(p.preflight)}; $${atomicToUsd(p.preflightQuote)} when sizeUsdg is sent)`,
          description: PREFLIGHT_DISCLAIMER,
          parameters: [
            { name: "address", in: "query", schema: { type: "string" }, description: "Stock Token contract on chain 4663. Wins over symbol." },
            { name: "symbol", in: "query", schema: { type: "string" }, description: "Underlying ticker, no X prefix (e.g. AAPL)." },
            { name: "side", in: "query", schema: { type: "string", enum: ["buy", "sell"], default: "buy" } },
            { name: "sizeUsdg", in: "query", schema: { type: "number" }, description: "Notional in USDG. Adds a Uniswap route/impact quote (higher price)." },
            { name: "venue", in: "query", schema: { type: "string", enum: ["uniswap", "rfq", "any"], default: "any" }, description: "Hint only. Never executed." },
          ],
          responses: { "200": { description: "Verdict GO | CAUTION | STOP with reason codes and the underlying facts." }, ...x402(cfg, p.preflight), ...common },
        },
      },
      "/v1/preflight/quote": {
        get: {
          summary: `Preflight with route quote ($${atomicToUsd(p.preflightQuote)}); sizeUsdg required`,
          description: PREFLIGHT_DISCLAIMER,
          responses: { "200": { description: "As /v1/preflight, route.included = true." }, ...x402(cfg, p.preflightQuote), ...common },
        },
      },
      "/v1/reopen-risk": {
        get: {
          summary: `Reopen Risk snapshot ($${atomicToUsd(p.reopen)}; $${atomicToUsd(p.reopenWeekend)} with report=weekend)`,
          description: REOPEN_DISCLAIMER,
          parameters: [
            { name: "wallet", in: "query", required: true, schema: { type: "string" } },
            { name: "report", in: "query", schema: { type: "string", enum: ["snapshot", "weekend"], default: "snapshot" } },
          ],
          responses: { "200": { description: "Positions with health-factor scenarios. Empty wallet = 200 with positions: []." }, ...x402(cfg, p.reopen), ...common },
        },
      },
      "/v1/reopen-risk/weekend": {
        get: {
          summary: `Reopen Risk full weekend report ($${atomicToUsd(p.reopenWeekend)})`,
          description: REOPEN_DISCLAIMER,
          responses: { "200": { description: "Snapshot plus up-shocks and a short factual summary." }, ...x402(cfg, p.reopenWeekend), ...common },
        },
      },
    },
  };
}
