// Smoke test of the cinematic zone heroes on a deployed (or local) site, for the Vercel beta activation of AZERDEX_ZONE_HERO_SOURCE=cdn (V2-B).
// Read-only: GET requests only. Exit code 0 = every check passed, 1 = at least one failed (nothing is assumed: an unreachable URL fails).
//
//   node scripts/hero-cdn-smoke.mjs --site https://beta.azerdex.com --expect local   # BEFORE activation: same-origin heroes (the rollback state)
//   node scripts/hero-cdn-smoke.mjs --site https://beta.azerdex.com --expect cdn     # AFTER activation: CDN heroes
//   options: --cdn https://azerdex-assets.pages.dev   --out evidence.json   --skip-asset-fetch (page checks only)   --allow-test-site (http / non-allow-listed site, tests only)
//
// Per zone (1424 Hillsbrad Foothills, 1431 Duskwood) it checks: HTTP 200, the hero <picture> (mobile <source> srcset + <img> src/srcset/sizes/width/height/
// fetchpriority=high) points at the expected origin and files, the crop is a stylesheet class (no inline style), the CSP is still strict (no unsafe-inline, nonce
// style-src) and allows the CDN origin in img-src only as designed, no `zone-heroes` reference when `--expect local`, and (unless skipped) that every hero file
// is served with the inventory's exact bytes and the immutable cache / image/webp / CORS / nosniff / timing headers.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args.set(a.slice(2), true); else { args.set(a.slice(2), next); i++; }
}
const expect = args.get("expect");
const site = args.get("site");
const cdn = (args.get("cdn") ?? "https://azerdex-assets.pages.dev").replace(/\/+$/, "");
if (!site || !["cdn", "local"].includes(expect)) { console.error("usage: hero-cdn-smoke.mjs --site <origin> --expect cdn|local [--cdn <origin>] [--out file.json] [--skip-asset-fetch]"); process.exit(2); }
const siteOrigin = new URL(site).origin;
const SITE_OK = /^https:\/\/(beta\.azerdex\.com|azerdex\.com|[a-z0-9-]+\.vercel\.app)$/;
if (!SITE_OK.test(siteOrigin) && !args.get("allow-test-site")) { console.error(`refusing site ${siteOrigin}: https on azerdex.com / beta.azerdex.com / *.vercel.app only`); process.exit(2); }
if (!/^https:\/\/(azerdex-assets\.pages\.dev|assets\.azerdex\.com|[a-z0-9-]+\.azerdex-assets\.pages\.dev)$/.test(cdn) && !args.get("allow-test-site")) { console.error(`refusing CDN origin ${cdn}`); process.exit(2); }

const inv = JSON.parse(readFileSync(fileURLToPath(new URL("../../scripts/map-atlas/heroes/zone-heroes.json", import.meta.url)), "utf8"));
const ZONES = [{ id: "1424", name: "Hillsbrad Foothills", crop: "hero-pos-85-50" }, { id: "1431", name: "Duskwood", crop: "hero-pos-85-45" }];
const results = { when: new Date().toISOString(), site: siteOrigin, expect, cdn, checks: [], failures: [] };
const check = (ok, msg) => { results.checks.push({ ok, msg }); if (!ok) { results.failures.push(msg); console.log(`  FAIL  ${msg}`); } else console.log(`  ok    ${msg}`); };
const sha = (b) => createHash("sha256").update(b).digest("hex");

async function get(url) {
  try {
    const r = await fetch(url, { redirect: "manual", headers: { "user-agent": "AzerDex-hero-cdn-smoke/1.0", accept: "*/*" } });
    return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) };
  } catch (e) { return { status: 0, error: String(e.cause?.code ?? e.message), headers: new Headers(), body: Buffer.alloc(0) }; }
}

for (const z of ZONES) {
  console.log(`\n/zone/${z.id} (${z.name}) expecting ${expect}`);
  const ver = Object.keys(inv.zones[z.id].versions).sort().at(-1);
  const rs = inv.zones[z.id].versions[ver].renditions;
  const mk = (r) => (expect === "cdn" ? `${cdn}/zone-heroes/${z.id}/${ver}/${r.file}` : `/zones/hero/${r.source}`);
  const ofRole = (role) => rs.filter((r) => r.file.startsWith(role)).sort((a, b) => a.width - b.width);
  const page = await get(`${siteOrigin}/zone/${z.id}`);
  check(page.status === 200, `GET /zone/${z.id} -> HTTP ${page.status}${page.error ? ` (${page.error})` : ""}`);
  if (page.status !== 200) continue;
  const html = page.body.toString("utf8");
  const img = /<img\b[^>]*fetchpriority="high"[^>]*>/i.exec(html)?.[0] ?? "";
  const source = /<source\b[^>]*media="\(max-width: 639px\)"[^>]*>/i.exec(html)?.[0] ?? "";
  check(Boolean(img) && Boolean(source), "hero <picture> with mobile <source> and <img fetchpriority=high> present");
  const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1];
  const set = (role) => ofRole(role).map((r) => `${mk(r)} ${r.width}w`).join(", ");
  const desk = ofRole("desktop"), big = desk.at(-1);
  check(attr(source, "srcset") === set("mobile"), `mobile srcset = ${set("mobile")}`);
  check(attr(img, "srcset") === set("desktop"), `desktop srcset = ${set("desktop")}`);
  check(attr(img, "src") === mk(big), `img src = ${mk(big)} (largest desktop rendition)`);
  check(attr(source, "sizes") === "100vw" && attr(img, "sizes") === "(min-width: 1280px) 1232px, 100vw", "sizes unchanged (100vw / (min-width: 1280px) 1232px, 100vw)");
  check(attr(img, "width") === String(big.width) && attr(img, "height") === String(big.height), `intrinsic size ${big.width}x${big.height}`);
  check(new RegExp(`class="[^"]*\\b${z.crop}\\b`).test(img) && !/\sstyle=/i.test(img), `crop is the stylesheet class ${z.crop}, no inline style`);
  check((html.includes("zone-heroes") || html.includes(cdn + "/zone-heroes")) === (expect === "cdn"), expect === "cdn" ? "page references the zone-heroes namespace" : "page does not reference zone-heroes (same-origin heroes)");
  const csp = page.headers.get("content-security-policy") ?? "";
  const dir = (n) => csp.split(";").map((x) => x.trim()).find((x) => x.startsWith(n + " ")) ?? "";
  check(!/unsafe-inline|unsafe-eval|\*/.test(dir("script-src") + dir("style-src") + dir("img-src") + dir("connect-src")), "CSP stays strict (no unsafe-inline / unsafe-eval / wildcard)");
  check(/style-src 'self' 'nonce-[^']+'$/.test(dir("style-src")), "style-src = 'self' + nonce only");
  if (expect === "cdn") check(dir("img-src").split(" ").includes(cdn), `img-src allows ${cdn}`);
  check(dir("img-src").split(" ").filter((t) => t.startsWith("https://")).every((t) => t === cdn), "img-src contains no other external origin");
  if (args.get("skip-asset-fetch")) continue;
  for (const r of rs) {
    const u = mk(r).startsWith("/") ? siteOrigin + mk(r) : mk(r);
    const a = await get(u);
    const exact = a.status === 200 && a.body.length === r.bytes && sha(a.body) === r.sha256;
    check(exact, `${u.replace(siteOrigin, "")} -> HTTP ${a.status}, ${a.body.length} bytes, sha256 ${exact ? "= inventory" : "MISMATCH"}${a.error ? ` (${a.error})` : ""}`);
    if (a.status === 200 && expect === "cdn") {
      const h = (n) => a.headers.get(n) ?? "";
      const cc = h("cache-control").toLowerCase().split(",").map((x) => x.trim()).sort().join(",");
      check(cc === "immutable,max-age=31536000,public" && /^image\/webp/.test(h("content-type")) && h("access-control-allow-origin") === "*" && h("x-content-type-options") === "nosniff" && h("timing-allow-origin") === "*",
        `${r.file}: immutable cache, image/webp, CORS *, nosniff, timing (cf-cache-status: ${h("cf-cache-status") || "-"})`);
    }
  }
}
results.verdict = results.failures.length === 0 && results.checks.length > 0 ? "PASS" : "FAIL";
console.log(`\n${results.verdict}: ${results.checks.filter((c) => c.ok).length}/${results.checks.length} checks passed`);
if (args.get("out")) writeFileSync(args.get("out"), JSON.stringify(results, null, 1));
process.exit(results.verdict === "PASS" ? 0 : 1);
