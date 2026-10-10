import { expect, test } from "./fixtures";

for (const path of ["/", "/database?q=copper", "/item/2770", "/creature/1554", "/zone/1420", "/guides/reading-observed-drop-rates"]) {
  test(`mobile layout has no horizontal page scroll: ${path}`, async ({ page }) => {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
}
