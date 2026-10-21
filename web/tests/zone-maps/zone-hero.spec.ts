// Zone Cinematic Hero + atlas map through the REAL browser integration path (CDN host mapped to a local HTTPS server, CORS/CSP enforced
// by Chromium). Plain Playwright test for the same reason as zone-maps.spec.ts (no preflight-inducing extra headers).
import { expect, test, type Page } from "@playwright/test";
import { settle } from "../e2e/maps-helpers";
import { startCdn, type Cdn } from "./cdn-server";

let cdn: Cdn;
test.beforeAll(async () => { cdn = await startCdn(); });
test.afterAll(async () => { await cdn.close(); });
test.beforeEach(() => { cdn.stripCors = false; cdn.down = false; cdn.seen.length = 0; });

const hero = (page: Page) => page.getByTestId("zone-hero");

/** Every request the page made, with status, so "no broken image requests" is evidence, not an assumption. */
function track(page: Page) {
  const bad: string[] = [];
  const all: { url: string; status: number }[] = [];
  page.on("response", (r) => { all.push({ url: r.url(), status: r.status() }); if (r.status() >= 400 && r.request().resourceType() === "image") bad.push(`${r.status()} ${r.url()}`); });
  page.on("requestfailed", (r) => { if (r.resourceType() === "image") bad.push(`failed ${r.url()}`); });
  return { bad, all };
}

async function mapReady(page: Page) {
  await page.getByTestId("zone-map-section").scrollIntoViewIfNeeded();
  await page.getByTestId("zone-map").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector("[data-testid=zone-map]")?.getAttribute("data-ready") === "true");
  await page.waitForFunction(() => ((document.querySelector(".leaflet-image-layer") as HTMLImageElement | null)?.naturalWidth ?? 0) > 100);
  await settle(page);
}

test.describe("zone hero + atlas map (synthetic CDN, real browser CORS/CSP)", () => {
  test("Hillsbrad Foothills (1424): cinematic hero, no uiMapID, continent label, real map loads from the CDN", async ({ page }) => {
    const t = track(page);
    await page.goto("/zone/1424");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hillsbrad Foothills");
    await expect(hero(page)).toHaveAttribute("data-artwork", "cinematic");
    await expect(hero(page)).toContainText("Eastern Kingdoms · Zone");
    await expect(hero(page)).not.toContainText(/uiMapID|1424/);
    // atlas-only zone: no published figures -> en dash, never an invented 0
    const dd = hero(page).locator("dd");
    await expect(dd).toHaveCount(3);
    for (const v of await dd.allTextContents()) expect(v).toMatch(/^–Not available$/);
    // hero image: same origin, decoded, a WebP rendition (not the atlas map)
    const img = hero(page).locator("img[fetchpriority=high]");
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    expect(await img.evaluate((i: HTMLImageElement) => i.currentSrc)).toMatch(/\/zones\/hero\/1424-hillsbrad-foothills-.*\.webp$/);
    // the Zone Map itself is unaffected: manifest + image from the CDN with HTTP 200, no fallback
    await mapReady(page);
    await expect(page.getByTestId("map-fallback")).toHaveCount(0);
    const forZone = t.all.filter((e) => e.url.includes("/forever/1424/"));
    expect(forZone.some((e) => e.url.endsWith("/manifest.json") && e.status === 200)).toBe(true);
    expect(forZone.some((e) => /\.(png|webp)$/.test(e.url) && e.status === 200)).toBe(true);
    expect(t.bad, "no broken image requests").toEqual([]);
  });

  test("a second zone with an available atlas map and no cinematic artwork (1426): map-layer hero, map loads, no broken images", async ({ page }) => {
    const t = track(page);
    await page.goto("/zone/1426");
    await expect(hero(page)).toHaveAttribute("data-artwork", "map");
    await expect(hero(page)).not.toContainText(/uiMapID|1426/);
    await mapReady(page);
    await expect(page.getByTestId("map-fallback")).toHaveCount(0);
    expect(t.bad, "no broken image requests").toEqual([]);
  });

  test("observed zone (1420): hero stats are the read-model figures, markers/map unchanged", async ({ page }) => {
    await page.goto("/zone/1420");
    await expect(hero(page)).toContainText("Eastern Kingdoms · Zone");
    const values = await hero(page).locator("dd").allTextContents();
    expect(values.every((v) => /^[\d,]+$/.test(v))).toBe(true);
    expect(values.map((v) => Number(v.replace(/,/g, "")))).toEqual([14, expect.any(Number), 1648]);
    await mapReady(page);
    await page.locator('button[data-mode="markers"]').click();
    expect(await page.locator(".leaflet-marker-icon[data-x]").count()).toBeGreaterThan(0);
  });

  test("genuinely unavailable CDN assets are NOT hidden: the map says so, the hero still renders from its own artwork", async ({ page }) => {
    cdn.down = true;
    await page.goto("/zone/1424");
    await page.getByTestId("zone-map-section").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("map-fallback")).toContainText("Map artwork unavailable");
    await expect(hero(page)).toHaveAttribute("data-artwork", "cinematic");
    await expect(hero(page).locator("img[fetchpriority=high]")).toBeVisible();
  });

  test("hero fallback: a zone without cinematic art and with a broken CDN still shows a complete hero (vector backdrop)", async ({ page }) => {
    cdn.down = true;
    await page.goto("/zone/1426");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(hero(page).locator("svg").first()).toBeVisible(); // ArcaneSurveyBanner is always underneath
    await expect(hero(page).locator("dd")).toHaveCount(3);
  });
});
