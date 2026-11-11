import { expect, test } from "./fixtures";

/**
 * Phase 2-C "News & Blog" regression coverage for the Blog hub and the shared article reader, extended for the two
 * WoW: Forever launch posts (illustrated covers, card thumbnails, SEO metadata). With three published articles the
 * hub renders the ordinary card grid; the single-result spotlight path (one unfiltered article) is exercised by the
 * filtered view below. Multi-article search/filter behavior is covered by news.spec.ts and guides.spec.ts against the
 * same lib/content/article-query.ts implementation.
 */

const GUIDE = "wow-forever-beginners-guide-2026";
const COMBOS = "wow-forever-new-race-class-combinations";

const VIEWPORTS = [320, 390, 440, 768, 1032, 1366, 1920];

async function assertNoOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("Blog landing page", () => {
  test("renders the hero, search form and one card per published article, each with its own cover art", async ({ page }) => {
    await page.goto("/blog");
    await expect(page.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();
    await expect(page.getByRole("search", { name: "Search the Blog" })).toBeVisible();
    const cards = page.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 2 }) });
    await expect(cards).toHaveCount(3);
    // Featured first, then newest: Beginner's Guide (featured), Race & Class (4 Nov), the older engineering sample.
    await expect(cards.nth(0).getByRole("heading", { level: 2 })).toHaveText(/Beginner's Guide/);
    await expect(cards.nth(0).getByText("Featured", { exact: true })).toBeVisible();
    await expect(cards.nth(1).getByRole("heading", { level: 2 })).toHaveText(/Race & Class Combinations/);
    await expect(cards.nth(2).getByRole("heading", { level: 2 })).toHaveText("Building a public database without exposing private data");
    // Distinct, content-specific thumbnails (never the generic hub art, never shared between posts); the sample stays text-only.
    const a = await cards.nth(0).locator("img[src*='content-images']").getAttribute("src");
    const b = await cards.nth(1).locator("img[src*='content-images']").getAttribute("src");
    expect(a).toBe(`/content-images/blog/${GUIDE}-card.webp`);
    expect(b).toBe(`/content-images/blog/${COMBOS}-card.webp`);
    await expect(cards.nth(2).locator("img[src*='content-images']")).toHaveCount(0);
    for (const i of [0, 1]) {
      const img = cards.nth(i).locator("img[src*='content-images']");
      await expect(img).toHaveAttribute("alt", /.{20,}/);
      expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(800);
    }
    // The global hub artwork is unchanged.
    await expect(page.locator("img[src='/blog/blog-writers-study-hero.webp']")).toHaveCount(1);
    // Blog has no RSS feed (only News does) - the link must not leak into this hero.
    await expect(page.getByRole("heading", { level: 1, name: "Blog" }).locator("..").getByRole("link", { name: "RSS feed" })).toHaveCount(0);
  });

  test("a filter that leaves one article still renders it as a card, and the hub intro mentions player guides", async ({ page }) => {
    await page.goto("/blog?tag=architecture");
    await expect(page.getByText("1 article found")).toBeVisible();
    await expect(page.getByRole("link", { name: "Building a public database without exposing private data" })).toBeVisible();
    await expect(page.getByText(/Player guides for WoW: Forever/)).toBeVisible();
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

test.describe("WoW: Forever launch posts", () => {
  for (const [slug, h1, alt, region] of [
    [GUIDE, "WoW: Forever Beginner's Guide (2026): 9 Things to Know Before You Start", "Adventurer surveying a sunlit fantasy landscape before beginning a journey", "Getting Started"],
    [COMBOS, "WoW: Forever Race & Class Combinations: 6 New Choices and the Skyborne", "Undead holy knight and dwarven elemental mystic representing new character combinations", "Character Creation"],
  ] as const) {
    test(`${slug}: illustrated hero, single h1, toc, metadata and structured data`, async ({ page }) => {
      const res = await page.goto(`/blog/${slug}`);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1, name: h1 })).toBeVisible();
      const hero = page.getByRole("img", { name: alt });
      await expect(hero).toBeVisible();
      expect(await hero.evaluate((el: HTMLImageElement) => [el.complete, el.naturalWidth, el.naturalHeight, el.getAttribute("fetchpriority")])).toEqual([true, 1920, 1080, "high"]);
      await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: region })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Blog sections" })).toBeVisible();
      await expect(page.getByText("Editorial sample.")).toHaveCount(0);
      // SEO
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `http://localhost:3200/blog/${slug}`);
      await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "article");
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", `http://localhost:3200/content-images/blog/${slug}-social.webp`);
      await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute("content", "1200");
      await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
      await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute("content", `http://localhost:3200/content-images/blog/${slug}-social.webp`);
      // Local E2E is not an indexable deployment: noindex must be present (staging/preview never indexed).
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').allTextContents()).find((t) => t.includes("BlogPosting"))!);
      expect(ld["@type"]).toBe("BlogPosting");
      expect(ld.headline).toBe(h1);
      expect(ld.image).toEqual([`http://localhost:3200/content-images/blog/${slug}-social.webp`, `http://localhost:3200/content-images/blog/${slug}.webp`]);
      expect(ld.mainEntityOfPage).toBe(`http://localhost:3200/blog/${slug}`);
    });

    test(`${slug}: every internal link in the article resolves (no 404s) and external links are official Blizzard pages`, async ({ page, request }) => {
      await page.goto(`/blog/${slug}`);
      const hrefs = await page.locator("article a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
      const internal = [...new Set(hrefs.filter((h) => h.startsWith("/")))];
      expect(internal.length).toBeGreaterThan(5);
      for (const h of internal) expect((await request.get(h)).status(), h).toBe(200);
      for (const h of hrefs.filter((x) => x.startsWith("http"))) expect(new URL(h).hostname).toMatch(/^(news|worldofwarcraft)\.blizzard\.com$/);
    });
  }

  test("the articles link to each other", async ({ page }) => {
    await page.goto(`/blog/${GUIDE}`);
    await page.locator("article").getByRole("link", { name: "new race-and-class combinations guide" }).click();
    await expect(page).toHaveURL(new RegExp(`/blog/${COMBOS}$`));
    await page.locator("article").getByRole("link", { name: "WoW: Forever Beginner's Guide" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/blog/${GUIDE}$`));
  });

  for (const slug of [GUIDE, COMBOS]) {
    for (const width of VIEWPORTS) {
      test(`${slug}: no horizontal overflow at ${width}px, hero image is not clipped to nothing`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/blog/${slug}`);
        await assertNoOverflow(page);
        // The cover spans the viewport up to 1600px, then stays 1600px wide and anchored to the right edge (the hero background fills the
        // rest): a full-width 16:9 image in a ~600px band would crop the subject's head on very wide screens.
        const box = await page.locator("header img").first().boundingBox();
        expect(Math.abs(box!.width - Math.min(width, 1600))).toBeLessThanOrEqual(2);
        expect(Math.abs(box!.x + box!.width - width)).toBeLessThanOrEqual(2);
        expect(box!.height).toBeGreaterThan(280);
        if (width >= 1600) expect(box!.height).toBeGreaterThanOrEqual(640);
      });
    }
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
