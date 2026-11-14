# StockFi

**[stockfi.trade](https://stockfi.trade)**: two read-only APIs for Robinhood Chain Stock Tokens, paid per request in USDG over [x402](https://x402.org) and listed on [x402Fi](https://x402fi.dev), the dedicated x402 marketplace on Robinhood Chain. Also registered as ERC-8004 agent [#25741 on 8004scan](https://8004scan.io/agents/robinhood-chain/25741).

| Endpoint | What it returns | Price |
| --- | --- | --- |
| `GET /v1/preflight` | `GO` / `CAUTION` / `STOP` with reason codes, before a swap into or out of a Stock Token | $0.02 |
| `GET /v1/preflight/quote` (or `/v1/preflight?sizeUsdg=`) | The same, plus a Uniswap v3 route and price-impact quote | $0.05 |
| `GET /v1/reopen-risk?wallet=` | Weekend-gap health-factor stress for the wallet's Longbow loans backed by Stock Tokens | $0.03 |
| `GET /v1/reopen-risk/weekend?wallet=` (or `report=weekend`) | The same, plus up-shocks and a short factual summary | $0.10 |

> **Data checks only.** Not investment advice, not a recommendation to trade or borrow, and not an offer or solicitation. Stock Tokens are not intended for U.S. persons; **not available to U.S. persons**. StockFi is independent and not affiliated with, endorsed by, or sponsored by Robinhood Markets, Inc. or its affiliates, or by Longbow. StockFi never holds funds or keys, never signs, never sends a transaction and never routes a swap or a borrow.

Operator: Only Buy Bitcoin LLC (Delaware), the same company that operates x402Fi. Contact: contact@stockfi.trade.

## How it works

```
buyer ──GET──▶ stockfi.trade/v1/…  ──400 if the input is bad (never charged)
                │ no payment ──▶ 402 + PAYMENT-REQUIRED (USDG, eip155:4663, payTo, price)
                │ PAYMENT-SIGNATURE
                ▼
        x402Fi facilitator /verify ─▶ run the checks ─▶ /settle ─▶ 200 + body
                                       (fail: 503,       (fail: 402,
                                        not charged)      no body)
```

- **Payment**: x402 v2, scheme `exact`, USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` (EIP-3009) on Robinhood Chain. Verification and settlement go through [x402Fi's public facilitator](https://x402fi.dev/developers); USDG moves straight from the buyer to `PAY_TO`. StockFi runs no facilitator and holds no keys.
- **Settle after 2xx**: the facilitator `/settle` call happens only after the result is computed. A failed compute is never settled; a failed settle never releases the body.
- **Delivery check** (same as x402Fi's gateway): before anything is settled or released, the body runs through AgentWormhole's delivery rules (`wormhole-x402`, `src/delivery.ts`): parse/empty checks plus a prompt-injection scan of every string value. `DELIVERY_SCAN=block` (default) answers `502 delivery_refused`, not charged; `flag` only logs. Every 200 carries `X-Delivery-Scan`. The weekend summary from the model must also pass the scan, or the template is used. Shape matching catches careless injection; it does not certify a response.
- **Receipts**: every 200 body is canonical JSON (keys sorted, no whitespace). `X-Response-SHA256` (hex) and `Content-Digest: sha-256=:…:` (RFC 9530) hash the exact bytes; `PAYMENT-RESPONSE` carries the settlement result and transaction hash.
- **x402Fi listing (proxied)**: x402Fi's gateway calls `stockfi.trade` with `X-X402Fi-Secret`. When it matches the `UPSTREAM_KEY` secret (constant-time compare), StockFi skips its own 402, because x402Fi has already verified the buyer and settles after StockFi's 2xx. That path adds x402Fi's public receipts, response hash and revenue dashboard.

## Data sources (public only)

| Source | Used for |
| --- | --- |
| `api.robinhood.com/rhj/assets`, `/rhj/prices/{symbol}` | Canonical deployments on chain 4663, status, multipliers, halts, raw bid/ask. Cached in-isolate for 60 s (assets) and 15 s (prices). |
| Stock Token contracts | `uiMultiplier()`, `newUIMultiplier()`, `effectiveAt()`, `oraclePaused()` (optional; reported `unavailable` when missing). |
| Chainlink 24/5 feeds (Standard proxies) | `src/data/feeds.json`, generated from Chainlink's directory by `npm run sync-feeds`. Prices are already multiplier-adjusted and are never multiplied again. |
| Uniswap v3 on Robinhood Chain | Factory `0x1f7d…2efa`, QuoterV2 `0x33e8…a9e7` ([official list](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-robinhood-chain-deployments)). Mid price comes from the deepest USDG pool; impact from QuoterV2 across the 0.05 / 0.3 / 1% tiers. |
| Longbow public MCP `mcp.longbow.finance/mcp` | **Read tools only**: `list_markets`, `get_market`, `get_position`, `get_guard` (confirmed against `tools/list` on 2026-11-12, server v0.3.0). The client refuses every other tool name before sending a request; tests prove a full run never calls a `build_*`, `plan_*`, `simulate_*` or `broadcast_*` tool. Fallback: Morpho Blue reads (`0x9D53…1010`) for the markets in `src/data/longbow-markets.json` (`node scripts/sync-longbow-markets.mjs`). |
| Anthropic (`claude-haiku-5-5`) | Only the prose `summary` of the $0.10 weekend report, written from figures already computed. It is never sent a wallet address, never decides a verdict, and falls back to a deterministic template on any error, refusal or advice-sounding output. |

Each Reopen Risk report includes `market.nextRegularOpen` / `market.feedsResumeAt` (from the NYSE calendar in `src/calendar.ts`; the holiday table runs through 2027) and, per position, `corporateAction` (pending multiplier from `/rhj/assets`, else the token's `newUIMultiplier`/`effectiveAt`; `unavailable` for collateral that is not a Robinhood Stock Token).

Health factor (verified against live `get_position`): `collateralValue × LLTV / debt`. With USDG debt it scales linearly with the collateral price. The stress gaps of 20% and 40% come from the brief (`STRESS_PCTS`). Longbow's risk page renders client-side and could not be machine-read at build time, so recheck its published figures when you change them.

## Run locally

```bash
npm install
cp .env.example .dev.vars    # fill UPSTREAM_KEY, ANTHROPIC_API_KEY (optional), ROBINHOOD_RPC_URL (recommended)
npm run dev                  # wrangler dev on http://localhost:8787
curl -i "localhost:8787/v1/preflight?symbol=AAPL"                                   # 402
curl -s -H "X-X402Fi-Secret: $UPSTREAM_KEY" "localhost:8787/v1/preflight?symbol=AAPL"  # result, no payment
```

To pay a local 402 for real, sign an EIP-3009 `TransferWithAuthorization` for the quoted amount with any x402 v2 client that supports `eip155:4663` + USDG (see x402Fi's `scripts/pay-demo.mjs` and `/developers#paying-safely`) and send it as `PAYMENT-SIGNATURE`. Settlement is real and on mainnet: use a test wallet and tiny amounts.

### Checks

```bash
npm run lint && npm run typecheck && npm test   # unit tests, all upstreams fixtured
LIVE=1 npx vitest run test/live                 # optional live chain smoke test
npm run site                                    # rebuild public/*.html from site/
npm run build                                   # wrangler dry run
```

CI runs all of the above on every PR and push to `main`. It never deploys.

## Configuration

`wrangler.toml` `[vars]` (non-secret): `PAY_TO`, `PAYEE_NAME`, `PUBLIC_ORIGIN`, `FACILITATOR_URL`, `PRICE_PREFLIGHT`, `PRICE_PREFLIGHT_QUOTE`, `PRICE_REOPEN`, `PRICE_REOPEN_WEEKEND`, `ROBINHOOD_API_BASE`, `LONGBOW_MCP_URL`, `STALE_FEED_MINUTES` (30), `PREMIUM_CAUTION_BPS` (100), `IMPACT_CAUTION_BPS` (200), `THIN_BOOK_BPS` (1000), `STRESS_PCTS` (`20,40`), `SAFE_BUFFER_HF` (1.1), `GUARD_SUGGEST_HF` (1.25), `SUMMARY_MODEL`, `DELIVERY_SCAN` (`block`).

Secrets (`wrangler secret put`): `UPSTREAM_KEY` (from the x402Fi listing), `ANTHROPIC_API_KEY`, `ROBINHOOD_RPC_URL` (a dedicated RPC; public RPCs rate-limit Cloudflare egress). Never commit them, and never put a secret's name in `[vars]`, because a var shadows a secret.

All upstream URLs come from config, never from request input (no SSRF surface).

## Deploy

```bash
npx wrangler deploy        # Worker + static site; custom domains stockfi.trade + www.stockfi.trade
```

The Worker runs first on every request: `http://` and `www.` redirect to `https://stockfi.trade` (301 for GET/HEAD, 308 otherwise), and responses carry HSTS.

```bash
```

## Listing on x402Fi

1. Sign in at [x402fi.dev/sell/new](https://x402fi.dev/sell/new) → proxied endpoint, upstream `https://stockfi.trade`.
2. Add four **fixed** endpoints: `GET /v1/preflight` $0.02, `GET /v1/preflight/quote` $0.05, `GET /v1/reopen-risk` $0.03, `GET /v1/reopen-risk/weekend` $0.10. Put the disclaimers above in the descriptions.
3. Payout = `PAY_TO`; attach the payee name (records: `origins` = `https://stockfi.trade`, `https://x402fi.dev`; chain 4663 address = `PAY_TO`).
4. Copy the listing's upstream secret into `wrangler secret put UPSTREAM_KEY`.
5. Check [x402fi.dev/discovery](https://x402fi.dev/discovery) and `/api/discovery/resources`, then pay a real $0.02 Preflight and a $0.03 Reopen Risk and open the public receipt.

## ERC-8004 / 8004scan

StockFi is ERC-8004 agent **#25741** on Robinhood Chain: [8004scan.io/agents/robinhood-chain/25741](https://8004scan.io/agents/robinhood-chain/25741).

- IdentityRegistry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (chain 4663). Registered by `PAY_TO` (tx `0x418587c44a553b003d18e6fd94eae4fe5ffa9c1cf4b8cb9d16da26cf33105bfc`), so the onchain `agentWallet` is `PAY_TO`. Transferring the agent resets `agentWallet` to zero.
- `agentURI` = `https://stockfi.trade/.well-known/agent-registration.json`, served by the Worker from `src/agent-registration.json`. Editing that file and deploying updates the listing; no transaction is needed. The file lives on the same domain as the `web` service, which is what proves domain control.
- 8004scan collapses `services` by name (the last entry wins), so keep one `web` and one `ENS` entry.

## License

Apache-2.0. See `LICENSE` and `NOTICE`. Security reports: see `SECURITY.md`.
