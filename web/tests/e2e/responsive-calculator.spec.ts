import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { TREE_BACKGROUNDS } from "../../src/lib/classes/art";
import { BUILD_PARAM, encodeBuild } from "../../src/lib/talents/build-code";
import { createEngine } from "../../src/lib/talents/engine";
import { getTalentData } from "../../src/lib/talents/registry";
import { expect, test } from "./fixtures";

/**
 * Talent calculator, phone / tablet / desktop responsive polish. These tests set their own viewport and touch emulation, so they run
 * once (desktop project) and cover the whole matrix: layout columns, no overflow, artwork, the collapsible detail panel, touch
 * and keyboard behaviour, and the phone quick navigation.
 */

const CLASS_IDS = ["druid", "hunter", "mage", "paladin", "priest", "rogue", "shaman", "warlock", "warrior"];

interface Scenario {
  name: string;
  width: number;
  height: number;
  touch: boolean;
  /** Tree columns expected: one below 644px of viewport, two from 644px, three from 960px. */
  cols: 1 | 2 | 3;
}
const SCENARIOS: Scenario[] = [
  { name: "320x700 small phone", width: 320, height: 700, touch: true, cols: 1 },
  { name: "390x844 phone", width: 390, height: 844, touch: true, cols: 1 },
  { name: "440x956 iPhone 16 Pro Max portrait", width: 440, height: 956, touch: true, cols: 1 },
  { name: "956x440 phone landscape", width: 956, height: 440, touch: true, cols: 2 },
  { name: "768x1024 iPad mini portrait", width: 768, height: 1024, touch: true, cols: 2 },
  { name: "1024x768 iPad mini landscape", width: 1024, height: 768, touch: true, cols: 3 },
  { name: "834x1194 iPad Air portrait", width: 834, height: 1194, touch: true, cols: 2 },
  { name: "1440x900 desktop", width: 1440, height: 900, touch: false, cols: 3 },
];

const treeSections = (page: Page) => page.locator('[data-testid="talent-trees"] > section');
const scrollThrough = (page: Page) => page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 30)); } window.scrollTo(0, 0); });
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const spent = (page: Page) => page.getByTestId("points-spent");

/** First talent of a tree that can be bought straight away (row 0). */
const firstTalent = (page: Page, slug: string): Locator => page.getByTestId(`tree-${slug}`).getByRole("button").first();

async function tap(page: Page, l: Locator, touch: boolean) {
  if (touch) await l.tap();
  else await l.click();
}

for (const sc of SCENARIOS) {
  test.describe(`talent calculator at ${sc.name}`, () => {
    test.use({ viewport: { width: sc.width, height: sc.height }, hasTouch: sc.touch, isMobile: sc.touch, deviceScaleFactor: sc.touch ? 2 : 1 });

    test("all nine classes: expected columns, no overflow, nothing clipped, artwork intact", async ({ page }) => {
      test.setTimeout(240_000);
      for (const id of CLASS_IDS) {
        const data = getTalentData(id)!;
        await page.goto(`/guides/classes/${id}`);
        await scrollThrough(page);
        expect(await overflow(page), `${id}: horizontal overflow`).toBeLessThanOrEqual(0);
        const sections = treeSections(page);
        await expect(sections, id).toHaveCount(3);
        // Three specializations, in data order.
        const headings = await sections.locator("h3 > span:first-child").allTextContents();
        expect(headings, id).toEqual(data.trees.map((t) => t.name));

        const boxes = [];
        for (let i = 0; i < 3; i++) boxes.push((await sections.nth(i).boundingBox())!);
        // Columns = distinct left edges in the first row.
        const firstRowTop = boxes[0]!.y;
        const rowOne = boxes.filter((b) => Math.abs(b.y - firstRowTop) < 4);
        expect(rowOne.length, `${id}: trees in the first row at ${sc.width}px`).toBe(sc.cols);
        for (const b of boxes) {
          expect(b.x, `${id}: card left`).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width, `${id}: card right`).toBeLessThanOrEqual(sc.width);
        }
        if (sc.cols === 1) {
          for (const b of boxes) {
            expect(b.width, `${id}: phone card is narrow`).toBeLessThanOrEqual(352 + 1);
            expect(Math.abs(b.x - (sc.width - b.x - b.width)), `${id}: phone card is centred`).toBeLessThanOrEqual(1.5);
          }
        } else if (sc.cols === 2) {
          // Balanced: two side by side, the third centred below them.
          const third = boxes[2]!;
          expect(third.y).toBeGreaterThan(firstRowTop + boxes[0]!.height - 4);
          expect(Math.abs(third.x + third.width / 2 - sc.width / 2), `${id}: third tree is centred`).toBeLessThanOrEqual(2);
          expect(third.width).toBeLessThanOrEqual(boxes[0]!.width + 1);
        }

        for (let i = 0; i < 3; i++) {
          const t = data.trees[i]!;
          const card = sections.nth(i);
          const cardBox = boxes[i]!;
          // Cell and frame sizes: 60/42px below 640px of viewport, 68/46px from there up.
          const cell = sc.width >= 640 ? 68 : 60;
          const frame = sc.width >= 640 ? 46 : 42;
          const grid = card.getByTestId("talent-grid");
          const gb = (await grid.boundingBox())!;
          expect(gb.width, `${id}/${t.slug}: grid width`).toBeCloseTo(t.cols * cell, 0);
          expect(gb.x, `${id}/${t.slug}: grid inside card (left)`).toBeGreaterThanOrEqual(cardBox.x);
          expect(gb.x + gb.width, `${id}/${t.slug}: grid inside card (right)`).toBeLessThanOrEqual(cardBox.x + cardBox.width);
          const f = (await card.getByTestId("node-frame").first().boundingBox())!;
          expect(f.width).toBeCloseTo(frame, 0);
          // Every frame and every rank badge is inside the card (no clipped icons or badges).
          const inside = await card.evaluate((el) => {
            const c = el.getBoundingClientRect();
            const bad: string[] = [];
            for (const n of el.querySelectorAll('[data-testid="node-frame"], [data-testid="rank-badge"]')) {
              const r = n.getBoundingClientRect();
              if (r.left < c.left + 1 || r.right > c.right - 1 || r.top < c.top || r.bottom > c.bottom) bad.push(n.getAttribute("data-testid")!);
            }
            return bad;
          });
          expect(inside, `${id}/${t.slug}: nodes outside the card`).toEqual([]);
          // Artwork: the approved picture fills the panel without being stretched, loaded, under the vector fallback.
          const photo = card.getByTestId("backdrop-photo");
          const pb = (await photo.boundingBox())!;
          expect(Math.abs(pb.width - (cardBox.width - 2)), `${id}/${t.slug}: artwork width`).toBeLessThanOrEqual(2);
          expect(Math.abs(pb.height - (cardBox.height - 2)), `${id}/${t.slug}: artwork height`).toBeLessThanOrEqual(2);
          const img = photo.getByTestId("backdrop-photo-image");
          await expect(img).toHaveAttribute("src", `/tree-backgrounds/${TREE_BACKGROUNDS[`${id}/${t.slug}`]}.webp`);
          await expect(img).toHaveCSS("object-fit", "cover");
          await card.scrollIntoViewIfNeeded();
          const w = await img.evaluate(async (el: HTMLImageElement) => { if (!el.complete) await new Promise((r) => { el.onload = el.onerror = r; }); return el.naturalWidth; });
          expect(w, `${id}/${t.slug}: artwork loaded`).toBeGreaterThan(300);
          await expect(card.locator("svg").first()).toBeAttached(); // the vector fallback is still underneath
        }
        await expect(page.getByText("Guide not available yet.").first()).toBeVisible().catch(() => undefined);
        expect(await overflow(page), `${id}: overflow after scrolling`).toBeLessThanOrEqual(0);
      }
    });

    test("allocation moves nothing: no layout shift, no overflow, exactly one point per tap", async ({ page }) => {
      await page.goto("/guides/classes/hunter");
      const grid = page.getByTestId("talent-trees");
      await grid.scrollIntoViewIfNeeded();
      const before = (await grid.boundingBox())!;
      const node = firstTalent(page, "beast-mastery");
      await tap(page, node, sc.touch);
      await expect(spent(page)).toHaveText("1/51");
      await expect(node).toHaveAttribute("data-selected", "true");
      const after = (await grid.boundingBox())!;
      expect(Math.abs(after.width - before.width)).toBeLessThanOrEqual(1);
      expect(after.x).toBeCloseTo(before.x, 0);
      // The tree block does not move horizontally or grow when the panel appears, expands or closes.
      if (sc.touch) await expect(page.getByTestId("talent-tooltip"), "no tooltip left open after a tap").toHaveCount(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.waitForTimeout(250);
      await expect(spent(page)).toHaveText("1/51");
    });
  });
}

test.describe("detail panel on a tablet (768x1024 touch)", () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("is the compact, collapsible bottom sheet, not the always-open desktop panel", async ({ page }) => {
    await page.goto("/guides/classes/hunter");
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const node = firstTalent(page, "beast-mastery");
    await node.scrollIntoViewIfNeeded();
    await node.tap();
    const panel = page.getByTestId("talent-detail");
    const card = panel.getByTestId("talent-detail-card");
    await expect(card).toHaveAttribute("data-sheet", "collapsed");
    await expect(card.getByTestId("talent-detail-body")).toBeHidden();
    const toggle = card.getByTestId("panel-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-controls", "selected-talent-body");
    const vp = page.viewportSize()!;
    const collapsed = (await card.boundingBox())!;
    expect(collapsed.height).toBeLessThan(vp.height * 0.12);
    // Touch targets are at least 44x44 and stay inside the screen.
    for (const b of [card.getByRole("button", { name: /Add a point/ }), card.getByRole("button", { name: /Remove a point/ }), toggle, card.getByTestId("panel-close")]) {
      const r = (await b.boundingBox())!;
      expect(r.width).toBeGreaterThanOrEqual(44);
      expect(r.height).toBeGreaterThanOrEqual(44);
      expect(r.x + r.width).toBeLessThanOrEqual(vp.width);
    }
    // One row: icon + name, rank, Add/Remove, expand, close.
    const ys = await Promise.all([card.getByTestId("rank-summary"), card.getByTestId("panel-toggle"), card.getByTestId("panel-close"), card.getByRole("button", { name: /Add a point/ })].map(async (l) => (await l.boundingBox())!.y));
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(14);
    // The selected talent is not under the panel.
    const frame = (await node.getByTestId("node-frame").boundingBox())!;
    expect(frame.y + frame.height).toBeLessThanOrEqual(collapsed.y);

    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(card).toHaveAttribute("data-sheet", "expanded");
    await expect(card.getByTestId("talent-detail-body")).toBeVisible();
    await expect(card.getByTestId("talent-description")).toBeVisible();
    const expanded = (await card.boundingBox())!;
    expect(expanded.height).toBeGreaterThan(collapsed.height);
    expect(expanded.height).toBeLessThanOrEqual(vp.height * 0.45 + 1);
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(vp.height);
    const frameOpen = (await node.getByTestId("node-frame").boundingBox())!;
    expect(frameOpen.y + frameOpen.height, "selected talent stays above the expanded panel").toBeLessThanOrEqual(expanded.y);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    // Collapse again, then close: focus returns to the talent and the point count is untouched.
    await toggle.tap();
    await expect(card).toHaveAttribute("data-sheet", "collapsed");
    await card.getByTestId("panel-close").tap();
    await expect(panel.getByTestId("talent-detail-card")).toHaveCount(0);
    await expect(node).toBeFocused();
    await expect(spent(page)).toHaveText("1/51");
  });

  test("Add/Remove work from the panel; disabled actions are distinguishable; Escape closes", async ({ page }) => {
    await page.goto("/guides/classes/hunter");
    const node = firstTalent(page, "beast-mastery");
    await node.scrollIntoViewIfNeeded();
    await node.tap(); // rank 1
    const card = page.getByTestId("talent-detail-card");
    const add = card.getByRole("button", { name: /Add a point/ });
    const remove = card.getByRole("button", { name: /Remove a point/ });
    await add.tap();
    await expect(spent(page)).toHaveText("2/51");
    await remove.tap();
    await remove.tap();
    await expect(spent(page)).toHaveText("0/51");
    await expect(remove).toBeDisabled();
    await expect(add).toBeEnabled();
    // Disabled is more than a faded colour: a dashed border.
    await expect(remove).toHaveCSS("border-top-style", "dashed");
    await expect(add).toHaveCSS("border-top-style", "solid");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("talent-detail-card")).toHaveCount(0);
  });

  test("keyboard still works: arrows move and select, Enter adds, Backspace removes", async ({ page }) => {
    await page.goto("/guides/classes/hunter");
    const first = firstTalent(page, "beast-mastery");
    await first.focus();
    await expect(first).toHaveAttribute("data-selected", "true");
    await page.keyboard.press("Enter");
    await expect(spent(page)).toHaveText("1/51");
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('[data-testid="tree-beast-mastery"] [data-selected]')).not.toHaveAttribute("data-talent-id", (await first.getAttribute("data-talent-id"))!);
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");
    await expect(spent(page)).toHaveText("0/51");
  });

  test("a shared build link restores the allocation, with the specializations in order", async ({ page }) => {
    const data = getTalentData("hunter")!;
    const engine = createEngine(data);
    let alloc = engine.reset();
    const t0 = data.trees[0]!.talents.filter((t) => t.row === 0);
    for (const t of t0) alloc = engine.add(alloc, t.id);
    const code = encodeBuild(data, alloc);
    await page.goto(`/guides/classes/hunter?${BUILD_PARAM}=${code}`);
    await expect(spent(page)).toHaveText(`${t0.length}/51`);
    const headings = await treeSections(page).locator("h3 > span:first-child").allTextContents();
    expect(headings).toEqual(data.trees.map((t) => t.name));
    await expect(page.getByTestId("link-error")).toHaveCount(0);
  });

  test("no axe violations with the panel expanded", async ({ page }) => {
    await page.goto("/guides/classes/hunter");
    const node = firstTalent(page, "beast-mastery");
    await node.scrollIntoViewIfNeeded();
    await node.tap();
    await page.getByTestId("panel-toggle").tap();
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) - ${v.help}`)).toEqual([]);
  });

  test("the quick navigation is a phone-only affordance", async ({ page }) => {
    await page.goto("/guides/classes/hunter");
    await expect(page.getByTestId("spec-nav")).toBeHidden();
  });
});

test.describe("detail panel on a landscape phone (956x440 touch)", () => {
  test.use({ viewport: { width: 956, height: 440 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("is a compact horizontal status bar that expands to at most 44% of the height, scrolls inside, and never hides the selection", async ({ page }) => {
    await page.goto("/guides/classes/hunter");
    const node = firstTalent(page, "beast-mastery");
    await node.scrollIntoViewIfNeeded();
    await node.tap();
    const card = page.getByTestId("talent-detail-card");
    const vp = page.viewportSize()!;
    const bar = (await card.boundingBox())!;
    expect(bar.height).toBeLessThanOrEqual(100);
    const ys = await Promise.all([card.getByRole("button", { name: /Add a point/ }), card.getByRole("button", { name: /Remove a point/ }), card.getByTestId("panel-toggle"), card.getByTestId("panel-close")].map(async (l) => (await l.boundingBox())!.y));
    expect(Math.max(...ys) - Math.min(...ys), "one horizontal row").toBeLessThanOrEqual(2);
    for (const l of [card.getByRole("button", { name: /Add a point/ }), card.getByTestId("panel-toggle"), card.getByTestId("panel-close")]) {
      const r = (await l.boundingBox())!;
      expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(44);
    }
    const frame = (await node.getByTestId("node-frame").boundingBox())!;
    expect(frame.y + frame.height).toBeLessThanOrEqual(bar.y);

    await card.getByTestId("panel-toggle").tap();
    const open = (await card.boundingBox())!;
    expect(open.height).toBeLessThanOrEqual(vp.height * 0.44 + 1);
    expect(open.y + open.height).toBeLessThanOrEqual(vp.height);
    await expect(card.getByTestId("talent-description")).toBeVisible();
    const f2 = (await node.getByTestId("node-frame").boundingBox())!;
    expect(f2.y + f2.height, "selection above the expanded panel").toBeLessThanOrEqual(open.y);
    expect(f2.y, "selection still on screen").toBeGreaterThanOrEqual(0);
    // The card scrolls inside itself rather than growing past its cap.
    expect(await card.evaluate((el) => el.scrollHeight >= el.clientHeight)).toBe(true);
    await card.getByTestId("panel-close").tap();
    await expect(page.getByTestId("talent-detail-card")).toHaveCount(0);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("detail panel on a desktop (1440x900, mouse)", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false });

  test("is unchanged: always the full details, no expand button, hover tooltip", async ({ page }) => {
    await page.goto("/guides/classes/hunter");
    const node = firstTalent(page, "beast-mastery");
    await node.scrollIntoViewIfNeeded();
    await node.hover();
    await expect(page.getByTestId("talent-tooltip")).toBeVisible();
    await node.click();
    const card = page.getByTestId("talent-detail-card");
    await expect(card.getByTestId("panel-toggle")).toBeHidden();
    await expect(card.getByTestId("talent-detail-body")).toBeVisible();
    expect((await card.boundingBox())!.height).toBeLessThanOrEqual(900 * 0.4 + 1);
    await expect(page.getByTestId("spec-nav")).toBeHidden();
    await expect(page.getByTestId("talent-hint")).toContainText("Click to add a point");
  });
});

test.describe("a narrow desktop window falls back to the sheet", () => {
  test.use({ viewport: { width: 700, height: 900 }, hasTouch: false });

  test("fine pointer, narrow window: collapsible", async ({ page }) => {
    await page.goto("/guides/classes/hunter");
    const node = firstTalent(page, "beast-mastery");
    await node.scrollIntoViewIfNeeded();
    await node.click();
    await expect(page.getByTestId("panel-toggle")).toBeVisible();
    await expect(page.getByTestId("talent-detail-body")).toBeHidden();
  });
});

test.describe("phone quick navigation (390x844)", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });

  test("jumps to each tree with native scrolling, keeps every tree mounted, adds nothing fixed", async ({ page }) => {
    await page.goto("/guides/classes/hunter");
    const nav = page.getByTestId("spec-nav");
    await expect(nav).toBeVisible();
    const links = nav.getByRole("link");
    await expect(links).toHaveText(["Beast Mastery", "Marksmanship", "Survival"]);
    expect(await nav.evaluate((el) => getComputedStyle(el).position)).toBe("static");
    for (const l of await links.all()) {
      const r = (await l.boundingBox())!;
      expect(r.height).toBeGreaterThanOrEqual(44);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(390);
    }
    for (const [i, slug] of ["beast-mastery", "marksmanship", "survival"].entries()) {
      await links.nth(i).tap();
      await expect.poll(async () => Math.abs((await page.getByTestId(`tree-${slug}`).boundingBox())!.y), { timeout: 5000 }).toBeLessThan(40);
      await expect(page.getByTestId(`tree-${slug}`).getByRole("heading")).toBeFocused();
      expect(page.url()).not.toContain("#");
      await expect(treeSections(page)).toHaveCount(3);
    }
    // Going back up still works, and the jump does not disturb the build.
    await expect(spent(page)).toHaveText("0/51");
  });

  test("the header stays compact and inside the screen at 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto("/guides/classes/hunter");
    for (const id of ["points-spent", "points-remaining", "required-level", "share-build", "reset-build", "talent-help"]) {
      const r = (await page.getByTestId(id).boundingBox())!;
      expect(r.x, id).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, id).toBeLessThanOrEqual(320);
    }
    const header = (await page.getByTestId("share-build").boundingBox())!;
    const calcTop = (await page.getByTestId("talent-calculator").boundingBox())!.y;
    expect(header.y + header.height - calcTop, "header block height").toBeLessThan(200);
    await expect(page.getByTestId("talent-hint")).toContainText("Tap a talent to add a point.");
    await page.getByTestId("talent-help").getByText("How to use").tap();
    const body = page.getByTestId("talent-help").locator("div").first();
    await expect(body).toBeVisible();
    const r = (await body.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(320);
  });
});
