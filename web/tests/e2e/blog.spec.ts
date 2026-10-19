import { expect, test } from "./fixtures";

/**
 * Phase 2-C "News & Blog" regression coverage for the Blog hub and the shared article reader.
 * The current sample set has exactly one published Blog article, so this suite focuses on the
 * hub rendering correctly with a single result and the reader's structural elements; the
 * multi-article search/filter behavior is covered exhaustively by news.spec.ts and
 * guides.spec.ts against the same lib/content/article-query.ts implementation.
 */

const VIEWPORTS = [320, 390, 440, 768, 1032, 1366, 1920];

async function assertNoOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("Blog landing page", () => {
  test("renders the hero, search form and the one sample article", async ({ page }) => {
    await page.goto("/blog");
    await expect(page.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();
    await expect(page.getByRole("search", { name: "Search the Blog" })).toBeVisible();
    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 2, name: "Building a public database without exposing private data" })).toBeVisible();
    // Blog has no RSS feed (only News does) - the link must not leak into this hero. (The site
    // footer carries its own "RSS feed" link on every page, Blog included - that one is expected.)
    await expect(page.getByRole("heading", { level: 1, name: "Blog" }).locator("..").getByRole("link", { name: "RSS feed" })).toHaveCount(0);
  });

  test("search narrows to zero with the accessible empty state", async ({ page }) => {
    await page.goto("/blog?q=zzzznomatch");
    await expect(page.getByText("No blog match those filters")).toBeVisible();
    await page.getByRole("link", { name: "Clear filters" }).first().click();
    await expect(page).toHaveURL(/\/blog$/);
  });

  for (const width of VIEWPORTS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/blog");
      await assertNoOverflow(page);
    });
  }
});

test.describe("Blog article reader", () => {
  test("breadcrumb, metadata and safe Markdown content render", async ({ page }) => {
    await page.goto("/blog/building-a-safe-public-database");
    await expect(page.getByRole("heading", { level: 1, name: "Building a public database without exposing private data" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Blog" })).toBeVisible();
    await expect(page.getByText("Editorial sample.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "One-way publication" })).toBeVisible();
  });

  test("category crumb links back into the filtered Blog hub", async ({ page }) => {
    await page.goto("/blog/building-a-safe-public-database");
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Engineering" }).click();
    await expect(page).toHaveURL(/\/blog\?category=Engineering/);
  });

  test("unknown slug returns 404", async ({ page }) => {
    const r = await page.goto("/blog/does-not-exist");
    expect(r?.status()).toBe(404);
  });
});
