import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "./fixtures";

const PAGES = ["/", "/database", "/database?q=copper", "/item/2770", "/creature/1554", "/object/-184513", "/fishing/1420",
  "/zone/1420", "/zones", "/about/privacy", "/news", "/news/introducing-foreverdb-web", "/blog", "/blog/building-a-safe-public-database",
  "/guides", "/guides/classes", "/guides/classes/priest", "/guides/classes/priest/shadow", "/guides/races", "/guides/races/human", "/guides/races/windshaper-skyborne", "/guides/reading-observed-drop-rates", "/about/data", "/download", "/addon-companion", "/item/987654321"];

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

// Public links: every internal link reachable from the key public pages resolves, and the production navigation keeps pointing at
// /addon-companion (the Download entry stays out of the header, mobile menu and footer; the /download page itself still exists).
const LINK_SOURCES = ["/", "/addon-companion", "/download", "/about/privacy", "/about/data", "/guides", "/guides/classes", "/guides/races", "/database", "/zones", "/news"];

test("public links: every internal link from the key pages resolves", async ({ page }) => {
  const targets = new Set<string>();
  for (const from of LINK_SOURCES) {
    await page.goto(from);
    const hrefs = await page.$$eval("a[href^='/']", (as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href") ?? ""));
    for (const h of hrefs) {
      const clean = h.split("#")[0]!;
      if (clean && !clean.startsWith("//")) targets.add(clean);
    }
  }
  expect(targets.size).toBeGreaterThan(20);
  const bad: string[] = [];
  for (const t of [...targets].slice(0, 600)) {
    const r = await page.request.get(t);
    if (r.status() >= 400) bad.push(`${r.status()} ${t}`);
  }
  expect(bad).toEqual([]);
});

test("navigation: header and footer link to /addon-companion and never to /download", async ({ page }) => {
  for (const from of ["/", "/addon-companion", "/about/privacy"]) {
    await page.goto(from);
    for (const region of ["banner", "contentinfo"] as const) {
      const hrefs = await page.getByRole(region).locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
      expect(hrefs, `${region} on ${from}`).not.toContain("/download");
    }
    await expect(page.getByRole("contentinfo").locator('a[href="/addon-companion"]')).toHaveCount(1);
  }
});

test("indexing policy: /download and /addon-companion each keep their own canonical", async ({ page }) => {
  for (const p of ["/download", "/addon-companion"]) {
    await page.goto(p);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`${p}$`));
  }
});

test("privacy page: discloses accounts, cookies and analytics (no stale 'no accounts' claim)", async ({ page }) => {
  await page.goto("/about/privacy");
  const body = page.locator("main");
  await expect(body).toContainText("Accounts");
  await expect(body).toContainText("__Secure-fdb_acct");
  await expect(body).toContainText("Vercel Web Analytics");
  await expect(body).toContainText("Vercel Speed Insights performance measurement is not enabled on this site");
  await expect(body).not.toContainText("has no accounts");
  await expect(body).not.toContainText("no third-party analytics");
});
