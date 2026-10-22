// Cinematic heroes served from the versioned CDN namespace (<CDN>/zone-heroes/<uiMapID>/<version>/...). Runs only with E2E_HERO_SOURCE=cdn
// (server started with AZERDEX_ZONE_HERO_SOURCE=cdn). The CDN host is mapped to a local HTTPS server, so CORS/CSP/Timing-Allow-Origin are
// enforced by the real browser, and the HTTP contract (headers, content type, 404s) is checked against the same server the page used.
import AxeBuilder from "@axe-core/playwright";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import inventory from "../../../scripts/map-atlas/heroes/zone-heroes.json";
import { CDN_PORT, ORIGIN, REAL_DIST, startCdn, type Cdn } from "./cdn-server";

test.skip(process.env.E2E_HERO_SOURCE !== "cdn", "CDN hero mode only (E2E_HERO_SOURCE=cdn)");

let cdn: Cdn;
test.beforeAll(async () => { cdn = await startCdn(); });
test.afterAll(async () => { await cdn.close(); });
test.beforeEach(() => { cdn.stripCors = false; cdn.down = false; cdn.seen.length = 0; });

const hero = (page: Page) => page.getByTestId("zone-hero");
const heroImg = (page: Page) => hero(page).locator("img[fetchpriority=high]");

/**
 * Direct HTTPS request to the stand-in CDN (Node does not use Chromium's host-resolver rule, so connect to the port and keep the Host/SNI).
 * Certificate verification stays ON: the only trust added is the stand-in's own temporary certificate (`ca`, scoped to this one request), and the
 * host name is still checked against its SAN (azerdex-assets.pages.dev). `ca: null` is the default trust store, used to prove it is not accepted.
 */
function get(path: string, method = "GET", ca: string | null = cdn.certPem): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port: CDN_PORT, path, method, servername: "azerdex-assets.pages.dev", headers: { host: "azerdex-assets.pages.dev" }, ca: ca ?? undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on("error", fail);
    r.end();
  });
}

const RENDITIONS = Object.entries(inventory.zones).flatMap(([id, z]) => Object.entries(z.versions).flatMap(([v, ver]) => ver.renditions.map((r) => ({ id, v, ...r }))));

test.describe("zone heroes from the CDN (real browser)", () => {
  test("the hero image is the CDN rendition for the viewport, decodes, and is requested only from the CDN", async ({ page }, info) => {
    const heroReqs: { url: string; status: number }[] = [];
    page.on("response", (r) => { if (/zone-heroes|\/zones\/hero\//.test(r.url())) heroReqs.push({ url: r.url(), status: r.status() }); });
    await page.goto("/zone/1424");
    await expect.poll(() => heroImg(page).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    const src = await heroImg(page).evaluate((i: HTMLImageElement) => i.currentSrc);
    const mobile = info.project.name === "mobile";
    // <picture>: phones (< 640 CSS px) get the separately cropped mobile renditions, larger screens the desktop panorama
    expect(src).toMatch(mobile ? /^https:\/\/azerdex-assets\.pages\.dev\/zone-heroes\/1424\/v1\/mobile-(600|900)\.webp$/ : /^https:\/\/azerdex-assets\.pages\.dev\/zone-heroes\/1424\/v1\/desktop-(1280|2000)\.webp$/);
    await expect(hero(page)).toHaveAttribute("data-artwork", "cinematic");
    expect(await heroImg(page).evaluate((i: HTMLImageElement) => [i.getAttribute("width"), i.getAttribute("height"), i.getAttribute("fetchpriority")])).toEqual(["2000", "667", "high"]);
    expect(heroReqs.length).toBeGreaterThan(0);
    expect(heroReqs.every((r) => r.url.startsWith(`${ORIGIN}/zone-heroes/1424/v1/`) && r.status === 200), JSON.stringify(heroReqs)).toBe(true);
    expect(cdn.seen.some((s) => s.url.startsWith("/zone-heroes/1424/v1/"))).toBe(true);
  });

  test("Duskwood: own namespace and rendition by viewport", async ({ page }, info) => {
    await page.goto("/zone/1431");
    await expect.poll(() => heroImg(page).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    const src = await heroImg(page).evaluate((i: HTMLImageElement) => i.currentSrc);
    expect(src).toMatch(info.project.name === "mobile" ? /\/zone-heroes\/1431\/v1\/mobile-(600|900)\.webp$/ : /\/zone-heroes\/1431\/v1\/desktop-(1280|1916)\.webp$/);
    expect(src).not.toContain("/1424/");
  });

  test("no CSP violation: the page's CSP allows the CDN in img-src only for the hero, and the browser reports nothing", async ({ page }) => {
    const violations: string[] = [];
    await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => ((window as unknown as { __csp: string[] }).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)));
    page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
    const res = await page.goto("/zone/1424");
    const csp = res!.headers()["content-security-policy"]!;
    expect(csp).toContain(`img-src 'self' data: ${ORIGIN}`);
    await expect.poll(() => heroImg(page).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    // The ONLY report is the pre-existing `style-src-attr` one: the (unchanged) hero <img> carries an inline style="object-position:…" that the
    // nonce-based style-src blocks, in the default same-origin mode just the same (found while writing this spec, documented in
    // docs/web/zone-cinematic-hero.md). Nothing may be reported for img-src/connect-src, i.e. the CDN origin is fully allowed.
    const reported = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
    expect(reported.filter((v) => !v.startsWith("style-src-attr inline"))).toEqual([]);
    expect(violations.filter((v) => !/style-src-attr|inline style/i.test(v))).toEqual([]);
  });

  test("Resource Timing sees the real hero size (Timing-Allow-Origin works in the browser: performance baseline is measurable)", async ({ page }) => {
    await page.goto("/zone/1424");
    await expect.poll(() => heroImg(page).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    const t = await page.evaluate(() => {
      const e = performance.getEntriesByType("resource").find((x) => x.name.includes("/zone-heroes/")) as PerformanceResourceTiming | undefined;
      return e && { encoded: e.encodedBodySize, transfer: e.transferSize, duration: e.duration };
    });
    expect(t, "hero resource entry").toBeTruthy();
    expect(t!.encoded).toBeGreaterThan(20_000); // without Timing-Allow-Origin a cross-origin entry reports 0
  });

  test("a failed CDN hero is not hidden but the page stays complete (vector backdrop, title, stats)", async ({ page }) => {
    cdn.down = true;
    await page.goto("/zone/1424");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hillsbrad Foothills");
    await expect(hero(page).locator("svg").first()).toBeVisible();
    await expect(hero(page).locator("dd")).toHaveCount(3);
    expect(await heroImg(page).evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(0);
  });

  test("accessibility (axe WCAG 2.2 AA) with CDN-served heroes", async ({ page }) => {
    for (const p of ["/zone/1424", "/zone/1431"]) {
      await page.goto(p);
      await expect(hero(page)).toBeVisible();
      const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`), p).toEqual([]);
    }
  });
});

test.describe("zone-heroes HTTP contract (the stand-in CDN serves what the unified _headers prescribes)", () => {
  test("all eight renditions: 200, byte-identical to the inventory, immutable cache, image/webp, CORS, nosniff, timing", async () => {
    expect(RENDITIONS).toHaveLength(8);
    for (const r of RENDITIONS) {
      const res = await get(`/zone-heroes/${r.id}/${r.v}/${r.file}`);
      expect(res.status, r.file).toBe(200);
      expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      expect(res.headers["content-type"]).toMatch(/^image\/webp/);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["timing-allow-origin"]).toBe("*");
      expect([res.body.length, createHash("sha256").update(res.body).digest("hex")]).toEqual([r.bytes, r.sha256]);
    }
  });

  test("TLS verification is real: the stand-in certificate is trusted only when passed explicitly (default trust store and wrong host name are refused)", async () => {
    await expect(get("/zone-heroes/1424/v1/desktop-1280.webp", "GET", null)).rejects.toThrow(/self[- ]signed|unable to verify|certificate/i);
    const wrongHost = new Promise<void>((ok, fail) => {
      const r = request({ host: "127.0.0.1", port: CDN_PORT, path: "/", servername: "evil.example", headers: { host: "evil.example" }, ca: cdn.certPem }, () => ok());
      r.on("error", fail);
      r.end();
    });
    await expect(wrongHost).rejects.toThrow(/altnames|hostname|certificate/i);
    expect((await get("/zone-heroes/1424/v1/desktop-1280.webp")).status).toBe(200);
  });

  test("the existing /forever/* and /atlas/* behaviour is unchanged next to it", async () => {
    const m = await get("/forever/1424/v1/manifest.json");
    expect(m.status).toBe(200);
    expect(m.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const idx = await get("/atlas/index.json");
    expect(idx.status).toBe(200);
    expect(idx.headers["cache-control"]).toBe("public, max-age=300, must-revalidate");
    expect(idx.headers["access-control-allow-origin"]).toBe("*");
  });

  test("unknown asset paths are HTTP 404 (no catch-all fallback)", async () => {
    for (const p of ["/zone-heroes/1424/v1/desktop-1000.webp", "/zone-heroes/1424/v2/desktop-1280.webp", "/zone-heroes/9999999/v1/desktop-1280.webp", "/zone-heroes/1424/v1/",
      "/zone-heroes/", "/zone-heroes/1424/v1/master.webp", "/zone-heroes/1424/v1/desktop-1280.png", "/forever/1424/v1/desktop-1280.webp"]) {
      expect((await get(p)).status, p).toBe(404);
    }
  });

  test("CORS: a cross-origin fetch of a hero succeeds in the browser, and stripping the header makes the browser block it", async ({ page }) => {
    await page.goto("/zone/1424");
    const f = (url: string) => page.evaluate(async (u) => { try { return (await fetch(u, { mode: "cors" })).status; } catch { return "blocked"; } }, url);
    // connect-src of the page allows the CDN origin (zone-map experience on), so only CORS decides here
    expect(await f(`${ORIGIN}/zone-heroes/1424/v1/desktop-1280.webp`)).toBe(200);
    cdn.stripCors = true;
    expect(await f(`${ORIGIN}/zone-heroes/1424/v1/desktop-1280.webp?nocache=1`)).toBe("blocked");
  });

  test(`the served bytes are the public watermarked derivatives (${REAL_DIST ? "real dist" : "repository files"})`, async () => {
    for (const r of RENDITIONS) {
      const local = readFileSync(join(__dirname, "../../public/zones/hero", r.source));
      expect(createHash("sha256").update(local).digest("hex")).toBe(r.sha256);
    }
  });
});
