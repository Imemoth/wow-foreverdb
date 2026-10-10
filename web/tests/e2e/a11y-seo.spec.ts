import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

const PAGES = ["/", "/database", "/database?q=copper", "/item/2770", "/creature/1554", "/object/-184513", "/fishing/1420",
  "/zone/1420", "/zones", "/news", "/guides/reading-observed-drop-rates", "/about/data", "/download", "/item/987654321"];

for (const path of PAGES) {
  test(`WCAG 2.2 AA automated checks: ${path}`, async ({ page }) => {
    await page.goto(path);
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.help}`)).toEqual([]);
  });
}

test("keyboard: skip link and visible focus reach the main content", async ({ page }) => {
  await page.goto("/item/2770");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main/);
});

test("SEO: canonical, description, breadcrumbs JSON-LD, preview noindex", async ({ page }) => {
  await page.goto("/item/2770?utm_source=x");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/item\/2770$/);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /Copper Ore \(item 2770\)/);
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(ld.some((t) => t.includes('"BreadcrumbList"'))).toBe(true);
  // Local/preview builds are never indexable.
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  const robots = await (await page.request.get("/robots.txt")).text();
  expect(robots).toContain("Disallow: /");
});
