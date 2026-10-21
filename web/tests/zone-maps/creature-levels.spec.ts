// Creature pages: level selector + level-aware, zone-independent map (P2-Z3 follow-up).
// Plain Playwright test (not ../e2e/fixtures): the cross-origin manifest fetch must look like what a real browser sends; the CDN is a real
// local HTTPS server on the allow-listed host name (see cdn-server.ts), so Chromium itself enforces CSP and CORS.
//
//  - /creature/1547 is the real fixture creature (levels 5 and 6, Tirisfal Glades) rendered by the real page.
//  - /test-fixtures/creature-map/<scenario> feeds synthetic SourceDetails (several zones, zones without published cells, a level with no
//    cell, ...) into the SAME SourceDetailView; the fixture dataset has none of those shapes. It 404s unless E2E_FIXTURES_ENABLED=1.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { settle } from "../e2e/maps-helpers";
import { startCdn, type Cdn } from "./cdn-server";

let cdn: Cdn;
test.beforeAll(async () => { cdn = await startCdn(); });
test.afterAll(async () => { await cdn.close(); });
test.beforeEach(() => { cdn.stripCors = false; cdn.down = false; cdn.seen.length = 0; });

const harness = (scenario: string, qs = "") => `/test-fixtures/creature-map/${scenario}${qs}`;
const markers = (page: Page) => page.locator(".leaflet-marker-icon[data-x]");
const selector = (page: Page) => page.getByTestId("level-selector");
const levelButton = (page: Page, level: number | "all") => selector(page).locator(`button[data-level="${level}"]`);
const zoneButton = (page: Page, mapId: number) => page.getByTestId("source-maps").locator(`button[data-zone-id="${mapId}"]`);
const sectionVisible = (page: Page, level: number) => page.locator(`#level-${level}`);

/** The map of the page mounted (it loads lazily near the viewport) and its artwork decoded. */
async function mapReady(page: Page) {
  await page.getByTestId("source-maps").scrollIntoViewIfNeeded();
  await page.getByTestId("zone-map").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector("[data-testid=zone-map]")?.getAttribute("data-ready") === "true");
  await page.waitForFunction(() => ((document.querySelector(".leaflet-image-layer") as HTMLImageElement | null)?.naturalWidth ?? 0) > 100);
  await settle(page);
}

async function noHorizontalOverflow(page: Page) {
  const o = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
  expect(o.scroll, "no horizontal page scroll").toBeLessThanOrEqual(o.inner + 1);
}

test.describe("real creature page (fixture 1547: levels 5 and 6)", () => {
  test("selector is built from the observed levels; each level filters the real markers and keeps its own statistics", async ({ page }) => {
    const detail = (await (await page.request.get("/api/v1/source/creature/1547")).json()).data;
    const cells = (lvl: number) => (detail.locations as { level: number; mapId: number }[]).filter((l) => l.level === lvl).length;
    const levels = [...new Set((detail.variants as { level: number }[]).map((v) => v.level))].sort((a, b) => a - b);
    expect(levels).toEqual([5, 6]);
    expect(cells(5)).toBeGreaterThan(0);
    expect(cells(6)).toBeGreaterThan(0);

    await page.goto("/creature/1547");
    await expect(selector(page)).toBeVisible();
    await expect(selector(page).getByRole("button")).toHaveText([/All levels/, /Level 5/, /Level 6/]);
    await expect(levelButton(page, "all")).toHaveAttribute("aria-pressed", "true");
    // default: every level's own statistics are visible, nothing merged
    await expect(sectionVisible(page, 5)).toBeVisible();
    await expect(sectionVisible(page, 6)).toBeVisible();
    await mapReady(page);
    expect(await markers(page).count()).toBe(cells(5) + cells(6));

    await levelButton(page, 6).click();
    await expect(levelButton(page, 6)).toHaveAttribute("aria-pressed", "true");
    await expect(sectionVisible(page, 6)).toBeVisible();
    await expect(sectionVisible(page, 5)).toBeHidden();
    await expect.poll(() => markers(page).count()).toBe(cells(6));
    expect(page.url()).toContain("level=6");
    await expect(page.getByTestId("source-map-plotted")).toContainText("level 6");
    await expect(page.getByTestId("level-stats-link")).toHaveAttribute("href", "#level-6");

    // the selection survives a reload (server-rendered from ?level=)
    await page.reload();
    await expect(levelButton(page, 6)).toHaveAttribute("aria-pressed", "true");
    await expect(sectionVisible(page, 5)).toBeHidden();
    await mapReady(page);
    await expect.poll(() => markers(page).count()).toBe(cells(6));

    await levelButton(page, 5).click();
    await expect.poll(() => markers(page).count()).toBe(cells(5));
    await markers(page).first().click({ force: true });
    await expect(page.getByTestId("detail-panel")).toContainText("Level");
    await levelButton(page, "all").click();
    await expect.poll(() => markers(page).count()).toBe(cells(5) + cells(6));
    expect(page.url()).not.toContain("level=");
    await expect(sectionVisible(page, 5)).toBeVisible();
  });

  test("an unobserved ?level= is ignored and #level-N selects that level", async ({ page }) => {
    await page.goto("/creature/1547?level=9");
    await expect(levelButton(page, "all")).toHaveAttribute("aria-pressed", "true");
    await page.goto("/creature/1547#level-6");
    await expect(levelButton(page, 6)).toHaveAttribute("aria-pressed", "true");
    await expect(sectionVisible(page, 5)).toBeHidden();
    await page.goto("/creature/1547?level=abc");
    await expect(levelButton(page, "all")).toHaveAttribute("aria-pressed", "true");
  });

  test("soft navigation into a creature page (?level=) loads the map from the CDN and honours the level", async ({ page }) => {
    const failed: string[] = [];
    page.on("requestfailed", (r) => { if (new URL(r.url()).hostname === "azerdex-assets.pages.dev") failed.push(r.url()); });
    await page.goto("/");
    await page.waitForFunction(() => Boolean((window as unknown as { next?: { router?: unknown } }).next?.router));
    await page.evaluate(() => (window as unknown as { next: { router: { push: (h: string) => void } } }).next.router.push("/creature/1547?level=5"));
    await expect(selector(page)).toBeVisible();
    await expect(levelButton(page, 5)).toHaveAttribute("aria-pressed", "true");
    await mapReady(page);
    expect(failed).toEqual([]);
  });
});

test.describe("#level-N navigation selects the level (same page, client-side, history)", () => {
  const nav = (page: Page, href: string) =>
    page.evaluate((h) => (window as unknown as { next: { router: { push: (h: string) => void } } }).next.router.push(h), href);

  test("a marker's source link (next/link to /creature/<id>#level-N) selects that level on the same page", async ({ page }) => {
    await page.goto("/creature/1547");
    await mapReady(page);
    await levelButton(page, 6).click();
    await levelButton(page, "all").click();
    await markers(page).first().click({ force: true });
    const link = page.getByTestId("detail-source-link").first();
    const href = (await link.getAttribute("href")) ?? "";
    const level = Number(/#level-(\d+)$/.exec(href)?.[1]);
    expect([5, 6]).toContain(level);
    await link.click();
    await expect(levelButton(page, level)).toHaveAttribute("aria-pressed", "true");
    await expect(sectionVisible(page, level === 5 ? 6 : 5)).toBeHidden();
    await expect(sectionVisible(page, level)).toBeVisible();
    await expect.poll(() => page.url()).toContain(`#level-${level}`);
  });

  test("router.push of a #level-N URL on the same page, then another level, then browser back/forward", async ({ page }) => {
    await page.goto("/creature/1547");
    await page.waitForFunction(() => Boolean((window as unknown as { next?: { router?: unknown } }).next?.router));
    await nav(page, "/creature/1547#level-6");
    await expect(levelButton(page, 6)).toHaveAttribute("aria-pressed", "true");
    await expect(sectionVisible(page, 5)).toBeHidden();
    await nav(page, "/creature/1547#level-5");
    await expect(levelButton(page, 5)).toHaveAttribute("aria-pressed", "true");
    await expect(sectionVisible(page, 6)).toBeHidden();
    await page.goBack();
    await expect(levelButton(page, 6)).toHaveAttribute("aria-pressed", "true");
    await page.goForward();
    await expect(levelButton(page, 5)).toHaveAttribute("aria-pressed", "true");
  });

  test("a plain in-page #level-N anchor and a selector pick keep each other consistent", async ({ page }) => {
    await page.goto("/creature/1547");
    await levelButton(page, 5).click();
    await page.evaluate(() => { window.location.hash = "#level-6"; });
    await expect(levelButton(page, 6)).toHaveAttribute("aria-pressed", "true");
    await levelButton(page, "all").click();
    await expect(levelButton(page, "all")).toHaveAttribute("aria-pressed", "true");
    expect(page.url()).not.toContain("#level-");
  });

  test("soft navigation from another page to /creature/<id>#level-N selects the level and loads the map", async ({ page }) => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean((window as unknown as { next?: { router?: unknown } }).next?.router));
    await nav(page, "/creature/1547#level-6");
    await expect(levelButton(page, 6)).toHaveAttribute("aria-pressed", "true");
    await mapReady(page);
  });
});

test.describe("creature without published locations (reference: Chakuyak, levels 5 and 6, Mulgore)", () => {
  test("shows the real zone artwork, an explicit notice, no invented marker; level stats remain reachable", async ({ page }) => {
    await page.goto(harness("no-locations"));
    await expect(page.getByTestId("source-no-locations")).toContainText("No published locations yet");
    await expect(page.getByTestId("source-no-locations")).toContainText("Mulgore");
    await mapReady(page);
    expect(await markers(page).count()).toBe(0);
    await expect(page.getByTestId("map-fallback")).toHaveCount(0);
    await expect(page.getByTestId("map-no-observations")).toBeVisible();
    // no coordinate-grid fallback is offered for an empty selection and no zone map link invents a focus
    await expect(page.getByTestId("source-grid-fallback")).toHaveCount(0);
    await expect(selector(page).getByRole("button")).toHaveText([/All levels/, /Level 5/, /Level 6/]);
    await levelButton(page, 5).click();
    await expect(page.getByTestId("source-no-locations")).toContainText("level 5");
    await expect(sectionVisible(page, 5)).toBeVisible();
    await expect(sectionVisible(page, 6)).toBeHidden();
    await expect(page.getByTestId("source-show-all-levels")).toHaveCount(0); // nothing to show at any level
  });
});

test.describe("creature with located levels", () => {
  test("level selection filters markers, never merges, and drops a hidden marker's details", async ({ page }) => {
    await page.goto(harness("multi-level"));
    await mapReady(page);
    await expect.poll(() => markers(page).count()).toBe(4);
    await levelButton(page, 5).click();
    await expect.poll(() => markers(page).count()).toBe(2);
    await markers(page).first().click({ force: true });
    await expect(page.getByTestId("detail-panel")).toContainText(/Level\s*5/);
    await levelButton(page, 6).click();
    await expect.poll(() => markers(page).count()).toBe(2);
    await expect(page.getByTestId("detail-panel")).toContainText("Select a marker");
    await expect(page.getByTestId("source-map-plotted")).toContainText("4");
    // each level keeps its own observation count in the selector and its own section
    await expect(levelButton(page, 5)).toContainText("6 obs.");
    await expect(levelButton(page, 6)).toContainText("4 obs.");
    await expect(page.locator("#lvl-min")).toHaveCount(0); // the page selector replaces the min/max level inputs
  });

  test("a level without published cells in the zone explains itself and offers 'Show all levels'", async ({ page }) => {
    await page.goto(harness("level-empty"));
    await mapReady(page);
    await levelButton(page, 6).click();
    await expect(page.getByTestId("source-no-locations")).toContainText("No published locations yet");
    await expect(page.getByTestId("source-no-locations")).toContainText("level 6");
    await expect.poll(() => markers(page).count()).toBe(0);
    await page.getByTestId("source-show-all-levels").click();
    await expect(levelButton(page, "all")).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => markers(page).count()).toBe(2);
  });

  test("a single observed level shows no selector", async ({ page }) => {
    await page.goto(harness("single-level"));
    await expect(selector(page)).toHaveCount(0);
    await mapReady(page);
    await expect.poll(() => markers(page).count()).toBe(2);
  });
});

test.describe("creature observed in several zones: zone and level are independent", () => {
  test("zone buttons, per-level counts and the unpublished zone with artwork", async ({ page }) => {
    await page.goto(harness("multi-zone"));
    await mapReady(page);
    await expect(page.getByTestId("source-maps").getByRole("group", { name: "Zone" }).getByRole("button")).toHaveCount(3);
    await expect(zoneButton(page, 1420)).toContainText("Tirisfal Glades");
    await expect(zoneButton(page, 1411)).toContainText("no published locations");
    await expect.poll(() => markers(page).count()).toBe(4); // Mulgore: default zone (most observations)

    await zoneButton(page, 1420).click();
    await mapReady(page);
    await expect.poll(() => markers(page).count()).toBe(3);
    await levelButton(page, 5).click(); // level 5 was never published in Tirisfal
    await expect(page.getByTestId("source-no-locations")).toContainText("level 5");
    await expect(page.getByTestId("source-show-all-levels")).toBeVisible();
    await expect(zoneButton(page, 1420)).toContainText("no published locations");
    await expect(zoneButton(page, 1412)).toContainText("2 locations");

    await zoneButton(page, 1412).click(); // the level stays, the zone changes
    await mapReady(page);
    await expect(levelButton(page, 5)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => markers(page).count()).toBe(2);

    await zoneButton(page, 1411).click(); // observed + artwork, nothing publishable at all
    await mapReady(page);
    await expect(page.getByTestId("source-no-locations")).toContainText("Durotar");
    expect(await markers(page).count()).toBe(0);
    await levelButton(page, "all").click();
    await expect(page.getByTestId("source-no-locations")).toContainText("Durotar");
    await expect(page.getByTestId("source-no-locations")).toContainText("no map cell has reached the publication threshold");
  });
});

test.describe("accessibility and responsive layout", () => {
  for (const scenario of ["multi-zone", "no-locations"]) {
    test(`${scenario}: no horizontal overflow, selectors reachable, axe clean`, async ({ page }) => {
      await page.goto(harness(scenario));
      await mapReady(page);
      await noHorizontalOverflow(page);
      await levelButton(page, 6).scrollIntoViewIfNeeded();
      await expect(levelButton(page, 6)).toBeVisible();
      await levelButton(page, 6).click();
      await noHorizontalOverflow(page);
      const axe = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
    });
  }

  test("the selector buttons are keyboard operable", async ({ page }) => {
    await page.goto(harness("multi-level"));
    await levelButton(page, 5).focus();
    await page.keyboard.press("Enter");
    await expect(levelButton(page, 5)).toHaveAttribute("aria-pressed", "true");
    await expect(sectionVisible(page, 6)).toBeHidden();
  });
});

test.describe("fail-closed harness and unchanged item pages", () => {
  test("unknown scenario 404s; item pages still have no map", async ({ page }) => {
    expect((await page.goto(harness("nope")))?.status()).toBe(404);
    await page.goto("/item/2770");
    await expect(page.getByTestId("source-maps")).toHaveCount(0);
    await expect(page.getByTestId("level-selector")).toHaveCount(0);
  });
});
