import { expect, test } from "./fixtures";

/**
 * Mobile Detail Pages UX Polish V1: DropTable.tsx now renders the same observation rows as
 * either a desktop <table> (`hidden sm:block`) or a mobile card list (`sm:hidden`), used by the
 * Item page's "Observed sources" (perspective="item") and by Object/Creature/Fishing pages'
 * "Observed loot" per level (perspective="source", via SourcePage.tsx). These tests exercise all
 * three entity families against the fixture dataset documented in the task: Copper Ore (item
 * #2770, one source: Copper Vein #1731, Mining, 100% observed over 121/121 samples), Copper Vein
 * (object #1731, five observed loot items), and Mottled Boar (creature #3098, two observed
 * levels, with Skinning and Creature Loot kept as separate acquisition methods at each level,
 * including a level where both are statistically "insufficient").
 */

const ITEM = "/item/2770"; // Copper Ore
const OBJECT = "/object/1731"; // Copper Vein
const CREATURE = "/creature/3098"; // Mottled Boar

test.describe("detail pages: mobile cards", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "asserts mobile-breakpoint-only card presentation");
  });

  for (const width of [320, 360, 390, 430]) {
    test(`item page @ ${width}px: no horizontal overflow and the source card carries every stat`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(ITEM);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      await expect(page.locator("table")).toBeHidden();
      const card = page.getByRole("listitem").filter({ hasText: "Copper Vein" });
      await expect(card).toBeVisible();
      await expect(card.getByRole("link", { name: "Copper Vein" })).toHaveAttribute("href", /\/object\/1731/);
      await expect(card.getByText("#1731")).toBeVisible();
      await expect(card.getByText("Mining")).toBeVisible();
      await expect(card.getByText("100.0%", { exact: true })).toBeVisible(); // exact: the CI span's text is "96.9-100.0%", a substring match on this would hit both
      await expect(card.getByText("96.9")).toBeVisible(); // confidence interval lower bound
      await expect(card.getByText("121 / 121")).toBeVisible(); // seen / samples
      await expect(card.getByText("3.0")).toBeVisible(); // avg stack
      await expect(card.getByText("High sample")).toBeVisible(); // sample quality
    });

    test(`object page @ ${width}px: no horizontal overflow and every observed-loot item is a distinct linked card`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(OBJECT);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      await expect(page.locator("table")).toBeHidden();
      for (const name of ["Copper Ore", "Rough Stone", "Malachite", "Shadowgem", "Tigerseye"]) {
        const card = page.getByRole("listitem").filter({ hasText: name });
        await expect(card.getByRole("link", { name })).toBeVisible();
        await expect(card.getByText("Mining")).toBeVisible();
      }
      // A low-sample row ("mostly one collector") must wrap onto its own line, never force
      // the card wider than the viewport - the regression this file's own sibling fix covers.
      const tigerseye = page.getByRole("listitem").filter({ hasText: "Tigerseye" });
      await expect(tigerseye.getByText("mostly one collector")).toBeVisible();
    });
  }

  test("creature page: multiple levels stay distinct, Skinning and Creature Loot stay separate", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(CREATURE);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    await expect(page.getByRole("heading", { name: "Level 1" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Level 2" })).toBeVisible();

    const level1 = page.locator("#level-1");
    await expect(level1.getByText("180 observed")).toBeVisible(); // Skinning bucket
    await expect(level1.getByText("4 observed")).toBeVisible(); // Creature loot bucket
    const scrapsL1 = level1.getByRole("listitem").filter({ hasText: "Ruined Leather Scraps" });
    await expect(scrapsL1.getByText("Skinning", { exact: true })).toBeVisible();
    await expect(scrapsL1.getByText("85.6%")).toBeVisible();
    const boarMeatL1 = level1.getByRole("listitem").filter({ hasText: "Chunk of Boar Meat" });
    await expect(boarMeatL1.getByText("Creature loot", { exact: true })).toBeVisible();

    const level2 = page.locator("#level-2");
    const scrapsL2 = level2.getByRole("listitem").filter({ hasText: "Ruined Leather Scraps" });
    await expect(scrapsL2.getByText("2 / 2")).toBeVisible(); // level 2's own, much smaller sample - never merged with level 1's 154/180
  });

  test("creature page: an insufficient-sample loot group shows the suppressed state, never a fabricated rate", async ({ page }) => {
    await page.goto(CREATURE);
    const level2 = page.locator("#level-2");
    const boarMeatL2 = level2.getByRole("listitem").filter({ hasText: "Chunk of Boar Meat" });
    await expect(boarMeatL2.getByText("Too few samples", { exact: true })).toBeVisible(); // exact: avoids matching the lowercase sr-only "(rate hidden: too few samples)" note
    await expect(boarMeatL2.getByText("2 / 6")).toBeVisible(); // the real sample count is still shown
    // The whole card renders only the em dash for the suppressed rate - never a fabricated percentage.
    await expect(boarMeatL2).toContainText("—");
    await expect(boarMeatL2).not.toContainText("%");
  });

  test("long item names wrap inside their card instead of overflowing", async ({ page }) => {
    await page.goto("/fishing/1420");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const card = page.getByRole("listitem").filter({ hasText: "Raw Longjaw Mud Snapper" });
    await expect(card.getByRole("link", { name: "Raw Longjaw Mud Snapper" })).toBeVisible();
  });

  test("mobile summary stat tiles do not clip their labels", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(ITEM);
    for (const label of ["Sources", "Times seen", "Last observed"]) await expect(page.getByText(label, { exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("no hidden duplicate controls receive keyboard focus (desktop table is out of the tab order)", async ({ page }) => {
    await page.goto(ITEM);
    const desktopLink = page.locator("table").getByRole("link", { name: "Copper Vein" });
    await expect(desktopLink).toBeHidden();
    // A hidden (display:none) element cannot be focused; confirm the page's only focusable
    // "Copper Vein" link is the one inside the visible mobile card.
    const links = page.getByRole("link", { name: "Copper Vein" });
    await expect(links).toHaveCount(1);
  });
});

test.describe("detail pages: desktop regression", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop-only table regression check");
  });

  for (const width of [1024, 1440, 1920]) {
    test(`item page @ ${width}px: the semantic table is present with unchanged values, no mobile cards, no overflow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(ITEM);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      const table = page.locator("table");
      await expect(table).toBeVisible();
      await expect(page.getByRole("list", { name: /Observed sources/ })).toBeHidden();
      await expect(table.getByRole("columnheader", { name: "Observed drop rate" })).toBeVisible();
      const row = table.locator("tr", { hasText: "Copper Vein" });
      await expect(row).toContainText("100.0%");
      await expect(row).toContainText("121");
      await expect(row).toContainText("3.0");
      await expect(row.getByRole("link", { name: "Copper Vein" })).toHaveAttribute("href", /\/object\/1731/);
    });
  }

  test("object page: desktop table lists every observed-loot item with unchanged values", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(OBJECT);
    const table = page.locator("table");
    await expect(table).toBeVisible();
    await expect(page.getByRole("list", { name: /Items observed from/ })).toBeHidden();
    for (const [name, rate] of [["Copper Ore", "100.0%"], ["Rough Stone", "39.7%"], ["Tigerseye", "1.7%"]] as const) {
      const row = table.locator("tr", { hasText: name });
      await expect(row).toContainText(rate);
    }
  });

  test("creature page: both levels keep their own desktop table, values are not merged across levels", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(CREATURE);
    const level1Table = page.locator("#level-1 table");
    const level2Table = page.locator("#level-2 table");
    await expect(level1Table).toBeVisible();
    await expect(level2Table).toBeVisible();
    await expect(level1Table.locator("tr", { hasText: "Ruined Leather Scraps" })).toContainText("154 / 180");
    await expect(level2Table.locator("tr", { hasText: "Ruined Leather Scraps" })).toContainText("2 / 2");
    // Mobile-only card lists must not be present at desktop widths for either level.
    await expect(page.locator("#level-1").getByRole("list", { name: /Items observed/ })).toBeHidden();
    await expect(page.locator("#level-2").getByRole("list", { name: /Items observed/ })).toBeHidden();
  });
});

test.describe("detail pages: cross-view statistical parity", () => {
  test("the same source dataset renders identical values in the mobile card and the desktop row", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(OBJECT);
    const mobileCard = page.getByRole("listitem").filter({ hasText: "Rough Stone" });
    const mobileRate = await mobileCard.getByText(/^\d+\.\d%$/).first().textContent();
    const mobileSeen = await mobileCard.getByText(/^\d+ \/ \d+$/).first().textContent();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    const desktopRow = page.locator("table tr", { hasText: "Rough Stone" });
    await expect(desktopRow).toContainText(mobileRate!.trim());
    await expect(desktopRow).toContainText(mobileSeen!.trim());
  });

  test("creature level separation holds across both views: level 2's sample size never matches level 1's", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto(CREATURE);
    const mobileLevel2 = page.locator("#level-2").getByRole("listitem").filter({ hasText: "Ruined Leather Scraps" });
    await expect(mobileLevel2.getByText("2 / 2")).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    const desktopLevel2Row = page.locator("#level-2 table tr", { hasText: "Ruined Leather Scraps" });
    await expect(desktopLevel2Row).toContainText("2 / 2");
    await expect(desktopLevel2Row).not.toContainText("154 / 180"); // level 1's figure, never leaking into level 2
  });
});
