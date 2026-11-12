/**
 * x402 v2, scheme "exact", USDG on Robinhood Chain (eip155:4663), settled
 * through x402Fi's public facilitator. StockFi never holds keys or funds: the
 * buyer's EIP-3009 authorization moves USDG straight to PAY_TO.
 *
 * Order per request: validate input (400 before any 402) → 402 if unpaid →
 * facilitator /verify → compute → only on 2xx, facilitator /settle → body.
 * A failed settle returns no payload. A failed compute is never settled.
 */
import { getAddress, type Address, type Hex } from "viem";
import { hashedBody } from "./canonical-json";
import { USDG } from "./data/chain";

export const NETWORK = "eip155:4663";
export const USDG_DOMAIN = { name: "Global Dollar", version: "1" } as const;

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  amount: string;
  asset: Address;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export interface PaymentPayload {
  x402Version: 2;
  accepted: PaymentRequirements;
  payload: {
    signature: Hex;
    authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
  };
}

export function encodeHeader(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeHeader<T>(header: string): T {
  const bin = atob(header.trim());
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as T;
}

export function buildRequirements(amount: bigint, payTo: Address): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    amount: amount.toString(),
    asset: USDG,
    payTo: getAddress(payTo),
    maxTimeoutSeconds: 120,
    extra: { ...USDG_DOMAIN },
  };
}

export function paymentRequired(opts: { url: string; description: string; amount: bigint; payTo: Address; payeeName: string | null; error?: string }) {
  return {
    x402Version: 2 as const,
    ...(opts.error ? { error: opts.error } : {}),
    resource: { url: opts.url, description: opts.description, mimeType: "application/json" },
    accepts: [buildRequirements(opts.amount, opts.payTo)],
    ...(opts.payeeName ? { extensions: { "payee-name": { info: { name: opts.payeeName } } } } : {}),
  };
}

export interface Facilitator {
  verify(p: PaymentPayload, r: PaymentRequirements): Promise<{ ok: true; payer: Address } | { ok: false; reason: string; retryable: boolean }>;
  settle(p: PaymentPayload, r: PaymentRequirements): Promise<{ ok: true; settle: Record<string, unknown> } | { ok: false; reason: string; retryable: boolean }>;
}

export class HttpFacilitator implements Facilitator {
  constructor(
    private base: string,
    private fetchFn: typeof fetch = (i, o) => fetch(i, o),
  ) {}

  private async post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
    try {
      const r = await this.fetchFn(`${this.base}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
    } catch {
      return { status: 503, json: null };
    }
  }

  async verify(p: PaymentPayload, r: PaymentRequirements) {
    const { status, json } = await this.post("verify", { paymentPayload: p, paymentRequirements: r });
    if (json?.isValid === true && typeof json.payer === "string") return { ok: true as const, payer: json.payer as Address };
    return { ok: false as const, reason: String(json?.invalidReason ?? "facilitator_unavailable"), retryable: status >= 500 || !json };
  }

  async settle(p: PaymentPayload, r: PaymentRequirements) {
    const { status, json } = await this.post("settle", { paymentPayload: p, paymentRequirements: r });
    if (json?.success === true) return { ok: true as const, settle: json };
    return { ok: false as const, reason: String(json?.errorReason ?? "settle_failed"), retryable: status >= 500 || !json };
  }
}

/** Constant-time string compare (both sides hashed first so lengths match). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const ax = new Uint8Array(x);
  const by = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < ax.length; i++) d |= (ax[i] as number) ^ (by[i] as number);
  return d === 0 && a.length === b.length;
}

export const EXPOSE_HEADERS = "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE, Content-Digest, X-Response-SHA256";

export interface PaidRequest {
  request: Request;
  url: string;
  description: string;
  amount: bigint;
  payTo: Address;
  payeeName: string | null;
  upstreamKey: string | null;
  facilitator: Facilitator;
  /** Returns the JSON body for a 200, or throws. */
  compute: () => Promise<unknown>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-expose-headers": EXPOSE_HEADERS, ...headers },
  });
}

async function ok(body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  const h = await hashedBody(body);
  return new Response(h.body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "content-digest": h.contentDigest,
      "x-response-sha256": h.hex,
      "access-control-expose-headers": EXPOSE_HEADERS,
      ...extra,
    },
  });
}

function computeError(e: unknown): Response {
  const msg = e instanceof Error ? e.message : "error";
  return json(503, { error: "upstream_unavailable", detail: msg.slice(0, 200), charged: false, retry: true });
}

export async function handlePaid(p: PaidRequest): Promise<Response> {
  // 1. x402Fi proxied path: x402Fi already verified the buyer and settles after our 2xx.
  const secret = p.request.headers.get("x-x402fi-secret");
  if (secret && p.upstreamKey && (await safeEqual(secret, p.upstreamKey))) {
    try {
      return await ok(await p.compute());
    } catch (e) {
      return computeError(e);
    }
  }

  const challenge = (error?: string) => {
    const pr = paymentRequired({ url: p.url, description: p.description, amount: p.amount, payTo: p.payTo, payeeName: p.payeeName, error });
    return json(402, pr, { "PAYMENT-REQUIRED": encodeHeader(pr) });
  };

  // 2. Unpaid → 402
  const header = p.request.headers.get("PAYMENT-SIGNATURE") ?? p.request.headers.get("X-PAYMENT");
  if (!header) return challenge();

  let payload: PaymentPayload;
  try {
    payload = decodeHeader<PaymentPayload>(header);
  } catch {
    return challenge("invalid_payment_header");
  }
  if (payload?.x402Version !== 2 || !payload.payload?.authorization) return challenge("unsupported_x402_version");

  // Our requirements, never the client's echo, are what gets verified.
  const reqs = buildRequirements(p.amount, p.payTo);

  // 3. Verify
  const v = await p.facilitator.verify(payload, reqs);
  if (!v.ok) {
    if (v.retryable) return json(503, { error: "facilitator_unavailable", detail: v.reason, charged: false, retry: true });
    return challenge(v.reason);
  }

  // 4. Compute (not charged on failure)
  let body: unknown;
  try {
    body = await p.compute();
  } catch (e) {
    return computeError(e);
  }

  // 5. Settle, then release the body
  const s = await p.facilitator.settle(payload, reqs);
  if (!s.ok) {
    if (s.retryable) return json(503, { error: "settlement_unavailable", detail: s.reason, charged: false, retry: true });
    return challenge(s.reason);
  }
  const receipt = encodeHeader(s.settle);
  return ok(body, { "PAYMENT-RESPONSE": receipt, "X-PAYMENT-RESPONSE": receipt });
}
