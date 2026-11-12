/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, `undefined`
 * dropped (as JSON.stringify does). The SHA-256 of these exact bytes is the
 * response hash, so any client can re-serialize the parsed body the same way and
 * reproduce it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function toBase64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/** Body bytes plus the two digest headers (RFC 9530 Content-Digest + hex). */
export async function hashedBody(value: unknown): Promise<{ body: string; hex: string; contentDigest: string }> {
  const body = canonicalJson(value);
  const digest = await sha256(new TextEncoder().encode(body));
  return { body, hex: toHex(digest), contentDigest: `sha-256=:${toBase64(digest)}:` };
}
