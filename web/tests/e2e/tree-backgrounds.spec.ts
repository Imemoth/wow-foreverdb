import type { Page } from "@playwright/test";
import { TREE_BACKGROUNDS } from "../../src/lib/classes/art";
import { getTalentData } from "../../src/lib/talents/registry";
import { expect, test } from "./fixtures";

/** Talent tree backgrounds: every one of the 27 trees (9 classes x 3) shows its own approved illustration. */
const CLASS_IDS = ["druid", "hunter", "mage", "paladin", "priest", "rogue", "shaman", "warlock", "warrior"];

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const scrollThrough = (page: Page) => page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 300) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); } });

test.describe("talent tree backgrounds (27/27)", () => {
  for (const id of CLASS_IDS) {
    test(`${id}: each of the three trees shows its own illustration, readable and inert`, async ({ page }, testInfo) => {
      const mobile = testInfo.project.name === "mobile";
      const trees = getTalentData(id)!.trees;
      expect(trees).toHaveLength(3);
      await page.goto(`/guides/classes/${id}`);
      await scrollThrough(page);
      const files: string[] = [];
      for (const t of trees) {
        const stem = TREE_BACKGROUNDS[`${id}/${t.slug}`]!;
        expect(stem, `${id}/${t.slug}`).toBeTruthy();
        files.push(stem);
        const tree = page.getByTestId(`tree-${t.slug}`);
        const photo = tree.getByTestId("backdrop-photo");
        await expect(photo, t.slug).toHaveCount(1);
        await expect(photo).toHaveAttribute("aria-hidden", "true");
        await expect(photo).toHaveCSS("pointer-events", "none");
        const img = photo.getByTestId("backdrop-photo-image");
        await expect(img).toHaveAttribute("src", `/tree-backgrounds/${stem}.webp`);
        await expect(img).toHaveAttribute("srcset", `/tree-backgrounds/${stem}-600.webp 600w, /tree-backgrounds/${stem}.webp 900w`);
        await expect(img).toHaveAttribute("alt", "");
        await tree.scrollIntoViewIfNeeded();
        const loaded = await img.evaluate(async (el: HTMLImageElement) => { if (!el.complete) await new Promise((r) => { el.onload = el.onerror = r; }); return { w: el.naturalWidth, src: el.currentSrc }; });
        expect(loaded.w, t.slug).toBeGreaterThan(300);
        expect(loaded.src, t.slug).toMatch(new RegExp(`/tree-backgrounds/${stem}(-600)?\\.webp$`));
        // The picture fills the panel (minus its border) without changing its size; the vector backdrop stays underneath.
        const panel = (await tree.boundingBox())!;
        const art = (await photo.boundingBox())!;
        expect(Math.abs(art.width - panel.width), t.slug).toBeLessThanOrEqual(2);
        expect(Math.abs(art.height - panel.height), t.slug).toBeLessThanOrEqual(2);
        await expect(tree.getByTestId("backdrop-tree")).toHaveCount(1);
        // Same grid as before: 68px cells (60px on phones), no change in geometry.
        const grid = tree.getByTestId("talent-grid");
        const cols = Number(await grid.getAttribute("data-cols"));
        expect(Math.round((await grid.boundingBox())!.width / cols), t.slug).toBe(mobile ? 60 : 68);
        // Contrast: white text on the brightest 5% of the picture, after the dark scrim, stays above WCAG AA.
        const contrast = await img.evaluate((el: HTMLImageElement) => {
          const c = document.createElement("canvas");
          c.width = 90; c.height = 120;
          const ctx = c.getContext("2d")!;
          ctx.drawImage(el, 0, 0, 90, 120);
          const d = ctx.getImageData(0, 0, 90, 120).data;
          const ink = [7, 9, 28];
          const lin = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
          const vals: number[] = [];
          for (let y = 8; y < 112; y++) for (let x = 6; x < 84; x++) {
            const i = (y * 90 + x) * 4;
            const yy = y / 120;
            const a2 = yy < 0.5 ? 0.35 * (1 - yy / 0.5) : 0.4 * ((yy - 0.5) / 0.5);
            const ch = [0, 1, 2].map((k) => (d[i + k]! * 0.45 + ink[k]! * 0.55) * (1 - a2) + ink[k]! * a2);
            vals.push(0.2126 * lin(ch[0]!) + 0.7152 * lin(ch[1]!) + 0.0722 * lin(ch[2]!));
          }
          vals.sort((p, q) => p - q);
          const p95 = vals[Math.floor(vals.length * 0.95)]!;
          return 1.05 / (p95 + 0.05);
        });
        expect(contrast, `${id}/${t.slug} text contrast on the brightest part`).toBeGreaterThanOrEqual(4.5);
      }
      expect(new Set(files).size, "three different files").toBe(3);
      expect(await noOverflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test("grid, icons, connectors and interactions are unchanged on top of the art", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const pil = page.getByTestId("tree-discipline").getByRole("button", { name: /^Power in Light, rank/ });
    await pil.scrollIntoViewIfNeeded();
    await pil.click();
    await expect(pil.getByTestId("rank-badge")).toHaveText("1/5");
    await expect(page.getByTestId("points-spent")).toHaveText("1/51");
    // The art never takes a click and never sits above a node.
    const above = await pil.evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!top && el.contains(top); });
    expect(above).toBe(true);
    await expect(page.getByTestId("tree-discipline").locator("[data-link-state]").first()).toBeAttached();
    expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("rank badges keep their own fill over the art on every class", async ({ page }) => {
    for (const id of CLASS_IDS) {
      await page.goto(`/guides/classes/${id}`);
      const badge = page.getByTestId("rank-badge").first();
      await badge.scrollIntoViewIfNeeded();
      const c = await badge.evaluate((el) => { const s = getComputedStyle(el); return { color: s.color, bg: s.backgroundColor }; });
      expect(c.color, id).not.toBe(c.bg);
    }
  });

  test("if images fail, every tree falls back to its vector backdrop and the calculator keeps working", async ({ page }) => {
    await page.route("**/tree-backgrounds/**", (r) => r.abort());
    await page.goto("/guides/classes/warlock");
    await expect(page.getByTestId("backdrop-tree")).toHaveCount(3);
    const first = page.getByTestId("tree-affliction").getByRole("button").first();
    await first.scrollIntoViewIfNeeded();
    await first.click();
    await expect(page.getByTestId("points-spent")).toHaveText("1/51");
    expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("no CSP violations, failed requests or layout shift across all nine class pages", async ({ page }) => {
    const bad: string[] = [];
    page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) bad.push(m.text()); });
    page.on("response", (r) => { if (r.status() >= 400 && /tree-backgrounds/.test(r.url())) bad.push(`${r.status()} ${r.url()}`); });
    await page.addInitScript(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
    });
    for (const id of CLASS_IDS) {
      await page.goto(`/guides/classes/${id}`);
      await scrollThrough(page);
      await page.waitForTimeout(250);
      expect(await page.evaluate(() => (window as unknown as { __cls: number }).__cls), `${id} layout shift`).toBeLessThan(0.02);
    }
    expect(bad).toEqual([]);
  });
});
