import { Hono } from "hono";
import { loadConfig, atomicToUsd, type Config, type Env } from "./env";
import { makeClient, ViemChainReader } from "./data/chain";
import { LongbowReader, McpClient } from "./data/longbow";
import { RobinhoodApi } from "./data/robinhood";
import { BadRequest, computePreflight, computeReopen, parsePreflight, parseReopen, type Deps } from "./handlers";
import { openApi } from "./openapi";
import { EXPOSE_HEADERS, HttpFacilitator, handlePaid, type Facilitator } from "./x402";
import { SITE_DISCLAIMER } from "./disclaimers";

export interface AppDeps {
  deps: (env: Env) => Deps;
  facilitator: (cfg: Config) => Facilitator;
}

export const liveDeps: AppDeps = {
  deps: (env) => {
    const cfg = loadConfig(env);
    const client = makeClient(cfg.rpcUrls);
    return {
      cfg,
      rh: new RobinhoodApi(cfg.robinhoodApi),
      chain: new ViemChainReader(client),
      longbow: new LongbowReader(new McpClient(cfg.longbowMcp), client),
    };
  },
  facilitator: (cfg) => new HttpFacilitator(cfg.facilitatorUrl),
};

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "PAYMENT-SIGNATURE, X-PAYMENT, Content-Type",
  "access-control-expose-headers": EXPOSE_HEADERS,
};

export function createApp(app: AppDeps) {
  const h = new Hono<{ Bindings: Env }>();

  // Canonical origin: https://stockfi.trade. http → https and www → apex, path and query kept.
  // 301 for GET/HEAD; 308 otherwise so a client keeps its method and body.
  h.use("*", async (c, next) => {
    const u = new URL(c.req.url);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname.endsWith(".workers.dev");
    if (!local && (u.protocol === "http:" || u.hostname.startsWith("www."))) {
      u.protocol = "https:";
      u.hostname = u.hostname.replace(/^www\./, "");
      u.port = "";
      return c.redirect(u.toString(), c.req.method === "GET" || c.req.method === "HEAD" ? 301 : 308);
    }
    await next();
    if (!local) {
      // Static-asset responses have immutable headers: copy before adding HSTS.
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set("strict-transport-security", "max-age=31536000");
    }
  });

  h.use("/v1/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    await next();
    c.res.headers.set("access-control-allow-origin", "*");
  });

  h.get("/healthz", (c) => c.json({ ok: true }));
  h.get("/openapi.json", (c) => c.json(openApi(loadConfig(c.env))));

  const paid = async (
    c: { req: { raw: Request; url: string }; env: Env },
    kind: "preflight" | "reopen",
    variant: { quotePath?: boolean; weekendPath?: boolean },
  ) => {
    const d = app.deps(c.env);
    const url = new URL(c.req.url);
    try {
      if (kind === "preflight") {
        const q = parsePreflight(url, !!variant.quotePath);
        const withQuote = q.sizeUsdg !== null;
        const amount = withQuote ? d.cfg.prices.preflightQuote : d.cfg.prices.preflight;
        return await handlePaid({
          request: c.req.raw,
          url: `${d.cfg.publicOrigin}${url.pathname}${url.search}`,
          description: `StockFi Preflight${withQuote ? " with route quote" : ""} ($${atomicToUsd(amount)}): GO / CAUTION / STOP data checks for a Robinhood Chain Stock Token. ${SITE_DISCLAIMER}`,
          amount,
          payTo: d.cfg.payTo,
          payeeName: d.cfg.payeeName,
          upstreamKey: d.cfg.upstreamKey,
          facilitator: app.facilitator(d.cfg),
          compute: () => computePreflight(q, d),
          deliveryScan: d.cfg.deliveryScan,
        });
      }
      const q = parseReopen(url, !!variant.weekendPath);
      const amount = q.report === "weekend" ? d.cfg.prices.reopenWeekend : d.cfg.prices.reopen;
      return await handlePaid({
        request: c.req.raw,
        url: `${d.cfg.publicOrigin}${url.pathname}${url.search}`,
        description: `StockFi Reopen Risk ${q.report === "weekend" ? "weekend report" : "snapshot"} ($${atomicToUsd(amount)}): read-only weekend-gap stress for Longbow loans backed by Stock Tokens. Information only; never builds a transaction. ${SITE_DISCLAIMER}`,
        amount,
        payTo: d.cfg.payTo,
        payeeName: d.cfg.payeeName,
        upstreamKey: d.cfg.upstreamKey,
        facilitator: app.facilitator(d.cfg),
        compute: () => computeReopen(q, d),
        deliveryScan: d.cfg.deliveryScan,
      });
    } catch (e) {
      if (e instanceof BadRequest) return Response.json({ error: "bad_request", detail: e.message, charged: false }, { status: 400, headers: CORS });
      throw e;
    }
  };

  h.get("/v1/preflight", (c) => paid(c, "preflight", {}));
  h.get("/v1/preflight/quote", (c) => paid(c, "preflight", { quotePath: true }));
  h.get("/v1/reopen-risk", (c) => paid(c, "reopen", {}));
  h.get("/v1/reopen-risk/weekend", (c) => paid(c, "reopen", { weekendPath: true }));
  h.all("/v1/*", (c) => c.json({ error: "not_found", endpoints: ["/v1/preflight", "/v1/preflight/quote", "/v1/reopen-risk", "/v1/reopen-risk/weekend"] }, 404));

  h.onError((e, c) => c.json({ error: "internal_error", detail: e.message.slice(0, 200), charged: false }, 500));

  // Everything else: the static site.
  h.all("*", (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("Not found", 404)));
  return h;
}

export default createApp(liveDeps);
