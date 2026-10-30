import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Race Guides V1: /guides/races overview, ten race pages, versioned-history disclosure, class cross-links, SEO and layout.
 * The data itself is covered by tests/unit/races-data.test.ts; this checks what a visitor and a browser actually get.
 */
const ALLIANCE = ["human", "dwarf", "night-elf", "gnome", "high-order-skyborne"];
const HORDE = ["orc", "tauren", "troll", "undead", "windshaper-skyborne"];
const ALL = [...ALLIANCE, ...HORDE];
const NAMES: Record<string, string> = {
  human: "Human", dwarf: "Dwarf", "night-elf": "Night Elf", gnome: "Gnome", "high-order-skyborne": "High Order Skyborne",
  orc: "Orc", tauren: "Tauren", troll: "Troll", undead: "Undead", "windshaper-skyborne": "Windshaper Skyborne",
};

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe("/guides/races overview", () => {
  test("introduces the guides and groups five races per faction", async ({ page }) => {
    await page.goto("/guides/races");
    await expect(page.getByRole("heading", { level: 1, name: "Choose your race" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toContainText("Races");
    for (const [faction, ids] of [["alliance", ALLIANCE], ["horde", HORDE]] as const) {
      const section = page.getByTestId(`faction-${faction}`);
      await expect(section.getByRole("heading", { level: 2 })).toHaveText(faction === "alliance" ? "Alliance" : "Horde");
      await expect(section.locator("[data-testid^=race-card-]")).toHaveCount(5);
      for (const id of ids) {
        const card = section.getByTestId(`race-card-${id}`);
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute("data-faction", faction);
        await expect(card.getByRole("heading", { level: 3, name: NAMES[id]! })).toBeVisible();
      }
    }
  });

  test("shows available classes and the new-combination marker, and each card opens its race page", async ({ page }) => {
    await page.goto("/guides/races");
    const human = page.getByTestId("race-card-human");
    await expect(human.getByRole("list", { name: "Human classes" }).getByRole("listitem")).toHaveCount(7);
    await expect(human.getByRole("list", { name: "Human classes" }).getByRole("listitem").filter({ hasText: "Hunter" })).toContainText("new in Forever");
    await page.getByTestId("race-card-night-elf").getByRole("link", { name: "Night Elf" }).click();
    await expect(page).toHaveURL(/\/guides\/races\/night-elf$/);
    await expect(page.getByRole("heading", { level: 1, name: "Night Elf" })).toBeVisible();
  });

  test("is reachable from the Guides landing page", async ({ page }) => {
    await page.goto("/guides");
    const entry = page.getByTestId("race-guides-entry");
    await expect(entry.getByRole("heading", { level: 2 })).toContainText("Race guides");
    await expect(entry.getByTestId("race-nav").getByRole("listitem")).toHaveCount(10);
    await entry.getByRole("link", { name: "Browse races" }).click();
    await expect(page).toHaveURL(/\/guides\/races$/);
    await page.goto("/guides");
    await page.getByTestId("race-link-troll").click();
    await expect(page).toHaveURL(/\/guides\/races\/troll$/);
  });

  test("has a canonical URL, a unique title and a description", async ({ page }) => {
    await page.goto("/guides/races");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/guides\/races$/);
    await expect(page).toHaveTitle(/Race Guides/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /ten Alliance and Horde races/);
  });
});

test.describe("race pages", () => {
  for (const id of ALL) {
    test(`${id}: renders hero, classes, two active and two passive abilities, history and provenance`, async ({ page }) => {
      const res = await page.goto(`/guides/races/${id}`);
      expect(res?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1, name: NAMES[id]! })).toBeVisible();
      await expect(page.getByTestId("race-hero")).toHaveAttribute("data-faction", ALLIANCE.includes(id) ? "alliance" : "horde");
      await expect(page.getByTestId("active-abilities").locator("[data-ability-type=active]")).toHaveCount(2);
      await expect(page.getByTestId("passive-abilities").locator("[data-ability-type=passive]")).toHaveCount(2);
      await expect(page.getByTestId("version-history")).toBeVisible();
      await expect(page.getByTestId("provenance")).toContainText("Not verified against the release client");
      // Exactly one h1, headings never skip a level (h2 sections, h3 groups, h4 abilities).
      await expect(page.locator("h1")).toHaveCount(1);
      const levels = await page.locator("main h1, main h2, main h3, main h4").evaluateAll((els) => els.map((e) => Number(e.tagName[1])));
      levels.forEach((l, i) => { if (i > 0) expect(l - levels[i - 1]!).toBeLessThanOrEqual(1); });
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`/guides/races/${id}$`));
      await expect(page).toHaveTitle(new RegExp(`${NAMES[id]} racial abilities`));
      await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", new RegExp(`${NAMES[id]}.*WoW: Forever`));
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }

  test("titles are unique across the ten pages", async ({ page }) => {
    const titles: string[] = [];
    for (const id of ALL) { await page.goto(`/guides/races/${id}`); titles.push(await page.title()); }
    expect(new Set(titles).size).toBe(10);
  });

  test("unknown races are a 404", async ({ page }) => {
    const res = await page.goto("/guides/races/not-a-race");
    expect(res?.status()).toBe(404);
  });

  test("the two Skyborne factions are separate pages with their own classes and abilities", async ({ page }) => {
    await page.goto("/guides/races/high-order-skyborne");
    await expect(page.getByTestId("class-mage")).toBeVisible();
    await expect(page.getByTestId("class-shaman")).toHaveCount(0);
    await expect(page.getByTestId("ability-high-order-skyborne.read-leyline")).toBeVisible();
    await page.goto("/guides/races/windshaper-skyborne");
    await expect(page.getByTestId("class-shaman")).toBeVisible();
    await expect(page.getByTestId("class-mage")).toHaveCount(0);
    await expect(page.getByTestId("ability-windshaper-skyborne.skysight")).toBeVisible();
    await expect(page.getByTestId("ability-skyborne.walk-on-air")).toBeVisible();
  });

  test("class links go to the existing Class Guides, and new combinations are flagged", async ({ page }) => {
    await page.goto("/guides/races/orc");
    await expect(page.getByTestId("class-mage")).toContainText("New in Forever");
    await expect(page.getByTestId("class-hunter")).not.toContainText("New in Forever");
    for (const cls of ["hunter", "mage", "rogue", "shaman", "warlock", "warrior"]) {
      const href = await page.getByTestId(`class-${cls}`).getByRole("link").getAttribute("href");
      expect(href).toBe(`/guides/classes/${cls}`);
      expect((await page.request.get(href!)).status(), cls).toBe(200);
    }
    await page.getByTestId("class-mage").getByRole("link").click();
    await expect(page).toHaveURL(/\/guides\/classes\/mage$/);
  });

  test("current values show the latest verified definitions; retired abilities are history only", async ({ page }) => {
    await page.goto("/guides/races/dwarf");
    await expect(page.getByTestId("ability-dwarf.artisans-precision")).toBeVisible();
    await expect(page.getByTestId("ability-dwarf.earth-fury")).toHaveCount(0);
    await expect(page.getByTestId("ability-dwarf.mace-specialization")).toHaveCount(0);
    await page.goto("/guides/races/human");
    await expect(page.getByTestId("ability-human.ruthless")).toContainText("1%");
    await expect(page.getByTestId("ability-human.the-human-spirit")).toContainText("10%");
    await page.goto("/guides/races/orc");
    await expect(page.getByTestId("ability-orc.blood-fury").getByTestId("cooldown")).toHaveText("2 min");
    await expect(page.getByTestId("ability-orc.command")).toBeVisible();
  });

  test("the class list links its official Blizzard source, and the provenance box lists it too", async ({ page }) => {
    await page.goto("/guides/races/gnome");
    const link = page.getByTestId("class-sources").getByRole("link").first();
    const url = new URL((await link.getAttribute("href"))!);
    expect(url.hostname).toBe("news.blizzard.com");
    expect(url.pathname).toMatch(/^\/en-us\/article\/24304075\//);
    await expect(page.getByTestId("provenance").locator('a[href*="24304075"]')).toHaveCount(1);
  });

  test("source links are present and open externally and safely", async ({ page }) => {
    await page.goto("/guides/races/troll");
    const links = page.getByTestId("ability-troll.berserking").getByRole("link");
    expect(await links.count()).toBeGreaterThan(0);
    for (const l of await links.all()) {
      await expect(l).toHaveAttribute("target", "_blank");
      await expect(l).toHaveAttribute("rel", /noopener/);
      await expect(l).toHaveAttribute("href", /^https:\/\//);
    }
  });
});

test.describe("version history", () => {
  test("is collapsed by default, expands and collapses, and shows earlier definitions with dates and sources", async ({ page }) => {
    await page.goto("/guides/races/human");
    const history = page.getByTestId("version-history");
    const summary = history.locator("summary");
    await expect(history).not.toHaveAttribute("open", "");
    await expect(history.getByTestId("history-row").first()).toBeHidden();
    await summary.click();
    await expect(history).toHaveAttribute("open", "");
    const rows = history.getByTestId("history-row");
    await expect(rows).toHaveCount(4);
    const ruthless = rows.filter({ hasText: "Critical strike bonus reduced from 2% to 1%" });
    await expect(ruthless).toContainText("26 Oct 2026");
    await expect(ruthless).toContainText("Earlier definition: Increases your critical strike chance by 2%.");
    // Compare the parsed host exactly; a regular expression on a URL would also match it anywhere in the path or query.
    const href = await ruthless.getByRole("link").first().getAttribute("href");
    expect(new URL(href!).hostname).toBe("us.forums.blizzard.com");
    await expect(history.getByTestId("retired-ability")).toContainText("Sword Specialization");
    await summary.click();
    await expect(history).not.toHaveAttribute("open", "");
    await expect(rows.first()).toBeHidden();
  });

  test("is operable from the keyboard (Tab to focus, Enter and Space toggle) with a visible focus indicator", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard interaction is a desktop concern");
    await page.goto("/guides/races/orc");
    const history = page.getByTestId("version-history");
    const summary = history.locator("summary");
    await summary.focus();
    await expect(summary).toBeFocused();
    const outline = await summary.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
    await page.keyboard.press("Enter");
    await expect(history).toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(history).not.toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(history).toHaveAttribute("open", "");
  });

  test("community-reported details are labelled as such and kept apart from Blizzard's changes", async ({ page }) => {
    await page.goto("/guides/races/night-elf");
    await page.getByTestId("version-history").locator("summary").click();
    const rows = page.getByTestId("history-row");
    await expect(rows).toHaveCount(2); // Quickness (Blizzard, 15 Oct) and the community-reported Elune's Light cooldown (28 Oct)
    await expect(rows.filter({ hasText: "Elune's Light" })).toContainText("Community detail");
    await expect(rows.filter({ hasText: "Elune's Light" })).toContainText("Community-reported");
    await expect(page.getByTestId("race-hero")).toContainText("15 Oct 2026"); // a community detail is not "the latest change"
    await page.goto("/guides/races/windshaper-skyborne");
    await page.getByTestId("version-history").locator("summary").click();
    await expect(page.getByTestId("history-row").filter({ hasText: "Charged" }).first()).toBeVisible();
  });
});

/** Scrolls the whole page so lazy images start loading, then waits until every matching <img> is complete. */
async function loadImages(page: Page, selector: string) {
  await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); } window.scrollTo(0, 0); });
  return page.evaluate(async (sel) => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>(sel)];
    await Promise.all(imgs.map((i) => (i.complete ? 1 : new Promise((r) => { i.onload = i.onerror = r; }))));
    return imgs.map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, src: i.currentSrc, race: i.dataset.race ?? "" }));
  }, selector);
}

/** Collects console errors, uncaught errors, failed image responses and Content-Security-Policy violations for a page. */
async function watchPage(page: Page) {
  const problems: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("response", (r) => { if (/\/(race-cards|class-cards|class-icons)\//.test(r.url()) && r.status() >= 400) problems.push(`${r.status()} ${new URL(r.url()).pathname}`); });
  return problems;
}

test.describe("race artwork", () => {
  test("every race card shows its own illustration, loaded at its own 3:4 shape, with the name below the picture", async ({ page }) => {
    const problems = await watchPage(page);
    await page.goto("/guides/races");
    const loaded = await loadImages(page, '[data-testid="race-art"]');
    expect(loaded).toHaveLength(10);
    for (const l of loaded) {
      // naturalWidth of a srcset image is density-corrected by `sizes`, so check the file chosen and that real pixels arrived.
      expect(l.w, l.race).toBeGreaterThanOrEqual(200);
      expect(l.src, l.race).toMatch(new RegExp(`/race-cards/${l.race}(-540|-800)?\\.webp$`));
      expect(Math.abs(l.w / l.h - 0.75), l.race).toBeLessThan(0.01);
    }
    expect(new Set(loaded.map((l) => l.src)).size).toBe(10);
    for (const id of ALL) {
      const card = page.getByTestId(`race-card-${id}`);
      const art = await card.getByTestId("race-art").boundingBox();
      expect(Math.abs(art!.width / art!.height - 0.75), id).toBeLessThan(0.01); // shown at the image's own shape: no crop
      const title = await card.getByRole("heading", { level: 3 }).boundingBox();
      expect(title!.y, id).toBeGreaterThanOrEqual(art!.y + art!.height - 1); // the name never lies on the character
      await expect(card.getByText(NAMES[id]!, { exact: true }).first()).toBeVisible();
    }
    expect(problems).toEqual([]);
  });

  test("the whole card is one link to the race page and shows hover/focus feedback", async ({ page, isMobile }) => {
    await page.goto("/guides/races");
    const card = page.getByTestId("race-card-tauren");
    const link = card.getByRole("link", { name: "Tauren" });
    expect((await link.boundingBox())!.height).toBeGreaterThan(0);
    // stretched link: clicking the picture area opens the race page
    await card.click({ position: { x: 40, y: 60 } });
    await expect(page).toHaveURL(/\/guides\/races\/tauren$/);
    if (isMobile) return;
    await page.goto("/guides/races");
    await page.keyboard.press("Tab");
    for (let i = 0; i < 40; i++) {
      if (await page.getByTestId("race-card-human").locator(":focus-visible").count()) break;
      await page.keyboard.press("Tab");
    }
    const ring = await page.getByTestId("race-card-human").evaluate((el) => getComputedStyle(el).boxShadow);
    expect(ring).not.toBe("none"); // keyboard focus draws a ring around the whole card
  });

  test("each race page uses the matching illustration in its hero, and both Skyborne factions use different ones", async ({ page }) => {
    const srcs = new Map<string, string>();
    for (const id of ALL) {
      const problems = await watchPage(page);
      await page.goto(`/guides/races/${id}`);
      const [hero] = await loadImages(page, '[data-testid="race-hero-art"]');
      expect(hero!.src, id).toMatch(new RegExp(`/race-cards/${id}(-540|-800)?\\.webp$`));
      expect(hero!.w, id).toBeGreaterThan(300);
      expect(await page.getByTestId("race-hero").getAttribute("data-race")).toBe(id);
      srcs.set(id, hero!.src.replace(/-(540|800)\.webp$/, ".webp"));
      expect(problems, id).toEqual([]);
    }
    expect(new Set(srcs.values()).size).toBe(10);
    expect(srcs.get("high-order-skyborne")).not.toBe(srcs.get("windshaper-skyborne"));
  });

  test("desktop hero: artwork on the right, all text on the left and clear of the picture", async ({ page, isMobile }) => {
    test.skip(isMobile, "desktop layout");
    await page.setViewportSize({ width: 1366, height: 900 });
    for (const id of ["tauren", "human", "windshaper-skyborne"]) {
      await page.goto(`/guides/races/${id}`);
      const hero = (await page.getByTestId("race-hero").boundingBox())!;
      const art = (await page.getByTestId("race-hero-art").boundingBox())!;
      expect(art.x, id).toBeGreaterThan(hero.x + hero.width * 0.45);
      const h1 = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
      expect(h1.x + h1.width, id).toBeLessThan(art.x + art.width * 0.3); // text ends where the picture's fade begins
      const summary = (await page.getByTestId("race-hero").locator("p").nth(1).boundingBox())!;
      expect(summary.x + summary.width, id).toBeLessThan(art.x + art.width * 0.3);
      expect(art.y, id).toBeLessThanOrEqual(hero.y + 1);
      expect(art.y + art.height, id).toBeGreaterThanOrEqual(hero.y + hero.height - 1);
    }
  });

  test("phone hero: the picture is above the text, faces are in the first screen, and no text lies on the picture", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const id of ALL) {
      await page.goto(`/guides/races/${id}`);
      const art = (await page.getByTestId("race-hero-art").boundingBox())!;
      const h1 = (await page.getByRole("heading", { level: 1 }).boundingBox())!;
      const label = (await page.getByTestId("race-hero").locator("p").first().boundingBox())!;
      expect(label.y, id).toBeGreaterThanOrEqual(art.y + art.height - 1);
      expect(h1.y, id).toBeGreaterThan(art.y + art.height);
      expect(art.width, id).toBeGreaterThan(300);
      expect(art.y + art.height * 0.4, id).toBeLessThan(844); // the top 40% (where every face is) is within the first screen
      expect(art.height / art.width, id).toBeLessThan(1.3); // no excessive blank space or stretched poster
    }
  });

  test("available-class tiles are illustrated with the existing class art, link to the right Class Guide and keep the new-in-Forever marker", async ({ page }) => {
    const problems = await watchPage(page);
    await page.goto("/guides/races/undead");
    const expected = ["mage", "paladin", "priest", "rogue", "warlock", "warrior"];
    await expect(page.locator("[data-testid^=class-][data-class]")).toHaveCount(expected.length);
    const art = await loadImages(page, '[data-testid="class-tile-art"]');
    expect(art).toHaveLength(expected.length);
    art.forEach((a, i) => { expect(a.w).toBeGreaterThan(100); expect(a.src).toMatch(new RegExp(`/class-cards/${expected[i]}(-640)?\\.webp$`)); });
    for (const cls of expected) {
      const tile = page.getByTestId(`class-${cls}`);
      expect(await tile.getByRole("link").getAttribute("href")).toBe(`/guides/classes/${cls}`);
      const box = (await tile.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(80);
      const link = (await tile.getByRole("link").boundingBox())!;
      expect(link.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByTestId("class-paladin")).toContainText("New in Forever");
    await expect(page.getByTestId("class-mage")).not.toContainText("New in Forever");
    // the whole tile is the link: clicking the picture side opens the guide
    await page.getByTestId("class-priest").locator('[data-testid="class-tile-art"]').click({ position: { x: 20, y: 20 }, force: true });
    await expect(page).toHaveURL(/\/guides\/classes\/priest$/);
    expect(problems).toEqual([]);
  });

  test("the Guides landing page shows a thumbnail of every race, each a 44px+ target to the right page", async ({ page }) => {
    const problems = await watchPage(page);
    await page.goto("/guides");
    const loaded = await loadImages(page, '[data-testid="race-thumb"]');
    expect(loaded).toHaveLength(10);
    // naturalWidth of a srcset image is density-corrected by `sizes` (40 px here), so check the file actually chosen and that pixels arrived.
    loaded.forEach((l) => { expect(l.w).toBeGreaterThan(0); expect(l.src).toMatch(/\/race-cards\/[a-z-]+-(240|540)\.webp$/); });
    expect(new Set(loaded.map((l) => l.src)).size).toBe(10);
    for (const id of ALL) {
      const link = page.getByTestId(`race-link-${id}`);
      const box = (await link.boundingBox())!;
      expect(Math.min(box.width, box.height), id).toBeGreaterThanOrEqual(44);
      await expect(link).toHaveAttribute("href", `/guides/races/${id}`);
    }
    expect(problems).toEqual([]);
  });

  test("the race and class data on the page is unchanged by the artwork", async ({ page }) => {
    await page.goto("/guides/races/orc");
    await expect(page.locator("[data-testid^=class-][data-class]")).toHaveCount(6);
    await expect(page.getByTestId("ability-orc.blood-fury").getByTestId("cooldown")).toHaveText("2 min");
    await expect(page.getByTestId("provenance")).toContainText("Not verified against the release client");
    await page.getByTestId("version-history").locator("summary").click();
    await expect(page.getByTestId("history-row")).toHaveCount(7);
  });
});

test.describe("accessibility with the history expanded", () => {
  for (const id of ["human", "windshaper-skyborne", "dwarf"]) {
    test(`WCAG 2.2 AA automated checks, version history open: ${id}`, async ({ page }) => {
      await page.goto(`/guides/races/${id}`);
      await page.getByTestId("version-history").locator("summary").click();
      const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) - ${v.help}`)).toEqual([]);
    });
  }
});

test.describe("layout", () => {
  for (const width of [320, 390, 768, 1366]) {
    test(`no horizontal overflow at ${width}px on the overview and the longest race pages`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const path of ["/guides/races", "/guides/races/high-order-skyborne", "/guides/races/undead", "/guides"]) {
        await page.goto(path);
        if (path.includes("/races/")) await page.getByTestId("version-history").locator("summary").click();
        expect(await overflow(page), `${path} @${width}`).toBeLessThanOrEqual(0);
      }
    });
  }

  test("touch targets: the history toggle and class links are at least 44px tall", async ({ page }) => {
    await page.goto("/guides/races/human");
    const box = await page.getByTestId("version-history").locator("summary").boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    const link = await page.getByTestId("class-mage").getByRole("link").boundingBox();
    expect(link!.height).toBeGreaterThanOrEqual(44);
  });
});

test.describe("SEO policy is unchanged", () => {
  test("local builds keep race pages noindex and the sitemap empty", async ({ page }) => {
    await page.goto("/guides/races/orc");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const sitemap = await (await page.request.get("/sitemap.xml")).text();
    expect(sitemap).not.toContain("/guides/races");
    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(ld.some((t) => t.includes('"BreadcrumbList"') && t.includes("Races"))).toBe(true);
  });
});
