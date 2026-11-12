import { describe, expect, it } from "vitest";
import { sessionAt } from "../src/calendar";
import { canonicalJson, hashedBody, sha256, toHex } from "../src/canonical-json";
import { execPrice, midFromSqrt } from "../src/data/chain";
import { usdToAtomic, atomicToUsd } from "../src/env";

describe("canonical JSON + hash", () => {
  it("sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[{"y":2,"z":1}]},"b":1}');
  });
  it("same data, different key order → same hash; hash matches the bytes", async () => {
    const a = await hashedBody({ x: 1, y: { b: 2, a: 1 } });
    const b = await hashedBody({ y: { a: 1, b: 2 }, x: 1 });
    expect(a.hex).toBe(b.hex);
    expect(a.hex).toBe(toHex(await sha256(new TextEncoder().encode(a.body))));
    expect(a.contentDigest).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:$/);
  });
});

describe("US equity session calendar (America/New_York)", () => {
  const at = (iso: string) => sessionAt(new Date(iso));
  it.each([
    ["2026-11-11T16:00:00Z", "regular"], // Wed 11:00 ET
    ["2026-11-11T13:00:00Z", "extended"], // Wed 08:00 ET
    ["2026-11-11T22:00:00Z", "extended"], // Wed 17:00 ET
    ["2026-11-12T02:00:00Z", "overnight"], // Wed 21:00 ET
    ["2026-11-12T08:00:00Z", "overnight"], // Thu 03:00 ET
    ["2026-11-14T02:00:00Z", "weekend"], // Fri 21:00 ET
    ["2026-11-14T17:00:00Z", "weekend"], // Sat
    ["2026-11-15T23:00:00Z", "weekend"], // Sun 18:00 ET
    ["2026-11-16T02:00:00Z", "overnight"], // Sun 21:00 ET
    ["2026-11-26T16:00:00Z", "closed"], // Thanksgiving
    ["2026-11-26T02:00:00Z", "closed"], // Wed 21:00 ET before Thanksgiving
    ["2026-11-27T19:00:00Z", "extended"], // Black Friday 14:00 ET (13:00 early close)
    ["2026-11-27T17:00:00Z", "regular"], // Black Friday 12:00 ET
    ["2027-03-26T15:00:00Z", "closed"], // Good Friday 2027
    ["2026-07-15T14:00:00Z", "regular"], // summer (EDT) 10:00 ET
  ])("%s → %s", (iso, s) => expect(at(iso)).toBe(s));
});

describe("Uniswap math", () => {
  it("mid from sqrtPriceX96 for both token orders", () => {
    // price 355 USDG per 18-dp token; USDG 6 dp
    const ratioUsdgPerToken = 355 * 1e6 / 1e18; // usdg_raw per token_raw (token is token0)
    const sqrt = BigInt(Math.round(Math.sqrt(ratioUsdgPerToken) * 2 ** 96));
    expect(midFromSqrt(sqrt, false)).toBeCloseTo(355, 6);
    const sqrtInv = BigInt(Math.round(Math.sqrt(1 / ratioUsdgPerToken) * 2 ** 96));
    expect(midFromSqrt(sqrtInv, true)).toBeCloseTo(355, 6);
  });
  it("exec price", () => {
    expect(execPrice("buy", 5_000_000_000n, 14n * 10n ** 18n)).toBeCloseTo(357.142857, 5);
    expect(execPrice("sell", 14n * 10n ** 18n, 4_970_000_000n)).toBeCloseTo(355, 5);
  });
});

describe("prices", () => {
  it("round-trips USDG", () => {
    expect(usdToAtomic("$0.02")).toBe(20_000n);
    expect(usdToAtomic("0.10")).toBe(100_000n);
    expect(atomicToUsd(50_000n)).toBe("0.05");
    expect(() => usdToAtomic("0.0000001")).toThrow();
  });
});
