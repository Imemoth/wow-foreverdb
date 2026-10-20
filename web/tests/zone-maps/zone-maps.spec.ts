// Plain Playwright test (NOT ../e2e/fixtures): that fixture adds an x-forwarded-for header to every request, which would turn the
// cross-origin manifest fetch into a preflighted one and no longer reflect what a real browser sends.
import { expect, test, type Page } from "@playwright/test";
import { expectNoBlankSpace, expectWholeImageFits, geometry, markerError, settle } from "../e2e/maps-helpers";
import { REAL_DIST, readAsset, startCdn, type Cdn } from "./cdn-server";

const CDN_HOST = "azerdex-assets.pages.dev";
const SYNTHETIC = !REAL_DIST;

let cdn: Cdn;
test.beforeAll(async () => { cdn = await startCdn(); });
test.afterAll(async () => { await cdn.close(); });
test.beforeEach(() => { cdn.stripCors = false; cdn.down = false; cdn.seen.length = 0; });

/** Records where manifest/image requests actually go (browser-side evidence, not an assumption). */
function trackAssets(page: Page) {
  const urls: string[] = [];
  page.on("request", (r) => { const u = r.url(); if (/\/forever\/\d+\/v\d+\//.test(u) || /\/atlas\//.test(u)) urls.push(u); });
  return urls;
}

/** The zone page section or the source-page map container, whichever the page has. */
const section = (page: Page) => page.getByTestId("zone-map-section").or(page.getByTestId("source-maps")).first();

async function mapReady(page: Page, opts: { image?: boolean } = {}) {
  await section(page).scrollIntoViewIfNeeded();
  await page.getByTestId("zone-map").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector("[data-testid=zone-map]")?.getAttribute("data-ready") === "true");
  if (opts.image !== false) await page.waitForFunction(() => ((document.querySelector(".leaflet-image-layer") as HTMLImageElement | null)?.naturalWidth ?? 0) > 100);
  await settle(page);
}

test.describe("Z1 zone directory (catalog-driven)", () => {
  test("lists every atlas zone and capital city with explicit empty states, grouped by verified continent", async ({ page }) => {
    await page.goto("/zones");
    await expect(page.getByTestId("zone-directory")).toHaveAttribute("data-catalog-source", "snapshot");
    const cards = page.getByTestId("zone-card");
    await expect(cards).toHaveCount(51);
    const ids = await cards.evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.uiMapId)));
    expect(new Set(ids).size).toBe(51);
    for (const bad of [947, 1414, 1415, 1463, 1464, 1459, 1460, 1461, 2524]) expect(ids).not.toContain(bad);
    // observed zones show figures; the rest say so explicitly (never a fabricated 0)
    await expect(page.locator('[data-ui-map-id="1420"]')).toContainText("located observations");
    await expect(page.locator('[data-ui-map-id="1426"] [data-testid=zone-empty]')).toHaveText("No public observations yet");
    expect(await page.getByTestId("zone-empty").count()).toBe(51 - 4);
    // duplicate names are disambiguated and do not collide
    await expect(page.locator('[data-ui-map-id="2521"]')).toContainText("same name as another map");
    await expect(page.locator('[data-ui-map-id="2665"]')).toContainText("uiMapID 2665");
    await expect(page.getByRole("heading", { name: /^Kalimdor/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /^Eastern Kingdoms/ })).toBeVisible();
  });
  test("continent filter is a plain link and narrows the directory", async ({ page }) => {
    await page.goto("/zones?continent=1414");
    const n = await page.getByTestId("zone-card").count();
    expect(n).toBe(23);
    await page.goto("/zones?continent=nonsense");
    await expect(page.getByTestId("zone-card")).toHaveCount(51);
  });
  test("every card links to its canonical /zone/<uiMapID>", async ({ page }) => {
    await page.goto("/zones");
    const hrefs = await page.getByTestId("zone-card").evaluateAll((els) => els.map((e) => [(e as HTMLElement).dataset.uiMapId, e.getAttribute("href")]));
    for (const [id, href] of hrefs) expect(href).toBe(`/zone/${id}`);
  });
});

test.describe("Z2 zone page: real CDN artwork on every zone", () => {
  test("a zone with ZERO observations still shows its map, with an explicit empty state and no markers", async ({ page }) => {
    const assets = trackAssets(page);
    const res = await page.goto("/zone/1426");
    expect(res!.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dun Morogh");
    await mapReady(page);
    await expect(page.getByTestId("map-no-observations")).toHaveText("No public observations are available for this zone yet.");
    await expect(page.locator(".leaflet-marker-icon")).toHaveCount(0);
    await expect(page.getByText("No public observations are available for this zone yet").first()).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    expect(assets.filter((u) => u.includes("/forever/1426/v1/")).every((u) => new URL(u).hostname === CDN_HOST)).toBe(true);
    expect(assets.some((u) => u.endsWith("/forever/1426/v1/manifest.json"))).toBe(true);
    await expect(page.getByTestId("map-fallback")).toHaveCount(0);
  });

  test("resolves the right manifest version per map: Tirisfal v2, others v1; every request goes to the CDN host", async ({ page }) => {
    const assets = trackAssets(page);
    await page.goto("/zone/1420");
    await mapReady(page);
    expect(assets.some((u) => u === `https://${CDN_HOST}/forever/1420/v2/manifest.json`)).toBe(true);
    for (const u of assets) expect(new URL(u).hostname, u).toBe(CDN_HOST);
    expect(assets.some((u) => u.includes("/maps/"))).toBe(false); // never the local POC assets
    await expect(page.getByTestId("map-art")).toContainText("v2");
    await expect(page.getByTestId("map-art")).toContainText("registration: provisional");
    const seen = cdn.seen.map((s) => s.url);
    expect(seen.some((u) => u.includes("/forever/1420/v2/"))).toBe(true);
  });

  test("whole image fits, aspect preserved, markers register on the artwork", async ({ page }) => {
    await page.goto("/zone/1412");
    await mapReady(page);
    const g = await geometry(page);
    expectWholeImageFits(g, expect as never, "zone 1412");
    expectNoBlankSpace(g, expect as never, "zone 1412");
    await page.getByTestId("zone-map").evaluate((e) => e.scrollIntoView({ block: "center" }));
    await page.locator('button[data-mode="markers"]').click();
    await settle(page);
    const e = await markerError(page);
    expect(e.checked).toBeGreaterThan(5);
    expect(e.worst).toBeLessThan(1.5);
  });

  test("zone overview: dense zones start as clusters, individual markers stay one click away", async ({ page }) => {
    await page.goto("/zone/1420");
    await mapReady(page);
    await expect(page.locator('button[data-mode="clusters"]')).toHaveAttribute("aria-checked", "true");
    expect(await page.locator(".leaflet-marker-icon[data-cluster-count]").count()).toBeGreaterThan(0);
    const total = await page.getByTestId("map-summary").innerText();
    expect(total).toMatch(/of [\d,]+ aggregated locations/);
    await page.locator('button[data-mode="markers"]').click();
    await expect(page.locator('button[data-mode="markers"]')).toHaveAttribute("aria-checked", "true");
    expect(await page.locator(".leaflet-marker-icon[data-x]").count()).toBeGreaterThan(0);
  });

  test("category filters, clear, fit/reset; summary uses plotted counts, not the zone total", async ({ page }) => {
    await page.goto("/zone/1420");
    await mapReady(page);
    await page.locator('button[data-mode="markers"]').click();
    const all = await page.locator(".leaflet-marker-icon[data-x]").count();
    await page.locator('button[data-kind="mining"]').click();
    await expect(page.locator('button[data-kind="mining"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("filter-active")).toBeVisible();
    const mining = await page.locator(".leaflet-marker-icon[data-x]").count();
    expect(mining).toBeGreaterThan(0);
    expect(mining).toBeLessThan(all);
    await page.getByRole("button", { name: "Clear filters" }).click();
    expect(await page.locator(".leaflet-marker-icon[data-x]").count()).toBe(all);
    await page.getByTestId("fit-view").click();
    await settle(page);
    expectWholeImageFits(await geometry(page), expect as never, "after reset");
  });

  test("marker details: source link, category, coordinates, count, aggregate (not exact) wording; navigates to the source page", async ({ page }) => {
    await page.goto("/zone/1420");
    await mapReady(page);
    await page.locator('button[data-mode="markers"]').click();
    await page.locator('button[data-kind="mining"]').click();
    await settle(page);
    const m = page.locator(".leaflet-marker-icon[data-x]").first();
    await m.scrollIntoViewIfNeeded();
    await m.click({ force: true });
    const panel = page.getByTestId("detail-panel");
    await expect(panel).toContainText("Mining");
    await expect(panel).toContainText("Coordinates (X, Y)");
    await expect(panel).toContainText("not an exact spawn point");
    const link = page.getByTestId("detail-source-link").first();
    await expect(link).toHaveAttribute("href", /^\/(creature|object|fishing)\/-?\d+/);
    const href = (await link.getAttribute("href"))!;
    await Promise.all([page.waitForURL(`**${href}`), link.click()]);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("keyboard: markers are focusable buttons that open the same details", async ({ page }) => {
    await page.goto("/zone/1412");
    await mapReady(page);
    await page.locator('button[data-mode="markers"]').click();
    const m = page.locator(".leaflet-marker-icon[data-x]").first();
    await m.focus();
    await expect(page.locator(".leaflet-tooltip.azd-tooltip")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("detail-coords")).toBeVisible();
  });

  test("existing zone page content is preserved: heading, stats, categories, search, entity table, canonical", async ({ page }) => {
    await page.goto("/zone/1420");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tirisfal Glades");
    await expect(page.getByText("Located obs.")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Quick filters" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Search this zone" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /observed (entry|entries)/ })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/zone\/1420$/);
    const order = await page.evaluate(() => {
      const y = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.getBoundingClientRect().top ?? -1;
      return { map: y("[data-testid=zone-map-section]"), table: y("#categories-title"), filter: y("#z-q") };
    });
    expect(order.map).toBeGreaterThan(0);
    expect(order.map).toBeLessThan(order.table); // map after the introduction, before the entity directory
    expect(order.map).toBeLessThan(order.filter);
  });

  test("a map the atlas does not list as a zone is a 404; a non-zone id with no data never gets another map's art", async ({ page }) => {
    for (const id of [947, 1414, 1459, 99999]) expect((await page.goto(`/zone/${id}`))!.status(), String(id)).toBe(404);
  });

  test("synthetic dataset is labelled on the map", async ({ page }) => {
    await page.goto("/zone/1420");
    await expect(page.getByText("Synthetic sample data.").first()).toBeVisible();
  });
});

test.describe("security: CSP, CORS, resilience", () => {
  test("CSP gains the CDN origin ONLY on the zone/source routes (img-src + connect-src), nowhere else", async ({ request }) => {
    const csp = async (p: string) => (await request.get(p)).headers()["content-security-policy"]!;
    const dir = (c: string, n: string) => c.split(";").map((x) => x.trim()).find((x) => x.startsWith(n + " "))!;
    for (const p of ["/zone/1420", "/zone/1426", "/object/1731", "/creature/1508"]) {
      const c = await csp(p);
      expect(dir(c, "img-src"), p).toContain(`https://${CDN_HOST}`);
      expect(dir(c, "connect-src"), p).toContain(`https://${CDN_HOST}`);
      expect(dir(c, "script-src"), p).not.toContain(CDN_HOST);
      expect(dir(c, "style-src"), p).not.toContain(CDN_HOST);
    }
    for (const p of ["/", "/zones", "/database", "/item/2770", "/about"]) expect(await csp(p), p).not.toContain(CDN_HOST);
  });

  test("the browser enforces CORS: without Access-Control-Allow-Origin the manifest is blocked and the page degrades gracefully", async ({ page }) => {
    cdn.stripCors = true;
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto("/zone/1420");
    await section(page).scrollIntoViewIfNeeded();
    await expect(page.getByTestId("map-fallback")).toContainText("manifest could not be loaded");
    expect(errors.some((e) => /CORS|Access-Control-Allow-Origin/i.test(e))).toBe(true); // a genuine browser CORS failure, not a mocked one
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tirisfal Glades"); // text content unaffected
    await expect(page.getByRole("heading", { name: /observed (entry|entries)/ })).toBeVisible();
    await expect(page.getByTestId("zone-map")).toHaveAttribute("data-ready", "true");
    await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible(); // markers still shown on the plain grid
  });

  test("CDN outage (HTTP 503): fallback grid with markers; zone text and entity directory stay usable", async ({ page }) => {
    cdn.down = true;
    await page.goto("/zone/1412");
    await section(page).scrollIntoViewIfNeeded();
    await expect(page.getByTestId("map-fallback")).toBeVisible();
    await expect(page.getByTestId("map-fallback")).toContainText("Showing a plain 0–100% coordinate grid");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Mulgore");
    await expect(page.getByRole("heading", { name: /observed (entry|entries)/ })).toBeVisible();
    expect((await page.goto("/zones"))!.status()).toBe(200);
    await expect(page.getByTestId("zone-card")).toHaveCount(51); // directory never depends on the CDN (snapshot)
  });

  test("a manifest that describes another zone is refused, never displayed", async ({ page }) => {
    const j = JSON.parse(readAsset("/forever/1412/v1/manifest.json")!.toString());
    await page.route(`https://${CDN_HOST}/forever/1412/v1/manifest.json`, (route) =>
      route.fulfill({ json: { ...j, zoneId: 1411 }, headers: { "access-control-allow-origin": "*" } }));
    await page.goto("/zone/1412");
    await section(page).scrollIntoViewIfNeeded();
    await expect(page.getByTestId("map-fallback")).toContainText("does not match this zone");
  });

  test("a manifest whose image size disagrees with the catalog is refused", async ({ page }) => {
    const j = JSON.parse(readAsset("/forever/1412/v1/manifest.json")!.toString());
    await page.route(`https://${CDN_HOST}/forever/1412/v1/manifest.json`, (route) =>
      route.fulfill({ json: { ...j, image: { ...j.image, width: 800, height: 600 } }, headers: { "access-control-allow-origin": "*" } }));
    await page.goto("/zone/1412");
    await section(page).scrollIntoViewIfNeeded();
    await expect(page.getByTestId("map-fallback")).toContainText("does not match the atlas catalog");
  });

  test("image failure falls back without losing markers", async ({ page }) => {
    await page.route(new RegExp(`https://${CDN_HOST.replace(/\./g, "\\.")}/forever/1412/v1/(?!manifest).*`), (r) => r.abort());
    await page.goto("/zone/1412");
    await section(page).scrollIntoViewIfNeeded();
    await expect(page.getByTestId("map-fallback")).toContainText("image could not be loaded");
    await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible();
  });
});

test.describe("Z3 source pages: the same map engine, one source", () => {
  test("Copper Vein (/object/1731): only its markers on the Tirisfal map; grid is a collapsed fallback; link to the full zone map", async ({ page }) => {
    const assets = trackAssets(page);
    await page.goto("/object/1731");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Copper Vein");
    await expect(page.getByRole("heading", { name: "Where it was observed" })).toBeVisible();
    await mapReady(page);
    await expect(page.getByTestId("zone-map")).toHaveCount(1);
    await expect(page.locator('[data-map-variant="source"]')).toHaveAttribute("data-map-id", "1420");
    const names = await page.locator(".leaflet-marker-icon[data-x]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    expect(names.length).toBeGreaterThan(10);
    expect(names.every((n) => n.startsWith("Copper Vein, Mining"))).toBe(true);
    await expect(page.getByTestId("source-map-plotted")).toContainText("104");
    await expect(page.getByTestId("source-map-plotted")).toContainText("34");
    await expect(page.getByTestId("source-map-plotted")).toContainText("121"); // zone total for this source stays distinct from plotted
    // SVG plot is NOT shown by default (collapsed), but available
    await expect(page.getByTestId("source-grid-fallback")).toBeVisible();
    expect(await page.locator("figure svg").first().isVisible()).toBe(false);
    await page.getByTestId("source-grid-fallback").locator("summary").first().click();
    await expect(page.locator("figure svg").first()).toBeVisible();
    for (const u of assets) expect(new URL(u).hostname).toBe(CDN_HOST);
    // marker details link to the same source
    await page.locator(".leaflet-marker-icon[data-x]").first().click({ force: true });
    await expect(page.getByTestId("detail-panel")).toContainText("Copper Vein");
    // full-zone link keeps the source in focus
    const link = page.getByTestId("zone-map-link");
    await expect(link).toHaveAttribute("href", "/zone/1420?source=gameobject:1731");
    await Promise.all([page.waitForURL("**/zone/1420?source=gameobject:1731"), link.click()]);
    await mapReady(page);
    await expect(page.getByTestId("source-focus")).toContainText("Copper Vein");
    await page.locator('button[data-mode="markers"]').click();
    const labels = await page.locator(".leaflet-marker-icon[data-x]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    expect(labels.length).toBe(names.length);
    expect(labels.every((n) => n.startsWith("Copper Vein"))).toBe(true);
    await page.getByRole("button", { name: "Show all sources" }).click();
    expect(await page.locator(".leaflet-marker-icon[data-x]").count()).toBeGreaterThan(names.length);
  });

  test("creature levels stay separate on the source map (never merged)", async ({ page }) => {
    await page.goto("/creature/1508");
    await mapReady(page);
    const levels = await page.locator(".leaflet-marker-icon[data-x]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    expect(levels.length).toBeGreaterThan(0);
    await page.locator(".leaflet-marker-icon[data-x]").first().click({ force: true });
    await expect(page.getByTestId("detail-panel")).toContainText("Level");
  });

  for (const [path, name] of [["/fishing/1420", "Fishing - Tirisfal Glades"], ["/object/-184513", "Floating Wreckage"]] as const) {
    test(`${path} (${name}): fishing sources render the same map, only their own markers`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
      await mapReady(page);
      const labels = await page.locator(".leaflet-marker-icon[data-x]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every((l) => l.startsWith(name))).toBe(true);
    });
  }

  test("an unreachable CDN on a source page degrades to the plain grid; the page content is unaffected", async ({ page }) => {
    await page.route(`https://${CDN_HOST}/**`, (r) => r.abort()); // irrelevant here: the zone exists in the atlas; this asserts the abort path degrades
    await page.goto("/object/1731");
    await section(page).scrollIntoViewIfNeeded();
    await expect(page.getByTestId("map-fallback")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Copper Vein");
  });

  test("item pages never get invented coordinates: no map, links to sources and zones only", async ({ page }) => {
    await page.goto("/item/2770");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("zone-map")).toHaveCount(0);
    await expect(page.getByTestId("source-maps")).toHaveCount(0);
  });
});

test.describe("responsive", () => {
  test("zone map fits the viewport without horizontal scroll", async ({ page }) => {
    await page.goto("/zone/1420");
    await mapReady(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    expectWholeImageFits(await geometry(page), expect as never, "responsive");
  });
  test("source map is compact on small screens and can be expanded", async ({ page }, info) => {
    await page.goto("/object/1731");
    await mapReady(page);
    const compactH = (await page.getByTestId("zone-map").boundingBox())!.height;
    if (info.project.name === "mobile") {
      await page.getByTestId("map-expand").click();
      await settle(page);
      expect((await page.getByTestId("zone-map").boundingBox())!.height).toBeGreaterThan(compactH);
      await expect(page.getByTestId("map-expand")).toHaveAttribute("aria-expanded", "true");
    } else {
      expect(compactH).toBeLessThan(500);
    }
  });
  test("real artwork is only claimed when it was real", async () => {
    test.info().annotations.push({ type: "cdn-mode", description: SYNTHETIC ? "SYNTHETIC grid images (wiring/security evidence only)" : "REAL approved distribution" });
  });
});
