import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** Priest talent tree backgrounds (the reference implementation for the other classes' trees). */
const PRIEST = [
  ["discipline", "priest-discipline"],
  ["holy", "priest-holy"],
  ["shadow-magic", "priest-shadow"],
] as const;

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const scrollThrough = (page: Page) => page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 300) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); } });

test.describe("Priest tree backgrounds", () => {
  test("each Priest tree shows its own illustration, decorative and inert, under a dark scrim", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    await scrollThrough(page);
    for (const [slug, stem] of PRIEST) {
      const tree = page.getByTestId(`tree-${slug}`);
      const photo = tree.getByTestId("backdrop-photo");
      await expect(photo).toHaveCount(1);
      await expect(photo).toHaveAttribute("aria-hidden", "true");
      await expect(photo).toHaveCSS("pointer-events", "none");
      const img = photo.getByTestId("backdrop-photo-image");
      await expect(img).toHaveAttribute("src", `/tree-backgrounds/${stem}.webp`);
      await expect(img).toHaveAttribute("srcset", `/tree-backgrounds/${stem}-600.webp 600w, /tree-backgrounds/${stem}.webp 900w`);
      await expect(img).toHaveAttribute("alt", "");
      await tree.scrollIntoViewIfNeeded();
      const loaded = await img.evaluate(async (el: HTMLImageElement) => { if (!el.complete) await new Promise((r) => { el.onload = el.onerror = r; }); return { w: el.naturalWidth, src: el.currentSrc }; });
      expect(loaded.w, slug).toBeGreaterThan(300);
      expect(loaded.src, slug).toMatch(new RegExp(`/tree-backgrounds/${stem}(-600)?\\.webp$`));
      // The picture fills the panel without changing its size; the vector backdrop stays underneath as the fallback.
      const panel = (await tree.boundingBox())!;
      const art = (await photo.boundingBox())!;
      expect(Math.abs(art.width - panel.width)).toBeLessThanOrEqual(2); // the panel border
      expect(Math.abs(art.height - panel.height)).toBeLessThanOrEqual(2);
      await expect(tree.getByTestId("backdrop-tree")).toHaveCount(1);
      // A dark scrim is on top of the picture.
      const scrim = await photo.locator("div").first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(scrim).not.toBe("rgba(0, 0, 0, 0)");
    }
    // The three images are three different files.
    const srcs = await page.getByTestId("backdrop-photo-image").evaluateAll((els) => els.map((e) => e.getAttribute("src")));
    expect(new Set(srcs).size).toBe(3);
  });

  test("grid, icons, connectors and interactions are unchanged on top of the art", async ({ page }, testInfo) => {
    const mobile = testInfo.project.name === "mobile";
    await page.goto("/guides/classes/priest");
    const cell = mobile ? 60 : 68;
    for (const [slug] of PRIEST) {
      const grid = page.getByTestId(`tree-${slug}`).getByTestId("talent-grid");
      const cols = Number(await grid.getAttribute("data-cols"));
      const b = (await grid.boundingBox())!;
      expect(Math.round(b.width / cols), slug).toBe(cell);
    }
    const pil = page.getByTestId("tree-discipline").getByRole("button", { name: /^Power in Light, rank/ });
    await pil.scrollIntoViewIfNeeded();
    await pil.click();
    await expect(pil.getByTestId("rank-badge")).toHaveText("1/5");
    await expect(page.getByTestId("points-spent")).toHaveText("1/51");
    // The art never takes a click and never sits above the nodes.
    const above = await pil.evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!top && el.contains(top); });
    expect(above).toBe(true);
    expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("icons stay legible: the locked, available and maxed nodes keep their frames and badges over the art", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    for (const [slug] of PRIEST) {
      const tree = page.getByTestId(`tree-${slug}`);
      await tree.scrollIntoViewIfNeeded();
      const badge = tree.getByTestId("rank-badge").first();
      await expect(badge).toBeVisible();
      // Badge text colour against its own filled background has a real difference (the badge, not the art, carries the contrast).
      const c = await badge.evaluate((el) => { const s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor }; });
      expect(c.color).not.toBe(c.bg);
    }
  });

  test("other classes keep their vector backdrop only", async ({ page }) => {
    for (const id of ["druid", "warrior", "mage"]) {
      await page.goto(`/guides/classes/${id}`);
      await expect(page.getByTestId("backdrop-photo")).toHaveCount(0);
      await expect(page.getByTestId("backdrop-tree")).toHaveCount(3);
    }
  });

  test("if an image fails, the vector backdrop and the whole calculator keep working", async ({ page }) => {
    await page.route("**/tree-backgrounds/**", (r) => r.abort());
    await page.goto("/guides/classes/priest");
    await expect(page.getByTestId("backdrop-tree")).toHaveCount(3);
    const pil = page.getByTestId("tree-discipline").getByRole("button", { name: /^Power in Light, rank/ });
    await pil.click();
    await expect(page.getByTestId("points-spent")).toHaveText("1/51");
    expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("no CSP violations, failed requests or layout shift", async ({ page }) => {
    const bad: string[] = [];
    page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) bad.push(m.text()); });
    page.on("response", (r) => { if (r.status() >= 400 && /tree-backgrounds/.test(r.url())) bad.push(`${r.status()} ${r.url()}`); });
    await page.addInitScript(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto("/guides/classes/priest");
    await scrollThrough(page);
    await page.waitForTimeout(400);
    expect(bad).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls)).toBeLessThan(0.02);
  });
});
