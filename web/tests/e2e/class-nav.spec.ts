import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Arcane Library class navigation: /guides shows the search panel first, then a compact row of nine class icons
 * (alphabetical, 36-40px icons in >=44px targets); /guides/classes shows nine illustrated cards.
 */
const CLASSES = ["Druid", "Hunter", "Mage", "Paladin", "Priest", "Rogue", "Shaman", "Warlock", "Warrior"];
const ids = CLASSES.map((c) => c.toLowerCase());

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
/** Every <img> on the page has finished loading with real pixels. */
const imagesLoaded = (page: Page, selector: string) =>
  page.evaluate(async (sel) => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>(sel)];
    await Promise.all(imgs.map((i) => (i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; }))));
    return imgs.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.currentSrc }));
  }, selector);

test.describe("/guides landing page", () => {
  test("order: hero, search/filter, class navigation, then the guide results", async ({ page }) => {
    await page.goto("/guides");
    const order = await page.evaluate(() => {
      const hero = document.querySelector("#guides-hero-title")!;
      const search = document.querySelector("#g-q")!.closest("form")!;
      const classes = document.querySelector('[data-testid="class-guides-entry"]')!;
      const results = document.querySelector("ul.lg\\:grid-cols-3")!; // the guide cards
      const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return [before(hero, search), before(search, classes), before(classes, results)];
    });
    expect(order).toEqual([true, true, true]);
    const sy = (await page.getByRole("search", { name: "Search the Arcane Library" }).boundingBox())!.y;
    const cy = (await page.getByTestId("class-guides-entry").boundingBox())!.y;
    expect(sy).toBeLessThan(cy);
  });

  test("nine class icons, alphabetical, real images, 36-40px visible in 44px+ targets, correct destinations", async ({ page }) => {
    await page.goto("/guides");
    const nav = page.getByTestId("class-icon-nav");
    await expect(nav.getByRole("listitem")).toHaveText(CLASSES);
    const loaded = await imagesLoaded(page, '[data-testid="class-icon"]');
    expect(loaded).toHaveLength(9);
    for (const [i, l] of loaded.entries()) {
      expect(l.w, ids[i]).toBe(128);
      expect(l.h, ids[i]).toBe(128);
      expect(l.src, ids[i]).toContain(`/class-icons/${ids[i]}.webp`);
    }
    for (const id of ids) {
      const link = page.getByTestId(`class-icon-${id}`);
      await expect(link).toHaveAttribute("href", `/guides/classes/${id}`);
      const icon = (await link.getByTestId("class-icon").boundingBox())!;
      expect(icon.width).toBeGreaterThanOrEqual(36);
      expect(icon.width).toBeLessThanOrEqual(40);
      expect(icon.height).toBeCloseTo(icon.width, 0);
      const box = (await link.boundingBox())!;
      expect(box.width, `${id} target width`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${id} target height`).toBeGreaterThanOrEqual(44);
      await expect(link.getByText(CLASSES[ids.indexOf(id)]!, { exact: true })).toBeVisible(); // name stays visible under the icon
    }
    expect(await noOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("each icon link navigates to its own class", async ({ page }) => {
    for (const [i, id] of ids.entries()) {
      await page.goto("/guides");
      await page.getByTestId(`class-icon-${id}`).click();
      await expect(page).toHaveURL(new RegExp(`/guides/classes/${id}$`));
      await expect(page.getByRole("heading", { level: 1, name: CLASSES[i]! })).toBeVisible();
    }
  });

  test("keyboard: the icon links are reachable in order and show a visible focus indicator", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "keyboard focus order is a desktop concern");
    await page.goto("/guides");
    await page.getByRole("link", { name: "Browse classes" }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByTestId("class-icon-druid")).toBeFocused();
    const outline = await page.getByTestId("class-icon-druid").evaluate((el) => {
      const c = getComputedStyle(el);
      return { style: c.outlineStyle, width: parseFloat(c.outlineWidth) };
    });
    expect(outline.style).not.toBe("none");
    expect(outline.width).toBeGreaterThanOrEqual(2);
    for (const id of ids.slice(1)) {
      await page.keyboard.press("Tab");
      await expect(page.getByTestId(`class-icon-${id}`)).toBeFocused();
    }
    // The search panel precedes the class navigation in the tab order.
    await page.getByLabel("Search", { exact: true }).focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Tab"); // category, topic, Search button, Browse classes
    await expect(page.getByRole("link", { name: "Browse classes" })).toBeFocused();
  });

  test("search and filters are unchanged: query parameters, results, clear filters and the empty state", async ({ page }) => {
    await page.goto("/guides?q=zzzz-no-such-guide");
    await expect(page.getByText("No guides match those filters")).toBeVisible();
    await expect(page.getByRole("link", { name: "Clear filters" }).first()).toBeVisible();
    await expect(page.getByTestId("class-guides-entry")).toBeVisible(); // stays compact and available under an empty result
    await page.goto("/guides");
    await page.getByLabel("Search", { exact: true }).fill("fishing");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/\/guides\?q=fishing/);
    await expect(page.getByText(/\d+ guides? found/)).toBeVisible();
    await expect(page.getByLabel("Search", { exact: true })).toHaveValue("fishing");
  });

  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 375, height: 667 }]) {
    test(`responsive ${vp.width}px: no horizontal overflow, panel stays compact, icons fit`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto("/guides");
      expect(await noOverflow(page)).toBeLessThanOrEqual(0);
      const panel = (await page.getByTestId("class-guides-entry").boundingBox())!;
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(vp.width);
      expect(panel.height).toBeLessThan(vp.width < 640 ? 300 : 200);
      for (const id of ids) {
        const b = (await page.getByTestId(`class-icon-${id}`).boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
        expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(44);
      }
    });
  }
});

test.describe("/guides/classes illustrated cards", () => {
  test("nine cards, alphabetical, each with its own illustration loaded at full quality", async ({ page }) => {
    await page.goto("/guides/classes");
    const cards = page.locator('[data-testid^="class-card-"]');
    await expect(cards).toHaveCount(9);
    await expect(cards.getByRole("heading", { level: 2 })).toHaveText(CLASSES);
    const loaded = await imagesLoaded(page, '[data-testid="card-art"]');
    // lazy images below the fold: scroll through so every one loads
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } });
    const all = await imagesLoaded(page, '[data-testid="card-art"]');
    expect(loaded).toHaveLength(9);
    for (const [i, l] of all.entries()) {
      // naturalWidth is density-corrected for a `sizes`/srcset image, so check the chosen file and that real pixels arrived.
      expect(l.w, ids[i]).toBeGreaterThanOrEqual(480);
      expect(l.src, ids[i]).toMatch(new RegExp(`/class-cards/${ids[i]}(-640)?\\.webp$`));
      expect(l.w / l.h, ids[i]).toBeGreaterThan(1.3);
    }
  });

  test("consistent card layout: one aspect ratio, text readable on a dark gradient, no nested links", async ({ page }) => {
    await page.goto("/guides/classes");
    const sizes: number[] = [];
    for (const id of ids) {
      const card = page.getByTestId(`class-card-${id}`);
      const b = (await card.boundingBox())!;
      sizes.push(Math.round((b.width / b.height) * 100) / 100);
      expect(await card.evaluate((el) => el.querySelectorAll("a a").length)).toBe(0);
      expect(await card.getByRole("link").count()).toBe(2);
    }
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeCloseTo(4 / 3, 1);
  });

  test("the whole card opens the class; the calculator link is its own target", async ({ page }) => {
    await page.goto("/guides/classes");
    // Click the artwork area of the card (top-left), not the name link.
    const card = page.getByTestId("class-card-hunter");
    const b = (await card.boundingBox())!;
    await page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.2);
    await expect(page).toHaveURL(/\/guides\/classes\/hunter$/);
    await page.goBack();
    await page.getByTestId("class-card-mage").getByRole("link", { name: "Talent calculator" }).click();
    await expect(page).toHaveURL(/\/guides\/classes\/mage#talents$/);
  });

  test("hover and focus states: art zooms subtly on hover, the card shows a focus ring on keyboard focus", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "hover/keyboard states");
    await page.goto("/guides/classes");
    const card = page.getByTestId("class-card-priest");
    const art = card.getByTestId("card-art");
    const before = await art.evaluate((el) => getComputedStyle(el).scale);
    await card.hover();
    await expect.poll(() => art.evaluate((el) => getComputedStyle(el).scale)).not.toBe(before);
    await page.mouse.move(0, 0);
    const resting = await card.evaluate((el) => getComputedStyle(el).boxShadow);
    await card.getByRole("link", { name: "Priest" }).focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(card.getByRole("link", { name: "Priest" })).toBeFocused();
    // keyboard focus draws a violet ring around the whole card
    await expect.poll(() => card.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe(resting);
    await page.keyboard.press("Tab");
    await expect(card.getByRole("link", { name: "Talent calculator" })).toBeFocused();
  });

  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 375, height: 667 }]) {
    test(`responsive ${vp.width}px: no horizontal overflow, cards inside the viewport`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto("/guides/classes");
      expect(await noOverflow(page)).toBeLessThanOrEqual(0);
      for (const id of ids) {
        const b = (await page.getByTestId(`class-card-${id}`).boundingBox())!;
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.width).toBeLessThanOrEqual(vp.width);
        const calc = (await page.getByTestId(`class-card-${id}`).getByRole("link", { name: "Talent calculator" }).boundingBox())!;
        expect(calc.height).toBeGreaterThanOrEqual(44);
        expect(calc.y + calc.height).toBeLessThanOrEqual(b.y + b.height + 1); // the button stays inside its card
      }
    });
  }

  test("no CSP violations and no failed requests on either page", async ({ page }) => {
    const bad: string[] = [];
    page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) bad.push(m.text()); });
    page.on("response", (r) => { if (r.status() >= 400 && /class-(icons|cards)/.test(r.url())) bad.push(`${r.status()} ${r.url()}`); });
    for (const url of ["/guides", "/guides/classes"]) {
      await page.goto(url);
      await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); } });
    }
    expect(bad).toEqual([]);
  });
});

test.describe("illustrated class detail hero", () => {
  for (const [i, id] of ids.entries()) {
    test(`${id}: hero uses its own illustration, reads well, keeps the CTA, no overflow or shift`, async ({ page }, testInfo) => {
      const mobile = testInfo.project.name === "mobile";
      const bad: string[] = [];
      page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) bad.push(m.text()); });
      page.on("response", (r) => { if (r.status() >= 400 && /class-(icons|cards)/.test(r.url())) bad.push(`${r.status()} ${r.url()}`); });
      await page.addInitScript(() => {
        (window as unknown as { __cls: number }).__cls = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(`/guides/classes/${id}`);
      const hero = page.getByTestId("class-hero");
      await expect(hero).toBeVisible();
      await expect(hero).toHaveAttribute("data-class", id);
      // The same illustration as the class card, through the same two files.
      const art = hero.getByTestId("class-hero-art");
      await expect(art).toHaveAttribute("src", `/class-cards/${id}.webp`);
      await expect(art).toHaveAttribute("srcset", `/class-cards/${id}-640.webp 640w, /class-cards/${id}.webp 1024w`);
      await expect(art).toHaveAttribute("aria-hidden", "true");
      const loaded = await imagesLoaded(page, '[data-testid="class-hero-art"]');
      expect(loaded[0]!.w, id).toBeGreaterThanOrEqual(300); // density-corrected width of a srcset image, so only "real pixels arrived"
      expect(loaded[0]!.src, id).toMatch(new RegExp(`/class-cards/${id}(-640)?\\.webp$`));
      // Old presentation removed: no letter emblem, no SVG motif; name, intro and CTA kept.
      await expect(hero.locator("svg")).toHaveCount(0);
      await expect(hero.getByText(CLASSES[i]!.charAt(0), { exact: true })).toHaveCount(0);
      await expect(hero.getByRole("heading", { level: 1, name: CLASSES[i]! })).toBeVisible();
      const cta = hero.getByRole("link", { name: "Open the talent calculator" });
      await expect(cta).toBeVisible();
      expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // Wide cinematic banner on desktop (320-380px), a taller crop on phones; text stays inside it.
      const box = (await hero.boundingBox())!;
      const vp = page.viewportSize()!;
      if (!mobile) {
        expect(box.height, id).toBeGreaterThanOrEqual(320);
        expect(box.height, id).toBeLessThanOrEqual(380);
        expect(box.width / box.height, id).toBeGreaterThan(2.5);
      } else {
        expect(box.height, id).toBeLessThanOrEqual(520);
      }
      expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
      const copy = (await hero.getByRole("heading", { level: 1 }).boundingBox())!;
      expect(copy.y).toBeGreaterThanOrEqual(box.y);
      expect(copy.y + copy.height).toBeLessThanOrEqual(box.y + box.height);
      // Readable: the text sits on a dark scrim (the gradient is opaque-ish where the copy is).
      expect(await hero.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
      expect(await noOverflow(page)).toBeLessThanOrEqual(0);
      // The sections below are unchanged and working.
      await expect(page.getByRole("heading", { level: 2, name: "Specializations" })).toBeVisible();
      await expect(page.getByTestId("talent-calculator")).toBeVisible();
      await expect(page.getByTestId("points-remaining")).toHaveText("51");
      await page.waitForTimeout(300);
      const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
      expect(cls, `${id} layout shift`).toBeLessThan(0.02);
      expect(bad).toEqual([]);
    });
  }

  test("keyboard: the calculator link is reachable with a visible focus ring and jumps to the calculator", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "keyboard focus is a desktop concern");
    await page.goto("/guides/classes/druid");
    const cta = page.getByTestId("class-hero").getByRole("link", { name: "Open the talent calculator" });
    await cta.focus();
    await expect(cta).toBeFocused();
    const ring = await cta.evaluate((el) => { const c = getComputedStyle(el); return { style: c.outlineStyle, width: parseFloat(c.outlineWidth) }; });
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/guides\/classes\/druid#talents$/);
  });

  test("the journey is consistent: card art on /guides/classes is the hero art on the class page", async ({ page }) => {
    await page.goto("/guides/classes");
    const cardSrc = await page.getByTestId("class-card-warrior").getByTestId("card-art").getAttribute("src");
    await page.getByTestId("class-card-warrior").getByRole("link", { name: "Warrior" }).click();
    await expect(page).toHaveURL(/\/guides\/classes\/warrior$/);
    await expect(page.getByTestId("class-hero-art")).toHaveAttribute("src", cardSrc!);
  });
});
