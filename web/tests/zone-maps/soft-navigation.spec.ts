// Regression: a Content-Security-Policy belongs to the DOCUMENT. Next.js client-side (soft) navigation never fetches a new document, so a
// page that was reached by clicking a link keeps the policy of the page the visitor FIRST loaded. When only the map routes carried the asset
// origin, landing on any other page (home, /zones, /database ...) and then clicking through to a map made the browser block the Cloudflare
// manifest/images (`connect-src 'self' https://challenges.cloudflare.com`), until a hard reload fetched a document with the right policy.
//
// Plain Playwright test (not ../e2e/fixtures): the cross-origin manifest fetch must look like what a real browser sends. The CDN is a real
// local HTTPS server on the allow-listed host name, so Chromium itself enforces CSP and CORS.
import { expect, test, type Page } from "@playwright/test";
import { settle } from "../e2e/maps-helpers";
import { startCdn, type Cdn } from "./cdn-server";

const CDN_HOST = "azerdex-assets.pages.dev";

let cdn: Cdn;
test.beforeAll(async () => { cdn = await startCdn(); });
test.afterAll(async () => { await cdn.close(); });
test.beforeEach(() => { cdn.stripCors = false; cdn.down = false; cdn.seen.length = 0; });

/** A link to /zones that exists on every viewport (the header nav is hidden on phones): the footer "All zones" link. */
const zonesLink = (page: Page) => page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "All zones" });

interface CdnEvent { url: string; status: number }

function watch(page: Page) {
  const cdnResponses: CdnEvent[] = [];
  const failed: string[] = [];
  const cspErrors: string[] = [];
  page.on("response", (r) => { if (new URL(r.url()).hostname === CDN_HOST) cdnResponses.push({ url: r.url(), status: r.status() }); });
  page.on("requestfailed", (r) => { if (new URL(r.url()).hostname === CDN_HOST) failed.push(`${r.url()} ${r.failure()?.errorText ?? ""}`); });
  page.on("console", (m) => { if (m.type() === "error" && /content security policy|violates the following/i.test(m.text())) cspErrors.push(m.text()); });
  return { cdnResponses, failed, cspErrors };
}

/** The map of the current page is fully usable: manifest + WebP from the CDN loaded (HTTP 200), image decoded, markers drawn. */
async function expectMapLoaded(page: Page, w: ReturnType<typeof watch>, zoneId: number, label: string, opts: { cached?: boolean } = {}) {
  // The map mounts lazily when its section scrolls into view (phones show it below the fold).
  await page.getByTestId("zone-map-section").or(page.getByTestId("source-maps")).first().scrollIntoViewIfNeeded();
  await page.getByTestId("zone-map").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector("[data-testid=zone-map]")?.getAttribute("data-ready") === "true");
  await page.waitForFunction(() => ((document.querySelector(".leaflet-image-layer") as HTMLImageElement | null)?.naturalWidth ?? 0) > 100);
  await settle(page);
  const forZone = w.cdnResponses.filter((e) => e.url.includes(`/forever/${zoneId}/`));
  const manifest = forZone.filter((e) => e.url.endsWith("/manifest.json"));
  const image = forZone.filter((e) => /\.webp$|\.png$/.test(new URL(e.url).pathname));
  // The CDN serves /forever/<zone>/<version>/* as immutable: revisiting an already loaded zone legitimately comes from the browser cache
  // (no network response). It must still decode and draw (checked above/below); the first visit of a zone must hit the CDN with HTTP 200.
  if (!opts.cached) {
    expect(manifest.length, `${label}: manifest requested from the CDN`).toBeGreaterThan(0);
    expect(image.length, `${label}: map image requested from the CDN`).toBeGreaterThan(0);
  }
  expect(manifest.every((e) => e.status === 200), `${label}: manifest HTTP 200`).toBe(true);
  expect(image.every((e) => e.status === 200), `${label}: image HTTP 200`).toBe(true);
  expect(await page.locator(".leaflet-marker-icon[data-x]").count(), `${label}: markers drawn`).toBeGreaterThan(0);
  await expect(page.getByTestId("map-fallback"), `${label}: no fallback state`).toHaveCount(0);
  expect(w.failed, `${label}: no blocked/failed CDN request`).toEqual([]);
  expect(w.cspErrors, `${label}: no CSP violation`).toEqual([]);
}

test.describe("soft navigation keeps the atlas CDN origin allowed (no hard reload)", () => {
  test("home -> zones -> zone map -> object -> its zone map -> other zone -> other object -> its zone map", async ({ page }) => {
    const w = watch(page);
    const res = await page.goto("/");
    // the document the visitor lands on already carries the validated origin in exactly img-src and connect-src
    const csp = res!.headers()["content-security-policy"]!;
    const dir = (n: string) => csp.split(";").map((x) => x.trim()).find((x) => x.startsWith(n + " "))!;
    expect(dir("img-src")).toContain(`https://${CDN_HOST}`);
    expect(dir("connect-src")).toContain(`https://${CDN_HOST}`);
    // a marker proves there is no full page load for the rest of the test
    await page.evaluate(() => { (window as unknown as { __spa: number }).__spa = 1; });
    const stillSpa = () => page.evaluate(() => (window as unknown as { __spa?: number }).__spa === 1);

    // home -> Zones (client navigation), then the Tirisfal Glades zone map
    await zonesLink(page).click();
    await page.waitForURL("**/zones");
    await page.locator('[data-ui-map-id="1420"]').click();
    await page.waitForURL("**/zone/1420");
    await expectMapLoaded(page, w, 1420, "zone 1420 (soft)");

    // zone map -> Copper Vein object page (source map from the CDN again)
    w.cdnResponses.length = 0;
    await page.locator('a[href="/object/1731"]:visible').first().click();
    await page.waitForURL("**/object/1731");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Copper Vein");
    await expectMapLoaded(page, w, 1420, "object 1731 (soft)", { cached: true });

    // object page -> its full zone map
    w.cdnResponses.length = 0;
    await page.getByTestId("zone-map-link").click();
    await page.waitForURL("**/zone/1420?source=gameobject:1731");
    await expectMapLoaded(page, w, 1420, "zone 1420 focused on Copper Vein (soft)", { cached: true });

    // another zone: Silverpine Forest, then Tin Vein and its map
    w.cdnResponses.length = 0;
    await zonesLink(page).click();
    await page.waitForURL("**/zones");
    await page.locator('[data-ui-map-id="1421"]').click();
    await page.waitForURL("**/zone/1421");
    await expectMapLoaded(page, w, 1421, "zone 1421 (soft)");

    w.cdnResponses.length = 0;
    await page.locator('a[href="/object/1732"]:visible').first().click();
    await page.waitForURL("**/object/1732");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tin Vein");
    await expectMapLoaded(page, w, 1421, "object 1732 Tin Vein (soft)", { cached: true });

    w.cdnResponses.length = 0;
    await page.getByTestId("zone-map-link").click();
    await page.waitForURL("**/zone/1421?source=gameobject:1732");
    await expectMapLoaded(page, w, 1421, "zone 1421 focused on Tin Vein (soft)", { cached: true });

    expect(await stillSpa(), "the whole journey was client-side navigation, never a document reload").toBe(true);
  });

  test("starting from a non-map page, e.g. the database search, then a source and its map", async ({ page }) => {
    const w = watch(page);
    await page.goto("/database");
    await page.evaluate(() => { (window as unknown as { __spa: number }).__spa = 1; });
    await zonesLink(page).click();
    await page.waitForURL("**/zones");
    await page.locator('[data-ui-map-id="1412"]').click();
    await page.waitForURL("**/zone/1412");
    await expectMapLoaded(page, w, 1412, "zone 1412 (soft, from /database)");
    expect(await page.evaluate(() => (window as unknown as { __spa?: number }).__spa === 1)).toBe(true);
  });

  test("the validated origin is the ONLY addition: no wildcard, no https:, no unsafe-inline, script/style untouched", async ({ request }) => {
    const dir = (c: string, n: string) => c.split(";").map((x) => x.trim()).find((x) => x.startsWith(n + " "))!;
    for (const p of ["/", "/zones", "/database", "/item/2770", "/about/data", "/download", "/zone/1420", "/object/1731"]) {
      const c = (await request.get(p)).headers()["content-security-policy"]!;
      for (const d of ["img-src", "connect-src"]) {
        expect(dir(c, d), `${p} ${d}`).toContain(`https://${CDN_HOST}`);
        expect(dir(c, d), `${p} ${d}`).not.toMatch(/\*|\shttps:(\s|$)|unsafe-inline|http:/);
      }
      expect(c, p).not.toContain("unsafe-inline");
      expect(dir(c, "script-src"), p).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
      expect(dir(c, "script-src"), p).not.toContain(CDN_HOST);
      expect(dir(c, "style-src"), p).not.toContain(CDN_HOST);
      expect(dir(c, "default-src"), p).toBe("default-src 'self'");
    }
  });
});
