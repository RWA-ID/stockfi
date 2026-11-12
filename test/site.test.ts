import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../public/");
const pages = readdirSync(dir).filter((f) => f.endsWith(".html"));
const text = (f: string) => readFileSync(dir + f, "utf8");

describe("site copy rules", () => {
  it("has the expected pages", () => {
    for (const p of ["index.html", "preflight.html", "reopen-risk.html", "docs.html", "terms.html", "privacy.html", "disclaimer.html", "404.html"]) expect(pages).toContain(p);
  });

  it.each(pages)("%s carries the full disclaimer, the U.S. persons line and the non-affiliation line", (f) => {
    const h = text(f);
    expect(h).toContain("Not investment advice, not a recommendation, and not an offer.");
    expect(h).toContain("not available to U.S. persons");
    expect(h).toContain("not affiliated with, endorsed by, or sponsored by Robinhood Markets, Inc. or its affiliates");
    expect(h).toContain('src="/brand/robinhood-chain-logo-black.svg"');
  });

  it.each(pages)("%s avoids banned phrasing", (f) => {
    const h = text(f);
    expect(h).not.toMatch(/Robinhood['’]s|Robinhod/);
    expect(h).not.toMatch(/Robinhood[- ]official|guaranteed|safe to (buy|trade)|powered by (Anthropic|Claude)/i);
    expect(h).not.toMatch(/\bHood Chain/);
    expect(h).not.toMatch(/#263D35/i); // x402Fi forest green
  });

  it("every invented figure page shows the Sample badge", () => {
    for (const f of ["index.html", "preflight.html", "reopen-risk.html"]) expect(text(f)).toContain('class="sample"');
  });
});
