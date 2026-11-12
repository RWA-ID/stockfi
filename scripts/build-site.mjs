// Composes site/pages/*.html (front-matter: title, desc, active) with the shared
// head/foot into public/*.html. Deterministic; run `npm run site`.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const root = new globalThis.URL("../", import.meta.url);
const head = readFileSync(new globalThis.URL("site/head.html", root), "utf8");
const foot = readFileSync(new globalThis.URL("site/foot.html", root), "utf8");
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

for (const f of readdirSync(new globalThis.URL("site/pages/", root)).filter((x) => x.endsWith(".html"))) {
  const src = readFileSync(new globalThis.URL(`site/pages/${f}`, root), "utf8");
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  if (!m) throw new Error(`${f}: missing front-matter`);
  const meta = Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
  const cur = (k) => (meta.active === k ? ' aria-current="page"' : "");
  const html =
    head
      .replaceAll("{title}", esc(meta.title))
      .replaceAll("{desc}", esc(meta.desc))
      .replaceAll("{path}", f === "index.html" ? "/" : `/${f.replace(/\.html$/, "")}`)
      .replace("{a_pf}", cur("preflight"))
      .replace("{a_rr}", cur("reopen"))
      .replace("{a_docs}", cur("docs")) +
    src.slice(m[0].length) +
    foot;
  writeFileSync(new globalThis.URL(`public/${f}`, root), html);
  console.log(`public/${f}`);
}
