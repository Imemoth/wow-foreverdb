import { expect, test } from "./fixtures";

/**
 * Phase 2-C "News & Blog" regression coverage for the News hub (search/filter/grid) and the
 * shared article reader (breadcrumb, TOC, related entries, read next). Mirrors guides.spec.ts's
 * structure; Guides keeps its own dedicated suite untouched.
 */

const VIEWPORTS = [320, 390, 440, 768, 1032, 1366, 1920];

async function assertNoOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("News landing page", () => {
  test("renders the hero, search form and the three sample dispatches with the featured one first", async ({ page }) => {
    await page.goto("/news");
    await expect(page.getByRole("heading", { level: 1, name: "News" })).toBeVisible();
    await expect(page.getByRole("search", { name: "Search News" })).toBeVisible();
    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(3);
    const titles = await cards.getByRole("heading", { level: 2 }).allTextContents();
    expect(titles[0]).toBe("Introducing the ForeverDB website (preview)");
    await expect(page.getByText("Featured", { exact: true })).toHaveCount(1);
    // Scoped to the hero: the site footer carries its own "RSS feed" link on every page.
    await expect(page.getByRole("heading", { level: 1, name: "News" }).locator("..").getByRole("link", { name: "RSS feed" })).toHaveAttribute("href", "/news/rss.xml");
  });

  test("search by title text finds the matching dispatch only", async ({ page }) => {
    await page.goto("/news?q=Guildbook");
    await expect(page).toHaveURL(/q=Guildbook/);
    await expect(page.getByRole("heading", { level: 2, name: "Companion 0.8.2 polishes the Guildbook" })).toBeVisible();
    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(1);
    await expect(page.getByText("1 article found")).toBeVisible();
  });

  test("category filter narrows results", async ({ page }) => {
    await page.goto("/news?category=Companion");
    await expect(page).toHaveURL(/category=Companion/);
    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(2);
  });

  test("an unrecognised/garbage category value produces the empty state, not an error", async ({ page }) => {
    const r = await page.goto("/news?category=%3Cscript%3Enope&tag=&q=");
    expect(r?.status()).toBe(200);
    await expect(page.getByText("No news match those filters")).toBeVisible();
  });

  test("zero-result search shows the empty state with a working clear-filters action", async ({ page }) => {
    await page.goto("/news?q=zzzznomatch");
    await expect(page.getByText("0 articles found")).toBeVisible();
    await page.getByRole("link", { name: "Clear filters" }).first().click();
    await expect(page).toHaveURL(/\/news$/);
    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(3);
  });

  test("filters are shareable: a direct link to a filtered URL reproduces the same results", async ({ page, context }) => {
    await page.goto("/news?category=Companion&tag=security");
    const url = page.url();
    const page2 = await context.newPage();
    await page2.goto(url);
    await expect(page2.getByRole("heading", { level: 2, name: "Companion adds zone browsing; backend API hardened" })).toBeVisible();
  });

  for (const width of VIEWPORTS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/news");
      await assertNoOverflow(page);
    });
  }
});

test.describe("News article reader", () => {
  test("breadcrumb, sample notice, TOC and related entries render", async ({ page }) => {
    await page.goto("/news/introducing-foreverdb-web");
    await expect(page.getByRole("heading", { level: 1, name: "Introducing the ForeverDB website (preview)" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "News" })).toBeVisible();
    await expect(page.getByText("Editorial sample.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Read next" })).toBeVisible();
  });

  test("category crumb links back into the filtered News hub", async ({ page }) => {
    await page.goto("/news/companion-guildbook-polish");
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Companion" }).click();
    await expect(page).toHaveURL(/\/news\?category=Companion/);
  });

  test("unknown slug returns 404", async ({ page }) => {
    const r = await page.goto("/news/does-not-exist");
    expect(r?.status()).toBe(404);
  });
});
