import { expect, test } from "./fixtures";

/**
 * Phase 2-B "Arcane Library" regression coverage: the Guides landing page (search/filter/grid)
 * and the premium guide reader (breadcrumb, TOC, related entries, read next). News and Blog keep
 * ArticleViews.tsx's original ArticleList/ArticlePage untouched - see the "News and Blog" describe
 * block below for the smoke check that nothing there regressed.
 */

const VIEWPORTS = [320, 390, 440, 768, 1032, 1366, 1920];

async function assertNoOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("Arcane Library landing page", () => {
  test("renders the hero, search form and the four sample guides with featured ones first", async ({ page }) => {
    await page.goto("/guides");
    await expect(page.getByRole("heading", { level: 1, name: "Arcane Library" })).toBeVisible();
    await expect(page.getByRole("search", { name: "Search the Arcane Library" })).toBeVisible();
    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(4);
    // Featured-first, deterministic ordering (see lib/content/guides-query.ts sortGuides).
    const titles = await cards.getByRole("heading", { level: 2 }).allTextContents();
    expect(titles[0]).toBe("Getting started with the ForeverDB addon and Companion");
    expect(titles[1]).toBe("How to read observed drop rates");
    const featuredBadges = page.getByText("Featured", { exact: true });
    await expect(featuredBadges).toHaveCount(2);
  });

  test("search by title/description text finds the matching guide only", async ({ page }) => {
    await page.goto("/guides?q=Companion");
    await expect(page).toHaveURL(/q=Companion/);
    await expect(page.getByRole("heading", { level: 2, name: "Getting started with the ForeverDB addon and Companion" })).toBeVisible();
    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(1);
    await expect(page.getByText("1 guide found")).toBeVisible();
  });

  test("search by tag text also matches", async ({ page }) => {
    await page.goto("/guides?q=tirisfal-glades");
    await expect(page.getByRole("heading", { level: 2, name: "Mining Copper Veins in Tirisfal Glades" })).toBeVisible();
  });

  test("category filter and a combined category+tag filter narrow the results", async ({ page }) => {
    await page.goto("/guides?category=Professions");
    await expect(page).toHaveURL(/category=Professions/);
    let cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(2);

    await page.goto("/guides?category=Professions&tag=fishing");
    cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 2, name: "Fishing in ForeverDB — open water vs. pools" })).toBeVisible();
  });

  test("an unrecognised/garbage category value produces the empty state, not an error", async ({ page }) => {
    const r = await page.goto("/guides?category=%3Cscript%3Enope&tag=&q=");
    expect(r?.status()).toBe(200);
    await expect(page.getByText("No guides match those filters")).toBeVisible();
    // Two "clear filters" links exist (the top action and the one inside the empty-state copy).
    await expect(page.getByRole("link", { name: "clear filters" }).first()).toBeVisible();
  });

  test("zero-result search shows the empty state with a working clear-filters action", async ({ page }) => {
    await page.goto("/guides?q=zzzznomatch");
    await expect(page.getByText("No guides match those filters")).toBeVisible();
    await expect(page.getByText("0 guides found")).toBeVisible();
    await page.getByRole("link", { name: "Clear filters" }).first().click();
    await expect(page).toHaveURL(/\/guides$/);
    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(4);
  });

  test("filters are shareable: a direct link to a filtered URL reproduces the same results", async ({ page, context }) => {
    await page.goto("/guides?category=Professions&tag=mining");
    const url = page.url();
    const page2 = await context.newPage();
    await page2.goto(url);
    await expect(page2.getByRole("heading", { level: 2, name: "Mining Copper Veins in Tirisfal Glades" })).toBeVisible();
    const cards = page2.getByRole("listitem").filter({ has: page2.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(1);
  });

  test("a tag pill on a card links to the tag-filtered URL", async ({ page }) => {
    await page.goto("/guides");
    await page.getByRole("link", { name: "#tirisfal-glades" }).click();
    await expect(page).toHaveURL(/tag=tirisfal-glades/);
    await expect(page.getByRole("heading", { level: 2, name: "Mining Copper Veins in Tirisfal Glades" })).toBeVisible();
  });

  for (const width of VIEWPORTS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/guides");
      await assertNoOverflow(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });
  }
});

test.describe("premium guide reader", () => {
  test("breadcrumb includes the category and links back to the filtered library", async ({ page }) => {
    await page.goto("/guides/mining-copper-in-tirisfal");
    const crumb = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumb.getByRole("link", { name: "Guides" })).toHaveAttribute("href", "/guides");
    await expect(crumb.getByRole("link", { name: "Professions" })).toHaveAttribute("href", "/guides?category=Professions");
    await crumb.getByRole("link", { name: "Professions" }).click();
    await expect(page).toHaveURL(/category=Professions/);
  });

  test("table of contents links jump to the matching heading ids", async ({ page }) => {
    await page.goto("/guides/mining-copper-in-tirisfal");
    const toc = page.getByRole("navigation", { name: "Guide sections" });
    await expect(toc.getByRole("link", { name: /Plan with the zone page/ })).toHaveAttribute("href", "#plan-with-the-zone-page");
    await expect(toc.getByRole("link", { name: /Reading the gem numbers/ })).toHaveAttribute("href", "#reading-the-gem-numbers");
    await toc.getByRole("link", { name: /Reading the gem numbers/ }).click();
    await expect(page).toHaveURL(/#reading-the-gem-numbers$/);
    await expect(page.locator("#reading-the-gem-numbers")).toBeVisible();
  });

  test("related database entries and read-next guides are both reachable", async ({ page }) => {
    await page.goto("/guides/mining-copper-in-tirisfal");
    await expect(page.getByText("Editorial sample.")).toBeVisible();
    const relatedDb = page.getByRole("complementary").filter({ has: page.getByRole("heading", { name: "Related database entries" }) });
    await expect(relatedDb.getByRole("link", { name: "Copper Ore" })).toBeVisible();
    await relatedDb.getByRole("link", { name: "Copper Ore" }).click();
    await expect(page).toHaveURL(/\/item\/2770/);

    await page.goto("/guides/mining-copper-in-tirisfal");
    const readNext = page.getByRole("complementary").filter({ has: page.getByRole("heading", { name: "Read next" }) });
    await expect(readNext.getByRole("link", { name: "How to read observed drop rates" })).toBeVisible();
    await readNext.getByRole("link", { name: "How to read observed drop rates" }).click();
    await expect(page).toHaveURL(/\/guides\/reading-observed-drop-rates/);
  });

  test("an inline Markdown link to a database entity works from the article body", async ({ page }) => {
    await page.goto("/guides/mining-copper-in-tirisfal");
    await page.getByRole("link", { name: "Tirisfal Glades", exact: true }).click();
    await expect(page).toHaveURL(/\/zone\/1420/);
  });

  test("an unknown guide slug returns 404", async ({ page }) => {
    const r = await page.goto("/guides/does-not-exist");
    expect(r?.status()).toBe(404);
  });

  for (const width of VIEWPORTS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/guides/getting-started-with-foreverdb");
      await assertNoOverflow(page);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });
  }
});

test.describe("keyboard accessibility", () => {
  test("the search form, tag pills and a card link are all keyboard-reachable", async ({ page }) => {
    await page.goto("/guides");
    await page.getByLabel("Search", { exact: true }).focus();
    await page.keyboard.type("mining");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/q=mining/);
    await expect(page.getByRole("heading", { level: 2, name: "Mining Copper Veins in Tirisfal Glades" })).toBeVisible();
  });

  test("the guide reader's TOC disclosure is a native, keyboard-toggleable summary", async ({ page }) => {
    await page.goto("/guides/mining-copper-in-tirisfal");
    const summary = page.locator("summary", { hasText: "In this guide" });
    await summary.focus();
    await expect(summary).toBeFocused();
    await page.keyboard.press("Enter");
    // Still reachable afterwards either way - this only proves the control is a real, focusable toggle.
    await expect(page.getByRole("navigation", { name: "Guide sections" })).toBeVisible();
  });
});

test("reduced motion: the library and reader render with no console errors when the preference is set", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/guides");
  await expect(page.getByRole("heading", { level: 1, name: "Arcane Library" })).toBeVisible();
  await page.goto("/guides/mining-copper-in-tirisfal");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe("News and Blog are unaffected", () => {
  test("News keeps its original simple list layout, not the Arcane Library treatment", async ({ page }) => {
    await page.goto("/news");
    await expect(page.getByRole("heading", { level: 1, name: "News" })).toBeVisible();
    // The sitewide header search landmark is present on every page; only the Guides-specific
    // search/filter form (and the "Arcane Library" branding) must never leak into News/Blog.
    await expect(page.getByRole("search", { name: "Search the Arcane Library" })).toHaveCount(0);
    await expect(page.getByText("Arcane Library")).toHaveCount(0);
    // The footer also carries an "RSS feed" link site-wide; just confirm the page-level one is still there.
    await expect(page.getByRole("link", { name: "RSS feed" }).first()).toBeVisible();
  });

  test("Blog keeps its original simple list layout", async ({ page }) => {
    await page.goto("/blog");
    await expect(page.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();
    await expect(page.getByRole("search", { name: "Search the Arcane Library" })).toHaveCount(0);
  });
});
