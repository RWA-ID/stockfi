import { inspectDelivery } from "wormhole-x402/delivery";
import { inspectQuoteText } from "wormhole-x402/quotetext";
/** Bump together with the pinned wormhole-x402 version. */
export const SCANNER = "wormhole-x402@0.11.0";

export type ScanMode = "off" | "flag" | "block";
export const scanMode = (v: unknown): ScanMode => (v === "off" || v === "flag" ? v : "block");

/**
 * Paid-response check, using AgentWormhole's delivery rules (wormhole-x402, Apache-2.0).
 * Ported from x402Fi's gateway (src/lib/delivery.ts) so a direct call to stockfi.trade gets
 * the same check a call through x402Fi does. Runs on StockFi's own computed body BEFORE
 * settlement, so in block mode a refused response is never charged.
 *
 * Mode: env DELIVERY_SCAN = block (default) | flag (log only) | off.
 *
 * Two parts:
 *  1. inspectDelivery: empty body (X402-404), JSON that does not parse (X402-406), and the
 *     sha256 of the delivered bytes, which goes on the receipt (the "got a" of paid-a-got-a).
 *  2. Our own text scan of the body. inspectDelivery scans the raw body, but its rules
 *     demote a match inside quotation marks (so a security product QUOTING an attack is not
 *     refused), and in JSON every string value is quoted: an injection in a JSON field comes
 *     back "high" and the delivery is allowed. So for JSON we scan the parsed string values
 *     (keys included) as plain text instead. The scanner abstains on any single field over
 *     its 16 KiB decode window, and on one holding more than ~48 hex / ~24 base64 tokens
 *     (every 0x address is one): so strings are scanned in groups under both limits
 *     (groupForScan), up to SCAN_CHARS per response; text past that is recorded as
 *     truncated, not clean.
 *
 * Shape matching over text: catches the careless injection, never certifies a response.
 */
export const SCAN_CHARS = 64 * 1024;
const CHUNK = 15_000;
const OVERLAP = 300;
/** Encoded-looking tokens per group; upstream gives up past 24 base64 / 48 hex per field. */
const MAX_TOKENS = 20;
const TOKEN_RE = /0x[0-9a-fA-F]{16,}|[A-Za-z0-9+/_-]{20,}={0,2}/g;

export interface DeliveryFinding {
  code: string;
  severity: string;
  message: string;
  /** "json" (parsed string values) or "body" (raw text); absent for HTTP-level findings. */
  in?: "json" | "body";
  excerpt?: string;
}

export interface DeliveryCheck {
  decision: "allow" | "refuse" | "abstain";
  codes: string[];
  findings: DeliveryFinding[];
  /** sha256 hex of the delivered bytes, or null when the scanner would not attest them. */
  sha256: string | null;
  byteLen: number;
  contentType: string | null;
  json: boolean;
  scannedChars: number;
  /** More text than SCAN_CHARS: the tail was not read. */
  truncated: boolean;
  scanner: string;
}

/** Every string in a JSON value, keys included, depth-limited. */
export function jsonStrings(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 64) return out;
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) jsonStrings(x, out, depth + 1);
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      jsonStrings(x, out, depth + 1);
    }
  }
  return out;
}

/** Overlapping chunks so a phrase straddling a boundary is still seen whole. */
export function chunks(text: string, size = CHUNK, overlap = OVERLAP): string[] {
  if (text.length <= size) return text ? [text] : [];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size - overlap) {
    out.push(text.slice(i, i + size));
    if (i + size >= text.length) break;
  }
  return out;
}

/**
 * Packs strings (JSON values, or lines of a text body) into scan groups that stay under the
 * scanner's per-field limits: at most CHUNK chars and MAX_TOKENS encoded-looking tokens.
 * A string too long on its own is split into overlapping chunks. A short string that closes
 * a group is repeated at the start of the next, so a phrase spread over two adjacent values
 * or lines is still seen together.
 */
export function groupForScan(units: string[]): string[] {
  const groups: string[] = [];
  let cur: string[] = [];
  let chars = 0;
  let tokens = 0;
  let fresh = false; // cur holds something not yet scanned (not only the carried-over string)
  const count = (u: string) => u.match(TOKEN_RE)?.length ?? 0;
  const flush = (carry: boolean) => {
    if (fresh) groups.push(cur.join("\n"));
    const last = cur[cur.length - 1];
    cur = carry && last !== undefined && last.length < OVERLAP ? [last] : [];
    chars = cur.length && last !== undefined ? last.length + 1 : 0;
    tokens = cur.length && last !== undefined ? count(last) : 0;
    fresh = false;
  };
  for (const u of units) {
    if (!u) continue;
    const n = count(u);
    if (u.length > CHUNK || n > MAX_TOKENS) {
      flush(false);
      groups.push(...chunks(u));
      continue;
    }
    if (chars + u.length + 1 > CHUNK || tokens + n > MAX_TOKENS) flush(true);
    cur.push(u);
    chars += u.length + 1;
    tokens += n;
    fresh = true;
  }
  flush(false);
  return groups;
}

const isJsonType = (t: string | null) => t !== null && (t === "application/json" || t.endsWith("+json"));

export function checkDelivery(r: { status: number; contentType: string | null; body: Uint8Array }): DeliveryCheck {
  const contentType = r.contentType?.split(";")[0]?.trim().toLowerCase() || null;

  // Text or binary? Strict UTF-8: a body that does not decode is binary and is not text-scanned.
  let text: string | null;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(r.body);
  } catch {
    text = null;
  }
  let parsed: unknown = undefined;
  let json = false;
  if (text !== null && (isJsonType(contentType) || /^\s*[[{]/.test(text))) {
    try {
      parsed = JSON.parse(text);
      json = true;
    } catch {
      /* inspectDelivery reports X402-406 when JSON was declared */
    }
  }

  // Part 1: HTTP-level checks + digest. Its own text scan is off (maxScanBytes 0): part 2 replaces it.
  const d = inspectDelivery({}, { status: r.status, contentType: r.contentType, body: r.body }, { maxScanBytes: 0 });
  const findings: DeliveryFinding[] = d.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message }));
  let abstained = d.decision === "abstain";
  if (abstained) findings.push({ code: "ABSTAIN", severity: "high", message: d.reason ?? "the delivery check could not read the response" });

  // Part 2: text scan.
  const units: string[] = [];
  let total = 0;
  let truncated = false;
  for (const u of json ? jsonStrings(parsed) : (text ?? "").split("\n")) {
    if (total >= SCAN_CHARS) { truncated = true; break; }
    const take = u.slice(0, SCAN_CHARS - total);
    if (take.length < u.length) truncated = true;
    units.push(take);
    total += take.length;
  }
  const seen = new Set<string>();
  for (const c of groupForScan(units)) {
    const v = inspectQuoteText(c);
    if (v.decision === "abstain") {
      abstained = true;
      if (!seen.has("ABSTAIN")) findings.push({ code: "ABSTAIN", severity: "high", message: v.reason ?? "the text scan could not read part of the response", in: json ? "json" : "body" });
      seen.add("ABSTAIN");
    }
    for (const f of v.findings) {
      const key = `${f.code}:${f.excerpt}`;
      if (seen.has(key)) continue; // overlap reports the same match twice
      seen.add(key);
      findings.push({ code: f.code, severity: f.severity, message: f.message, in: json ? "json" : "body", excerpt: f.excerpt?.slice(0, 160) });
    }
  }

  const refused = d.decision === "refuse" || findings.some((f) => f.severity === "critical");
  return {
    decision: refused ? "refuse" : abstained ? "abstain" : "allow",
    codes: [...new Set(findings.map((f) => f.code))].sort(),
    findings,
    sha256: d.receipt?.resource_digest ?? null,
    byteLen: r.body.length,
    contentType,
    json,
    scannedChars: total,
    truncated,
    scanner: SCANNER,
  };
}
