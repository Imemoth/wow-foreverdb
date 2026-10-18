import { expect, test } from "./fixtures";

/**
 * Phase 2-A "Arcane Cartography" regression coverage: the new CartographyBanner on
 * /zones, /zone/[id] and /database, the restructured 5-section /zone/[id] layout, and the
 * decorative-only enhancement to LocationPlot's background/border (markers, legend and the
 * accessible text summary must be byte-for-byte unaffected). Fixture zone 1420 is Tirisfal
 * Glades (14 sources, 1648 located observations) - the nominated first-map prototype zone;
 * Copper Vein (#1731) and Mottled Boar (#3098) both carry real location rows in the fixture
 * dataset and are reused here rather than duplicating detail-responsive.spec.ts's own setup.
 */

const VIEWPORTS = [320, 390, 430, 768, 834, 1024, 1440, 1920];

async function assertNoOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("zones page cartography", () => {
  for (const width of VIEWPORTS) {
    test(`renders the banner and zone cards with no overflow @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/zones");
      await assertNoOverflow(page);
      await expect(page.getByRole("heading", { level: 1, name: "Zones" })).toBeVisible();
      const card = page.getByRole("link", { name: /Tirisfal Glades/ });
      await expect(card).toBeVisible();
      await expect(card).toContainText("sources");
      await expect(card).toContainText("located observations");
    });
  }

  test("zone cards keep their real data, links and empty-state branch untouched", async ({ page }) => {
    await page.goto("/zones");
    for (const name of ["Durotar", "Mulgore", "Tirisfal Glades", "Silverpine Forest"]) {
      await expect(page.getByRole("link", { name: new RegExp(name) })).toBeVisible();
    }
    await page.getByRole("link", { name: /Tirisfal Glades/ }).click();
    await expect(page).toHaveURL(/\/zone\/1420$/);
  });
});

test.describe("zone detail page cartography", () => {
  for (const width of VIEWPORTS) {
    test(`renders all 5 sections with no overflow @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/zone/1420");
      await assertNoOverflow(page);

      await expect(page.getByRole("heading", { level: 1, name: "Tirisfal Glades" })).toBeVisible();
      await expect(page.getByText("uiMapID 1420")).toBeVisible();
      // 1. identity/summary stat tiles
      await expect(page.getByText("Sources", { exact: true })).toBeVisible();
      await expect(page.getByText("Located obs.", { exact: true })).toBeVisible();
      // 2. geographic observations (Tirisfal has 1648 located observations, so this always renders)
      await expect(page.getByRole("heading", { name: "Geographic observations" })).toBeVisible();
      // 3. entity categories
      await expect(page.getByRole("heading", { name: "Entity categories" })).toBeVisible();
      await expect(page.getByRole("link", { name: /^Mining/ })).toBeVisible();
      // 4. search/filter interface
      await expect(page.getByRole("heading", { name: "Search this zone" })).toBeVisible();
      await expect(page.getByLabel("Name")).toBeVisible();
      // 5. observed entities
      await expect(page.getByRole("heading", { level: 2, name: /observed (entry|entries)/ })).toBeVisible();
    });
  }

  test("existing search/filter/sort/entity-link/pagination behavior is unchanged", async ({ page }) => {
    await page.goto("/zone/1420");
    await page.getByRole("link", { name: /^Mining/ }).click();
    await expect(page).toHaveURL(/kind=mining/);
    const copperVein = page.getByRole("link", { name: "Copper Vein" }).first();
    await expect(copperVein).toBeVisible();
    await copperVein.click();
    await expect(page).toHaveURL(/\/object\/1731/);

    await page.goto("/zone/1420?q=zzzz");
    await expect(page.getByText("Nothing observed for this filter yet")).toBeVisible();

    await page.goto("/zone/1420?type=item");
    await expect(page.getByRole("columnheader", { name: "Observed in this zone" })).toBeVisible();
    await expect(page.getByText(/by inference/)).toBeVisible();
  });

  test("public-data-limitation note (DataNote) still renders between categories and search", async ({ page }) => {
    await page.goto("/zone/1420");
    await expect(page.getByText(/not a complete list of/)).toBeVisible();
    await expect(page.getByText(/AzerDex cannot tell in/)).toBeVisible();
  });
});

test.describe("LocationPlot: decorative styling never affects markers or accessibility", () => {
  test("object page: markers, legend and text-summary fallback are all present and unchanged", async ({ page }) => {
    await page.goto("/object/1731"); // Copper Vein, 34 location rows in fixture data
    const figure = page.locator("figure", { has: page.getByRole("img", { name: /Observed location density/ }) }).first();
    await expect(figure).toBeVisible();

    const svg = figure.getByRole("img");
    await expect(svg).toHaveAttribute("viewBox", "-2 -2 104 104");
    expect(await figure.locator("circle").count()).toBeGreaterThan(0);

    await expect(figure.getByRole("list", { name: "Legend" })).toBeVisible();

    const details = figure.locator("details");
    await expect(details.locator("summary")).toHaveText("Densest cells (text)");
    await details.locator("summary").click();
    await expect(details.locator("li").first()).toBeVisible();
  });

  test("creature page: each level's own location plot still renders independently", async ({ page }) => {
    await page.goto("/creature/3098"); // Mottled Boar, 57 location rows in fixture data
    const figures = page.getByRole("img", { name: /Observed location density/ });
    expect(await figures.count()).toBeGreaterThan(0);
  });
});

test.describe("database page cartography banner", () => {
  for (const width of [390, 1440]) {
    test(`compact banner renders without breaking search/filters @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/database");
      await assertNoOverflow(page);
      await expect(page.getByRole("heading", { level: 1, name: "Database" })).toBeVisible();
      await expect(page.getByRole("search", { name: "Database search and filters" })).toBeVisible();
      await expect(page.getByLabel("Name or ID")).toBeVisible();
    });
  }

  test("compact banner stays short (no giant hero) and search still works end to end", async ({ page }) => {
    await page.goto("/database");
    const banner = page.locator("div.overflow-hidden.rounded-xl.border-ink-700");
    const box = await banner.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(160); // compact prop target: h-28/h-32 (112-128px) plus padding, well under the homepage hero's scale

    await page.getByLabel("Name or ID").fill("copper");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=copper/);
    await expect(page.getByRole("link", { name: /Copper Ore/ }).first()).toBeVisible();
  });
});
