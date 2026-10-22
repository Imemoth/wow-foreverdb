// Real-browser check of the cinematic zone heroes on a deployed site (V2-B beta CDN activation). Read-only: loads public pages in headless Chrome.
//
//   node scripts/hero-browser-check.mjs --site https://beta.azerdex.com --expect cdn [--out evidence.json] [--shots dir]
//
// Per zone (1424 Hillsbrad Foothills, 1431 Duskwood) and viewport (desktop 1440x900, mobile 390x844) it asserts what the unit-level smoke test cannot:
// the hero <img> decodes, its currentSrc is the viewport's rendition on the expected origin (CDN or same-origin), the EFFECTIVE computed object-position
// is the approved crop with no inline style, the browser reports no CSP violation / console error / failed request, every hero request is HTTP 200,
// and the atlas map below the hero becomes ready and loads its art (from the CDN when an asset base is configured) without a failing request.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args.set(a.slice(2), true); else { args.set(a.slice(2), next); i++; }
}
const site = new URL(args.get("site") ?? "").origin;
const expect = args.get("expect");
const cdn = "https://azerdex-assets.pages.dev";
if (!/^https:\/\/(beta\.azerdex\.com|azerdex\.com|[a-z0-9-]+\.vercel\.app)$/.test(site) || !["cdn", "local"].includes(expect)) {
  console.error("usage: hero-browser-check.mjs --site <https origin> --expect cdn|local [--out file] [--shots dir]"); process.exit(2);
}
const ZONES = [{ id: 1424, name: "hillsbrad", position: "85% 50%" }, { id: 1431, name: "duskwood", position: "85% 45%" }];
const VIEWPORTS = [{ name: "desktop", width: 1440, height: 900, isMobile: false }, { name: "mobile", width: 390, height: 844, isMobile: true }];
const results = { when: new Date().toISOString(), site, expect, cdn, checks: [], failures: [] };
const check = (ok, msg) => { results.checks.push({ ok, msg }); if (!ok) { results.failures.push(msg); console.log(`  FAIL  ${msg}`); } else console.log(`  ok    ${msg}`); };
if (args.get("shots")) mkdirSync(args.get("shots"), { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
try {
  for (const vp of VIEWPORTS) for (const z of ZONES) {
    console.log(`\n/zone/${z.id} ${z.name} ${vp.name} (${vp.width}x${vp.height}) expecting ${expect}`);
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.isMobile, hasTouch: vp.isMobile, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const heroReqs = [], cdnReqs = [], failed = [], consoleErrors = [], otherErrors = [];
    page.on("response", (r) => {
      const u = r.url();
      if (/\/zone-heroes\/|\/zones\/hero\//.test(u)) heroReqs.push({ url: u, status: r.status() });
      if (u.startsWith(cdn + "/")) cdnReqs.push({ url: u, status: r.status() });
      else if (r.status() >= 400) otherErrors.push(`${r.status()} ${u.replace(site, "")}`);
    });
    // aborted requests (navigation prefetches cancelled when the context closes) are not failures
    page.on("requestfailed", (r) => { if (r.failure()?.errorText !== "net::ERR_ABORTED") failed.push(`${r.url()} ${r.failure()?.errorText}`); });
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => ((window).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)));
    const resp = await page.goto(`${site}/zone/${z.id}`, { waitUntil: "load", timeout: 45_000 });
    check(resp?.status() === 200, `HTTP ${resp?.status()}`);
    const img = page.locator('[data-testid="zone-hero"] img[fetchpriority=high]');
    await img.waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => { const i = document.querySelector('[data-testid="zone-hero"] img[fetchpriority=high]'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20_000 }).catch(() => {});
    const r = await img.evaluate((i) => ({ complete: i.complete, nw: i.naturalWidth, nh: i.naturalHeight, src: i.currentSrc, style: i.getAttribute("style"), pos: getComputedStyle(i).objectPosition, fit: getComputedStyle(i).objectFit, shown: i.getBoundingClientRect().width }));
    check(r.complete && r.nw > 0, `hero decoded (${r.nw}x${r.nh}, rendered ${Math.round(r.shown)} px wide)`);
    const origin = expect === "cdn" ? `${cdn}/zone-heroes/${z.id}/v1/` : `${site}/zones/hero/`;
    const re = vp.isMobile ? /mobile-(600|900)\.webp$/ : /(desktop-)?(1280|1916|2000)\.webp$/;
    check(r.src.startsWith(origin) && re.test(r.src), `currentSrc = ${r.src}`);
    check(r.pos === z.position && r.style === null && r.fit === "cover", `computed object-position ${r.pos} (expected ${z.position}), object-fit ${r.fit}, inline style ${r.style}`);
    check(heroReqs.length > 0 && heroReqs.every((h) => h.status === 200 && h.url.startsWith(origin)), `hero requests all 200 from ${origin}: ${heroReqs.map((h) => h.url.split("/").pop() + " " + h.status).join(", ")}`);
    // map below the hero
    const map = page.locator('[data-testid="zone-map"]');
    await map.first().scrollIntoViewIfNeeded().catch(() => {});
    const ready = await page.waitForFunction(() => document.querySelector("[data-testid=zone-map]")?.getAttribute("data-ready") === "true", null, { timeout: 25_000 }).then(() => true).catch(() => false);
    check(ready, "atlas map present and ready (data-ready=true)");
    if (ready) {
      const m = await page.evaluate(() => ({ summary: document.querySelector("[data-testid=map-summary]")?.textContent?.trim() ?? null, fallback: !!document.querySelector("[data-testid=map-fallback]"), art: document.querySelector("[data-testid=map-art]")?.textContent?.trim() ?? null, w: document.querySelector("[data-testid=zone-map]").getBoundingClientRect().width }));
      check(!m.fallback && m.w > 0, `map renders without the fallback notice (${m.summary ?? "no summary"}; ${m.art ?? "no art label"})`);
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const bad = cdnReqs.filter((c) => c.status >= 400);
    check(bad.length === 0, `${cdnReqs.length} request(s) to ${cdn}: ${bad.length} with status >= 400${bad.length ? " -> " + JSON.stringify(bad) : ""}`);
    const csp = await page.evaluate(() => window.__csp ?? []);
    check(csp.length === 0, `no CSP violation event${csp.length ? ": " + csp.join(" | ") : ""}`);
    // resource errors are attributed by URL: anything from the CDN or the hero files fails the check; other site responses >= 400 (for example the anonymous
    // Account/session probe answering 401) are reported as notes because they are independent of the heroes and the CDN
    const consoleOther = consoleErrors.filter((m) => !/Failed to load resource/.test(m));
    check(consoleOther.length === 0 && failed.length === 0, `no console error / failed request${consoleOther.length || failed.length ? ": " + JSON.stringify({ consoleOther, failed }) : ""}`);
    if (otherErrors.length) console.log(`  note  non-hero responses >= 400 on the site (not part of the heroes/CDN): ${otherErrors.join(", ")}`);
    results.notes ??= []; if (otherErrors.length) results.notes.push({ zone: z.id, viewport: vp.name, otherErrors });
    if (args.get("shots")) { await page.locator('[data-testid="zone-hero"]').screenshot({ path: join(args.get("shots"), `${z.name}-${vp.name}-${expect}.png`) }).catch(() => {}); }
    await ctx.close();
  }
} finally { await browser.close(); }
results.verdict = results.failures.length === 0 && results.checks.length > 0 ? "PASS" : "FAIL";
console.log(`\n${results.verdict}: ${results.checks.filter((c) => c.ok).length}/${results.checks.length} checks passed`);
if (args.get("out")) writeFileSync(args.get("out"), JSON.stringify(results, null, 1));
process.exit(results.verdict === "PASS" ? 0 : 1);
