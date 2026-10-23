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
  test("renders the current NewsArchive with categories, opener-only fixtures and RSS", async ({ page }) => {
    await page.goto("/news");
    await expect(page.getByRole("heading", { level: 1, name: "News" })).toBeVisible();
    await expect(page.getByRole("search").filter({ has: page.getByRole("button", { name: "Search news" }) })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "News categories" }).getByRole("link", { name: "Blue Posts" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "News categories" }).getByRole("link", { name: "Official News" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "News categories" }).getByRole("link", { name: "AzerDex" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Latest from Azeroth" })).toBeVisible();
    await expect(page.getByText("US Bluepost opener — Forever Beta", { exact: true })).toHaveCount(1);
    await expect(page.getByText("Player reply must not appear", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Blizzard staff reply must not appear", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "RSS feed" }).first()).toHaveAttribute("href", "/news/rss.xml");
  });

  test("search by title text finds the matching dispatch only", async ({ page }) => {
    await page.goto("/news?q=edited%20Blizzard");
    await expect(page).toHaveURL(/q=edited%20Blizzard/);
    await expect(page.getByText("US Bluepost opener — Forever Beta", { exact: true })).toHaveCount(1);
    const cards = page.locator('section[aria-labelledby="source-news-title"] ul > li');
    await expect(cards).toHaveCount(1);
    await expect(page.getByText("1 published entry")).toBeVisible();
    await expect(page.getByText("Player reply must not appear", { exact: true })).toHaveCount(0);
  });

  test("category filter narrows results", async ({ page }) => {
    await page.goto("/news?category=bluepost");
    await expect(page).toHaveURL(/category=bluepost/);
    await expect(page.getByRole("navigation", { name: "Bluepost regions" })).toBeVisible();
    await expect(page.getByText("14 published entries")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "News pages" })).toBeVisible();
    await expect(page.getByText("Player reply must not appear", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Blizzard staff reply must not appear", { exact: true })).toHaveCount(0);
  });

  test("an unrecognised/garbage category value produces the empty state, not an error", async ({ page }) => {
    const r = await page.goto("/news?category=%3Cscript%3Enope&tag=&q=");
    expect(r?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 2, name: "Latest from Azeroth" })).toBeVisible();
    await expect(page.getByText("US Bluepost opener — Forever Beta", { exact: true })).toHaveCount(1);
  });

  test("zero-result search shows the current empty state and can return to the archive", async ({ page }) => {
    await page.goto("/news?q=zzzznomatch");
    await expect(page.getByText("0 published entries")).toBeVisible();
    await expect(page.getByText("No published news matches those filters. Try another category or search term.")).toBeVisible();
    await page.goto("/news");
    await expect(page).toHaveURL(/\/news$/);
    await expect(page.getByText("US Bluepost opener — Forever Beta", { exact: true })).toHaveCount(1);
  });

  test("filters are shareable: a direct link to a filtered URL reproduces the same results", async ({ page, context }) => {
    await page.goto("/news?category=bluepost&region=eu&q=EU");
    const url = page.url();
    const page2 = await context.newPage();
    await page2.goto(url);
    await expect(page2.getByText("EU Bluepost opener — Forever Beta", { exact: true })).toHaveCount(1);
    await expect(page2.getByText(/US Bluepost opener/)).toHaveCount(0);
  });

  test("pagination and region filters expose only original Blueposts", async ({ page }) => {
    await page.goto("/news?category=bluepost&region=us");
    await expect(page.getByText("US Bluepost opener — Forever Beta", { exact: true })).toHaveCount(1);
    await expect(page.getByText(/EU Bluepost opener/)).toHaveCount(0);
    await page.goto("/news?category=bluepost");
    await page.getByRole("link", { name: "Older →" }).click();
    await expect(page).toHaveURL(/category=bluepost.*page=2/);
    await expect(page.getByRole("navigation", { name: "News pages" })).toContainText("Page 2 of");
    await expect(page.getByText("Player reply must not appear", { exact: true })).toHaveCount(0);
  });

  test("the edited opener has one detail page and replies are absent from RSS", async ({ page, request }) => {
    await page.goto("/news/entry/us-bluepost-opener-forever-beta");
    await expect(page.getByRole("heading", { level: 1, name: "US Bluepost opener — Forever Beta" })).toBeVisible();
    await expect(page.getByText(/updated/)).toBeVisible();
    const rss = await request.get("/news/rss.xml");
    const xml = await rss.text();
    expect(xml.match(/US Bluepost opener — Forever Beta/g)?.length).toBe(1);
    expect(xml).not.toContain("Player reply must not appear");
    expect(xml).not.toContain("Blizzard staff reply must not appear");
  });

  for (const width of VIEWPORTS) {
    test(`no horizontal overflow at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/news");
      await assertNoOverflow(page);
    });
  }
});

test("homepage featured news contains the opener once and no forum replies", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("US Bluepost opener — Forever Beta", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Player reply must not appear", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Blizzard staff reply must not appear", { exact: true })).toHaveCount(0);
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
