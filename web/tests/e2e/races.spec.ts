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
