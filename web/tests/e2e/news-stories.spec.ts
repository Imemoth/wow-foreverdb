import { expect, test } from "@playwright/test";

/**
 * Global story grouping (migration 0013) against the deterministic fixture dataset: the same Blizzard announcement posted in the US and
 * EU is ONE card listing both regions, every regional source stays linked, similar-but-different posts stay separate.
 */
const GAMEPAD = "Explore WoW: Forever with a Gamepad";

test.describe("News global story grouping", () => {
  test("All regions: the shared announcement is ONE card that lists both regions", async ({ page }) => {
    await page.goto("/news?category=bluepost");
    await expect(page.getByRole("link", { name: GAMEPAD, exact: true })).toHaveCount(1);
    const card = page.locator("article", { has: page.getByRole("link", { name: GAMEPAD, exact: true }) });
    await expect(card.getByTestId("news-regions")).toHaveText(/Regions: EU · US/);
    // The latest verified official update (US only) is what the card links to.
    await expect(card.getByRole("link", { name: GAMEPAD, exact: true })).toHaveAttribute("href", "/news/entry/us-gamepad-story-update");
  });

  test("US and EU filters show the story once, with that region's own content", async ({ page }) => {
    await page.goto("/news?category=bluepost&region=us");
    await expect(page.getByRole("link", { name: GAMEPAD, exact: true })).toHaveCount(1);
    await expect(page.getByRole("link", { name: GAMEPAD, exact: true })).toHaveAttribute("href", "/news/entry/us-gamepad-story-update");
    await expect(page.getByText("EU Only Server Merge Announcement for Forever")).toHaveCount(0);
    await page.goto("/news?category=bluepost&region=eu");
    await expect(page.getByRole("link", { name: GAMEPAD, exact: true })).toHaveCount(1);
    await expect(page.getByRole("link", { name: GAMEPAD, exact: true })).toHaveAttribute("href", "/news/entry/eu-gamepad-story");
    await expect(page.getByText("US Only Maintenance Notice for Forever Realms")).toHaveCount(0);
  });

  test("US-only and EU-only announcements are labelled and appear once", async ({ page }) => {
    await page.goto("/news?category=bluepost");
    const us = page.locator("article", { has: page.getByRole("link", { name: "US Only Maintenance Notice for Forever Realms" }) });
    await expect(us.getByTestId("news-regions")).toHaveText(/US only/);
    const eu = page.locator("article", { has: page.getByRole("link", { name: "EU Only Server Merge Announcement for Forever" }) });
    await expect(eu.getByTestId("news-regions")).toHaveText(/EU only/);
  });

  test("same title with different content/wording stays two cards (never silently merged)", async ({ page }) => {
    await page.goto("/news?category=bluepost");
    await expect(page.getByRole("link", { name: "Beta Celebration Underway", exact: true })).toHaveCount(2);
  });

  test("search finds the story through either regional source and respects the region filter", async ({ page }) => {
    await page.goto("/news?category=bluepost&q=zebrafish");
    await expect(page.getByRole("link", { name: GAMEPAD, exact: true })).toHaveCount(1);
    await page.goto("/news?category=bluepost&region=eu&q=zebrafish");
    await expect(page.getByRole("link", { name: GAMEPAD, exact: true })).toHaveCount(0);
  });

  test("detail page: both official sources, per-region update history, ONE canonical URL, structured data", async ({ page }) => {
    await page.goto("/news/entry/us-gamepad-story-update");
    const sources = page.getByTestId("story-sources");
    await expect(sources).toContainText("Official sources (EU · US)");
    await expect(sources.getByTestId("story-source-us").getByRole("link", { name: /Open the US official source/ }))
      .toHaveAttribute("href", "https://us.forums.blizzard.com/en/wow/t/explore-forever-gamepad/9101/1");
    await expect(sources.getByTestId("story-source-eu").getByRole("link", { name: /Open the EU official source/ }))
      .toHaveAttribute("href", "https://eu.forums.blizzard.com/en/wow/t/explore-forever-gamepad/9102/1");
    await expect(sources.getByTestId("story-source-us").getByRole("list", { name: /Official updates in the US thread/ }).getByRole("listitem")).toHaveCount(2);
    await expect(sources.getByTestId("story-source-eu").getByRole("list")).toHaveCount(0); // EU has no update: no fake history
    await expect(page.getByTestId("news-regions")).toHaveText(/Regions: EU · US/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/news\/entry\/eu-gamepad-story$/);
    const ld = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((t) => JSON.parse(t));
    const article = ld.find((x) => x["@type"] === "NewsArticle");
    expect(article.isBasedOn.map((x: { url: string }) => x.url).sort()).toEqual([
      "https://eu.forums.blizzard.com/en/wow/t/explore-forever-gamepad/9102/1", "https://us.forums.blizzard.com/en/wow/t/explore-forever-gamepad/9101/1"]);
    expect(article.mainEntityOfPage).toMatch(/\/news\/entry\/eu-gamepad-story$/);
  });

  test("every previously published regional URL still resolves and points to the same canonical story URL", async ({ page, request }) => {
    for (const slug of ["us-gamepad-story", "eu-gamepad-story", "us-gamepad-story-update"]) {
      const res = await request.get(`/news/entry/${slug}`);
      expect(res.status(), slug).toBe(200);
      await page.goto(`/news/entry/${slug}`);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/news\/entry\/eu-gamepad-story$/);
      await expect(page.getByTestId("story-source-us")).toBeVisible();
      await expect(page.getByTestId("story-source-eu")).toBeVisible();
    }
    await page.goto("/news/entry/us-only-maintenance"); // unlinked entries are unchanged
    await expect(page.getByTestId("story-sources")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("US Only Maintenance Notice for Forever Realms");
  });

  test("RSS has one item for the shared story (a stable permalink GUID listing both regions)", async ({ request }) => {
    const xml = await (await request.get("/news/rss.xml")).text();
    const guids = [...xml.matchAll(/<guid isPermaLink="true">([^<]+)<\/guid>/g)].map((m) => m[1]!);
    expect(guids.filter((g) => /\/news\/entry\/(us|eu)-gamepad-story/.test(g))).toEqual([expect.stringMatching(/\/news\/entry\/us-gamepad-story-update$/)]);
    expect(xml).toContain("<category>eu</category><category>us</category>");
    expect(guids.filter((g) => /beta-celebration/.test(g))).toHaveLength(2); // different wording -> two items, never silently merged
  });
});
