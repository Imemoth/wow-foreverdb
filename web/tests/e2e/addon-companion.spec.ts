import { expect, test } from "./fixtures";

/**
 * "Addon & Companion - Coming Soon" landing page (/addon-companion). The existing /download page is intentionally
 * untouched and must keep working exactly as before; the global navigation carries no Download entry.
 */
const WIDTHS = [320, 390, 768, 1024, 1366, 1920];

test.describe("/addon-companion", () => {
  test("shows the coming-soon content, two product cards and a way back to the database", async ({ page }) => {
    await page.goto("/addon-companion");
    await expect(page.getByRole("heading", { level: 1, name: "Your next adventure is loading." })).toBeVisible();
    await expect(page.getByText("Addon & Companion", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Coming Soon", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "WoW Addon" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 3, name: "Windows Companion" })).toBeVisible();
    await page.getByRole("link", { name: "Back to the AzerDex Database" }).click();
    await expect(page).toHaveURL(/\/database$/);
  });

  test("offers no download, installer or progress affordance", async ({ page }) => {
    await page.goto("/addon-companion");
    const main = page.getByRole("main");
    await expect(main.locator('a[href*="download" i], a[download], a[href$=".exe"], a[href$=".zip"], a[href$=".msi"]')).toHaveCount(0);
    await expect(main.getByRole("button")).toHaveCount(0);
    await expect(main.getByRole("progressbar")).toHaveCount(0);
    await expect(main.locator("progress")).toHaveCount(0);
  });

  test("keeps the global navigation free of a Download entry", async ({ page }) => {
    await page.goto("/addon-companion");
    for (const name of ["Database", "Zones", "Guides", "News", "Blog"]) {
      await expect(page.getByRole("navigation", { name: "Primary" }).first().getByRole("link", { name })).toBeAttached();
    }
    await expect(page.locator('header a[href="/download"], footer a[href="/download"]')).toHaveCount(0);
  });

  for (const width of WIDTHS) {
    test(`has no horizontal overflow @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/addon-companion");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("homepage CTA and the untouched /download page", () => {
  test("the homepage 'Get the addon & Companion' CTA opens /addon-companion", async ({ page }) => {
    await page.goto("/");
    const cta = page.getByRole("link", { name: "Get the addon & Companion" });
    await expect(cta).toHaveAttribute("href", "/addon-companion");
    await cta.click();
    await expect(page).toHaveURL(/\/addon-companion$/);
    await expect(page.getByRole("heading", { level: 1, name: "Your next adventure is loading." })).toBeVisible();
  });

  test("/download is not redirected and still renders its own page", async ({ page }) => {
    const res = await page.goto("/download");
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(/\/download$/);
    await expect(page.getByRole("heading", { level: 1, name: "Addon & Companion" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Addon & Companion sections" })).toBeVisible();
  });
});
