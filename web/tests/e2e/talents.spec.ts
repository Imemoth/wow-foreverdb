import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { BUILD_PARAM, encodeBuild, layoutHash } from "../../src/lib/talents/build-code";
import { createEngine } from "../../src/lib/talents/engine";
import { getTalentData } from "../../src/lib/talents/registry";
import { expect, test } from "./fixtures";

/**
 * Class Guides + Talent Calculator V1. Talent data is the real shipped dataset; expectations that name talents
 * (Priest) are therefore also data-version canaries: if a data update changes them, update the spec with it.
 */

const CLASS_IDS = ["warrior", "paladin", "hunter", "rogue", "priest", "shaman", "mage", "warlock", "druid"];

function priest() {
  const data = getTalentData("priest")!;
  return { data, engine: createEngine(data), byName: (n: string) => data.trees.flatMap((t) => t.talents).find((x) => x.name === n)! };
}

/** A legal build code made by buying the given talents (name, ranks) in order through the engine. */
function codeFor(picks: Array<[string, number]>): string {
  const { data, engine, byName } = priest();
  let alloc = engine.reset();
  for (const [name, n] of picks) {
    for (let i = 0; i < n; i++) {
      const v = engine.canAdd(alloc, byName(name).id);
      if (!v.ok) throw new Error(`fixture: cannot buy ${name} #${i + 1}: ${v.reason}`);
      alloc = engine.add(alloc, byName(name).id);
    }
  }
  return encodeBuild(data, alloc);
}

const tree = (page: Page, slug: string) => page.getByTestId(`tree-${slug}`);
const talent = (page: Page, treeSlug: string, name: string): Locator => tree(page, treeSlug).getByRole("button", { name: new RegExp(`^${name}, rank`) });
/** A locked talent is aria-disabled (still focusable and clickable, so it can explain itself); Playwright would otherwise wait for it to be "enabled". */
const clickLocked = (l: Locator) => l.click({ force: true });
const spent = (page: Page) => page.getByTestId("points-spent");
const remaining = (page: Page) => page.getByTestId("points-remaining");

test.describe("Class Guides navigation", () => {
  test("Guides -> Classes -> class -> specialization guide, with breadcrumbs back", async ({ page }) => {
    await page.goto("/guides");
    const entry = page.getByTestId("class-guides-entry");
    await expect(entry).toBeVisible();
    await entry.getByRole("link", { name: "Browse classes" }).click();
    await expect(page).toHaveURL(/\/guides\/classes$/);
    await expect(page.getByRole("heading", { level: 1, name: "Choose your class" })).toBeVisible();
    for (const id of CLASS_IDS) await expect(page.getByTestId(`class-card-${id}`)).toBeVisible();
    await expect(page.locator('[data-testid^="class-card-"]')).toHaveCount(9);

    await page.getByTestId("class-card-priest").getByRole("heading", { level: 2 }).getByRole("link").click();
    await expect(page).toHaveURL(/\/guides\/classes\/priest$/);
    await expect(page.getByRole("heading", { level: 1, name: "Priest" })).toBeVisible();
    const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
    await expect(crumbs.getByRole("link", { name: "Classes" })).toBeVisible();
    for (const [slug, name] of [["discipline", "Discipline"], ["holy", "Holy"], ["shadow", "Shadow Magic"]]) {
      await expect(page.getByTestId(`spec-${slug}`).getByRole("heading", { level: 3, name })).toBeVisible();
    }
    await expect(page.getByTestId("spec-discipline")).toContainText("Guide not available yet");

    await page.getByRole("link", { name: "Read the Shadow Magic guide" }).click();
    await expect(page).toHaveURL(/\/guides\/classes\/priest\/shadow$/);
    await expect(page.getByRole("heading", { level: 1, name: "Shadow Priest guide" })).toBeVisible();
    for (const name of ["Overview", "Talents", "Beginner guide"]) await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
    await expect(page.getByTestId("talent-calculator")).toBeVisible();

    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Priest" }).click();
    await expect(page).toHaveURL(/\/guides\/classes\/priest$/);
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Classes" }).click();
    await expect(page).toHaveURL(/\/guides\/classes$/);
  });

  for (const id of CLASS_IDS) {
    test(`${id}: class page shows three trees and the calculator`, async ({ page }) => {
      await page.goto(`/guides/classes/${id}`);
      await expect(page.getByTestId("talent-calculator")).toBeVisible();
      await expect(page.locator('[data-testid^="tree-"]')).toHaveCount(3);
      await expect(page.getByTestId("points-remaining")).toHaveText("51");
    });
  }

  test("unknown classes and specializations without a guide are 404", async ({ page }) => {
    expect((await page.goto("/guides/classes/death-knight"))?.status()).toBe(404);
    expect((await page.goto("/guides/classes/priest/holy"))?.status()).toBe(404);
    expect((await page.goto("/guides/classes/priest/nope"))?.status()).toBe(404);
  });

  test("SEO: canonical URL and no indexing on non-production builds", async ({ page }) => {
    await page.goto("/guides/classes/priest/shadow?b=anything");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/guides\/classes\/priest\/shadow$/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });
});

test.describe("Talent calculator (pointer and keyboard)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "pointer/keyboard behaviour; touch is covered in the mobile block");
  });

  test("left-click adds, right-click and Shift+click remove, maximum rank is enforced", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const pil = talent(page, "discipline", "Power in Light"); // max rank 5
    for (let i = 1; i <= 5; i++) {
      await pil.click();
      await expect(spent(page)).toHaveText(`${i}/51`);
    }
    await expect(pil).toHaveAccessibleName("Power in Light, rank 5 of 5");
    await pil.click(); // already maxed
    await expect(spent(page)).toHaveText("5/51");

    await pil.click({ button: "right" });
    await expect(spent(page)).toHaveText("4/51");
    await pil.click({ modifiers: ["Shift"] });
    await expect(spent(page)).toHaveText("3/51");
    await expect(remaining(page)).toHaveText("48");
    await expect(page.getByTestId("required-level")).toHaveText("12"); // level 10 gives the first point
  });

  test("tier rows unlock from points in the same tree only", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const silent = talent(page, "discipline", "Silent Resolve"); // tier 2: needs 5 points above, in Discipline
    await expect(silent).toHaveAttribute("aria-disabled", "true");
    await clickLocked(silent);
    await expect(spent(page)).toHaveText("0/51");

    // Five points in the Holy tree must not unlock a Discipline tier.
    for (const n of ["Twilight Focus", "Twilight Focus", "Twilight Focus", "Improved Renew", "Improved Renew"]) await talent(page, "holy", n).click();
    await expect(spent(page)).toHaveText("5/51");
    await expect(silent).toHaveAttribute("aria-disabled", "true");

    for (let i = 0; i < 5; i++) await talent(page, "discipline", "Power in Light").click();
    await expect(silent).not.toHaveAttribute("aria-disabled", "true");
    await silent.click();
    await expect(silent).toHaveAccessibleName("Silent Resolve, rank 1 of 3");

    // A point that an opened tier depends on cannot be taken back.
    await talent(page, "discipline", "Power in Light").click({ button: "right" });
    await expect(talent(page, "discipline", "Power in Light")).toHaveAccessibleName("Power in Light, rank 5 of 5");
    await expect(page.getByTestId("announcer")).toContainText("Another talent depends on this point");
  });

  test("a talent needs its prerequisite at full rank", async ({ page }) => {
    const code = codeFor([["Power in Light", 5], ["Wand Specialization", 2], ["Twin Disciplines", 5], ["Silent Resolve", 3], ["Improved Power Word: Shield", 2]]);
    await page.goto(`/guides/classes/priest?${BUILD_PARAM}=${code}`);
    const soul = talent(page, "discipline", "Soul Warding");
    await expect(soul).toHaveAttribute("aria-disabled", "true");
    await clickLocked(soul);
    await expect(soul).toHaveAccessibleName(/rank 0 of 1/);

    await talent(page, "discipline", "Improved Power Word: Shield").click(); // third and last rank
    await expect(soul).not.toHaveAttribute("aria-disabled", "true");
    await soul.click();
    await expect(soul).toHaveAccessibleName("Soul Warding, rank 1 of 1");
  });

  test("the point budget is shared by all trees and stops at the total", async ({ page }) => {
    const { engine, data } = priest();
    // Fill 50 of 51 points in data order through the engine, then play the last points in the browser.
    let alloc = engine.reset();
    for (const t of data.trees) for (const x of t.talents) while (engine.spent(alloc) < 50 && engine.canAdd(alloc, x.id).ok) alloc = engine.add(alloc, x.id);
    expect(engine.spent(alloc)).toBe(50);
    await page.goto(`/guides/classes/priest?${BUILD_PARAM}=${encodeBuild(data, alloc)}`);
    await expect(spent(page)).toHaveText("50/51");

    const all = data.trees.flatMap((t) => t.talents);
    const last = all.find((x) => engine.canAdd(alloc, x.id).ok)!;
    await page.locator(`[data-talent-id="${last.id}"]`).click();
    await expect(spent(page)).toHaveText("51/51");
    await expect(remaining(page)).toHaveText("0");

    alloc = engine.add(alloc, last.id);
    // Anything that would otherwise be buyable is now refused for lack of points.
    const blocked = all.find((x) => {
      const v = engine.canAdd(alloc, x.id);
      return !v.ok && v.reason === "no-points";
    });
    expect(blocked, "expected an unlocked but unaffordable talent").toBeTruthy();
    await clickLocked(page.locator(`[data-talent-id="${blocked!.id}"]`));
    await expect(spent(page)).toHaveText("51/51");
    await expect(page.getByTestId("announcer")).toContainText("No talent points remaining");
  });

  test("Reset build clears everything and the build link", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    await expect(page.getByTestId("reset-build")).toBeDisabled();
    await talent(page, "discipline", "Power in Light").click();
    await expect(page).toHaveURL(new RegExp(`[?&]${BUILD_PARAM}=`));
    await page.getByTestId("reset-build").click();
    await expect(spent(page)).toHaveText("0/51");
    await expect(remaining(page)).toHaveText("51");
    await expect(page).not.toHaveURL(new RegExp(`[?&]${BUILD_PARAM}=`));
    await expect(page.getByTestId("reset-build")).toBeDisabled();
  });

  test("the URL is the share link: it restores the build on reload and in a new page", async ({ page, context }) => {
    await page.goto("/guides/classes/priest");
    for (const [tr, n, times] of [["discipline", "Power in Light", 3], ["shadow-magic", "Shadow Focus", 5], ["shadow-magic", "Spirit Tap", 2]] as const) {
      for (let i = 0; i < times; i++) await talent(page, tr, n).click();
    }
    await expect(spent(page)).toHaveText("10/51");
    await page.getByTestId("share-build").click();
    const link = await page.getByLabel("Build link").inputValue();
    expect(link).toBe(page.url());
    expect(new URL(link).searchParams.get(BUILD_PARAM)).toBe(codeFor([["Power in Light", 3], ["Shadow Focus", 5], ["Spirit Tap", 2]]));

    await page.reload();
    await expect(spent(page)).toHaveText("10/51");
    await expect(talent(page, "shadow-magic", "Shadow Focus")).toHaveAccessibleName("Shadow Focus, rank 5 of 5");

    const other = await context.newPage();
    await other.goto(link);
    await expect(spent(other)).toHaveText("10/51");
    await expect(talent(other, "discipline", "Power in Light")).toHaveAccessibleName("Power in Light, rank 3 of 5");
    await expect(other.getByTestId("link-error")).toHaveCount(0);
  });

  test("the same build also restores on the Shadow guide page", async ({ page }) => {
    const code = codeFor([["Shadow Focus", 5], ["Blackout", 5]]);
    await page.goto(`/guides/classes/priest/shadow?${BUILD_PARAM}=${code}`);
    await expect(spent(page)).toHaveText("10/51");
  });

  test.describe("invalid build links are refused and explained", () => {
    const hash = layoutHash(getTalentData("priest")!);
    const cases: Array<[string, string, string, RegExp]> = [
      ["garbage", "/guides/classes/priest", "not-a-code", /not valid/],
      ["script-like input", "/guides/classes/priest", "<script>alert(1)</script>", /not valid/],
      ["a different data version", "/guides/classes/priest", "zzzzzz.1--", /different version/],
      ["another class's link", "/guides/classes/warrior", codeFor([["Shadow Focus", 5]]), /different version/],
      ["ranks above the maximum", "/guides/classes/priest", `${hash}.9--`, /ranks that do not exist/],
      ["a locked talent without its requirements", "/guides/classes/priest", `${hash}.0001--`, /break|breaks/],
    ];
    for (const [name, path, code, message] of cases) {
      test(name, async ({ page }) => {
        await page.goto(`${path}?${BUILD_PARAM}=${encodeURIComponent(code)}`);
        await expect(page.getByTestId("link-error")).toContainText(message);
        await expect(spent(page)).toHaveText("0/51");
        // The bad parameter is cleaned from the address bar and the calculator stays usable.
        await expect(page).not.toHaveURL(new RegExp(`[?&]${BUILD_PARAM}=`));
        await page.getByRole("button", { name: /rank 0 of/ }).first().click();
        await expect(spent(page)).toHaveText("1/51");
        await expect(page.getByTestId("link-error")).toHaveCount(0);
      });
    }
  });

  test("keyboard: Enter adds, Backspace removes, arrows move, one tab stop per tree", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const disc = tree(page, "discipline");
    await expect(disc.locator('[data-talent-id][tabindex="0"]')).toHaveCount(1);

    const first = talent(page, "discipline", "Power in Light");
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(spent(page)).toHaveText("1/51");
    await page.keyboard.press("Space");
    await expect(spent(page)).toHaveText("2/51");
    await page.keyboard.press("Backspace");
    await expect(spent(page)).toHaveText("1/51");

    await page.keyboard.press("ArrowRight");
    await expect(talent(page, "discipline", "Wand Specialization")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(talent(page, "discipline", "Holy Precision")).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(talent(page, "discipline", "Silent Resolve")).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(first).toBeFocused();
    // Roving tabindex follows focus.
    await expect(first).toHaveAttribute("tabindex", "0");
    await expect(talent(page, "discipline", "Silent Resolve")).toHaveAttribute("tabindex", "-1");
    // Status changes are announced to assistive technology.
    await expect(page.getByTestId("announcer")).toContainText("points remaining");
  });

  test.describe("hover tooltip and selected-talent panel are separate states", () => {
    const tooltip = (page: Page) => page.getByTestId("talent-tooltip");
    const detail = (page: Page) => page.getByTestId("talent-detail");

    test("the tooltip appears only while hovering and disappears immediately on mouse leave", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      await expect(tooltip(page)).toHaveCount(0);

      await talent(page, "discipline", "Silent Resolve").hover();
      await expect(tooltip(page)).toBeVisible();
      await expect(tooltip(page)).toContainText("Silent Resolve");
      await expect(tooltip(page)).toContainText("Rank 0/3");
      await expect(tooltip(page)).toContainText("Requires 5 points in Discipline (0/5)");
      // Real, build-verified game text with the client's per-rank numbers: rank 1 is shown before the first point.
      await expect(tooltip(page)).toContainText("Rank 1: Reduces the threat generated by your spells by 10% and reduces the duration of Stun, Fear, and Silence effects inflicted on you by 5%.");
      await expect(tooltip(page).locator("[data-gap]")).toHaveCount(0);
      await expect(tooltip(page)).toContainText("Spell ID 14523");

      // Moving to another talent swaps the tooltip; leaving every talent removes it at once.
      await talent(page, "discipline", "Soul Warding").hover();
      await expect(tooltip(page)).toHaveCount(1);
      await expect(tooltip(page)).toContainText("Requires Improved Power Word: Shield at rank 3");
      await page.mouse.move(0, 0);
      await expect(tooltip(page)).toHaveCount(0);
    });

    test("hovering never selects: the panel stays empty and the build is untouched", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      await talent(page, "discipline", "Power in Light").hover();
      await expect(tooltip(page)).toBeVisible();
      await expect(detail(page)).toContainText("Select a talent to see its details");
      await expect(spent(page)).toHaveText("0/51");
    });

    test("selecting does not keep a tooltip open: the selection lives only in the bottom panel", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      const silent = talent(page, "discipline", "Silent Resolve");
      await silent.hover();
      await clickLocked(silent); // selects without spending a point
      await expect(spent(page)).toHaveText("0/51");
      await expect(detail(page)).toContainText("Silent Resolve");
      await expect(detail(page)).toContainText("Requires 5 points in Discipline (0/5)");
      await expect(detail(page)).toContainText("Spell ID 14523");

      await page.mouse.move(0, 0);
      await expect(tooltip(page)).toHaveCount(0);
      await expect(detail(page)).toContainText("Silent Resolve");
    });

    test("hover and selection are independent: hovering B shows B's tooltip while the panel keeps A", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      await clickLocked(talent(page, "discipline", "Silent Resolve"));
      await page.mouse.move(0, 0);
      await talent(page, "discipline", "Soul Warding").hover();
      await expect(tooltip(page)).toContainText("Soul Warding");
      await expect(detail(page)).toContainText("Silent Resolve");
      await expect(detail(page)).not.toContainText("Soul Warding");
      await page.mouse.move(0, 0);
      await expect(tooltip(page)).toHaveCount(0);
      await expect(detail(page)).toContainText("Silent Resolve");
    });

    test("keyboard focus selects into the panel but never opens a floating tooltip", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      await talent(page, "discipline", "Soul Warding").focus();
      await expect(detail(page)).toContainText("Soul Warding");
      await expect(detail(page)).toContainText("Requires Improved Power Word: Shield at rank 3");
      await expect(tooltip(page)).toHaveCount(0);
      await expect(spent(page)).toHaveText("0/51");
    });

    test("Escape closes the tooltip and clears the selection, leaving nothing behind", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      const silent = talent(page, "discipline", "Silent Resolve");
      await clickLocked(silent);
      await expect(detail(page)).toContainText("Silent Resolve");
      await talent(page, "discipline", "Power in Light").hover();
      await expect(tooltip(page)).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(tooltip(page)).toHaveCount(0);
      await expect(detail(page)).toContainText("Select a talent to see its details");
      await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
      // The pointer is still over the talent; the tooltip must not come back until it re-enters.
      await page.waitForTimeout(150);
      await expect(tooltip(page)).toHaveCount(0);
    });
  });

  test("Escape closes a hover-only tooltip even when focus is outside the calculator", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    await talent(page, "discipline", "Power in Light").hover();
    await expect(page.getByTestId("talent-tooltip")).toBeVisible();
    await expect(page.getByTestId("talent-detail")).toContainText("Select a talent to see its details");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("talent-tooltip")).toHaveCount(0);
  });

  test.describe("real build-verified descriptions", () => {
    test("per-rank text shows the current rank and the next one, with the exact client numbers, in the tooltip and the panel", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      const pil = talent(page, "discipline", "Power in Light");
      await pil.hover();
      const tip = page.getByTestId("talent-tooltip").getByTestId("talent-description");
      await expect(tip).toContainText("Rank 1: Your Smite and Penance spells deal 2% increased damage to targets afflicted with your Holy Fire or Shadow Word: Pain.");
      await expect(tip).toHaveAttribute("data-complete", "true");
      await expect(page.getByTestId("talent-tooltip").locator("[data-gap]")).toHaveCount(0);
      // Select it and add two points: the panel shows rank 2 and the next rank; the hover tooltip is gone.
      await pil.click();
      await pil.click();
      await page.mouse.move(0, 0);
      await expect(page.getByTestId("talent-tooltip")).toHaveCount(0);
      const panel = page.getByTestId("talent-detail").getByTestId("talent-description");
      await expect(panel).toContainText("Your Smite and Penance spells deal 4% increased damage");
      await expect(panel).toContainText("Next rank: Your Smite and Penance spells deal 6% increased damage");
    });

    test("a single-rank talent shows its exact text and no gap", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      const soul = talent(page, "discipline", "Soul Warding");
      await soul.hover();
      await expect(page.getByTestId("talent-tooltip").getByTestId("talent-description")).toHaveText("Reduces the cooldown on your Power Word: Shield spell by 4 sec and reduces its mana cost by 15%.");
      await soul.focus();
      await page.keyboard.press("Enter");
      await page.mouse.move(0, 0);
      await expect(page.getByTestId("talent-detail").getByTestId("talent-description")).toHaveText("Reduces the cooldown on your Power Word: Shield spell by 4 sec and reduces its mana cost by 15%.");
    });

    test("a number that depends on another spell stays a visible, labelled, explained gap - never guessed", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      const penance = talent(page, "discipline", "Penance");
      await penance.click({ force: true }); // locked at the start: selecting it to read it is still allowed
      await page.mouse.move(0, 0);
      const panel = page.getByTestId("talent-detail");
      await expect(panel.getByTestId("talent-description")).toContainText("Launches a volley of holy light at the target, causing");
      await expect(panel.getByTestId("talent-description")).toHaveAttribute("data-complete", "false");
      const gap = panel.locator('[data-gap="spell"]').first();
      await expect(gap).toHaveAttribute("role", "img");
      await expect(gap).toHaveAccessibleName(/value not available: .*another spell/);
      await expect(panel.getByTestId("talent-description-gaps")).toContainText("another spell whose data is not available for this build yet");
    });
  });

  test.describe("descriptions and icons (synthetic overlay on the real Priest tree)", () => {
    const fixture = "/test-fixtures/talents";

    test("per-rank descriptions render in the tooltip and the panel; rank changes the text", async ({ page }) => {
      await page.goto(fixture);
      const pil = talent(page, "discipline", "Power in Light");
      await pil.hover();
      await expect(page.getByTestId("talent-tooltip").getByTestId("talent-description")).toContainText("Rank 1: SYNTHETIC rank 1 text");
      await pil.click();
      await pil.click();
      await expect(page.getByTestId("talent-detail").getByTestId("talent-description")).toContainText("SYNTHETIC rank 2 text for Power in Light.");
      await expect(page.getByTestId("talent-detail").getByTestId("talent-description")).toContainText("Next rank: SYNTHETIC rank 3 text");
      // A talent at maximum rank shows only its current text.
      for (let i = 0; i < 3; i++) await pil.click();
      await expect(page.getByTestId("talent-detail").getByTestId("talent-description")).toContainText("SYNTHETIC rank 5 text");
      await expect(page.getByTestId("talent-detail").getByTestId("talent-description")).not.toContainText("Next rank");
    });

    test("a single description is surfaced cleanly, and an entry that does not fit stays honestly empty", async ({ page }) => {
      await page.goto(fixture);
      await talent(page, "shadow-magic", "Shadow Focus").hover();
      await expect(page.getByTestId("talent-tooltip").getByTestId("talent-description")).toHaveText("SYNTHETIC single description for Shadow Focus.");
      await talent(page, "shadow-magic", "Blackout").hover();
      const tip = page.getByTestId("talent-tooltip");
      await expect(tip).toContainText("No description could be verified");
      await expect(tip).not.toContainText("SYNTHETIC only one entry");
    });

    test("icons render when present and degrade to the name plate when absent or broken", async ({ page }) => {
      await page.goto(fixture);
      const withIcon = talent(page, "discipline", "Power in Light");
      await expect(withIcon.getByTestId("talent-icon")).toHaveCount(1);
      await expect(withIcon.getByTestId("talent-icon")).toBeVisible();
      // The icon is decorative; the name is still real text on the button.
      await expect(withIcon).toHaveAccessibleName("Power in Light, rank 0 of 5");

      // Broken URL: the img fails to load and the node falls back to its plain name plate.
      const broken = talent(page, "shadow-magic", "Blackout");
      await expect(broken.getByTestId("talent-icon")).toHaveCount(0);
      await expect(broken).toContainText("Blackout");

      // No icon known for this talent at all.
      const none = talent(page, "discipline", "Wand Specialization");
      await expect(none.getByTestId("talent-icon")).toHaveCount(0);
      await expect(none).toContainText("Wand Specialization");

      // The calculator stays fully usable around them.
      await broken.click();
      await expect(spent(page)).toHaveText("1/51");
    });

    test("the icon also appears in the tooltip and the panel header", async ({ page }) => {
      await page.goto(fixture);
      const pil = talent(page, "discipline", "Power in Light");
      await pil.hover();
      await expect(page.getByTestId("talent-tooltip").getByTestId("card-icon")).toBeVisible();
      await pil.click();
      await page.mouse.move(0, 0);
      await expect(page.getByTestId("talent-detail").getByTestId("card-icon")).toBeVisible();
    });

    test("the real dataset ships verified text (with marked gaps) but no icons, and says so", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      await expect(page.getByTestId("talent-icon")).toHaveCount(0);
      await expect(page.getByTestId("talent-calculator")).toContainText("have a verified description");
      await expect(page.getByTestId("talent-calculator")).toContainText("Icons are not included");
      // Name plates: every talent still names itself.
      await expect(talent(page, "shadow-magic", "Shadowform")).toContainText("Shadowform");
    });
  });

  test.describe("background art", () => {
    test("class hero, tree and card backdrops are decorative, inert and do not block the page", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      const hero = page.getByTestId("class-hero").getByTestId("backdrop-hero");
      await expect(hero).toHaveAttribute("aria-hidden", "true");
      await expect(hero).toHaveCSS("pointer-events", "none");
      for (const slug of ["discipline", "holy", "shadow-magic"]) {
        const b = tree(page, slug).getByTestId("backdrop-tree");
        await expect(b).toHaveCount(1);
        await expect(b).toHaveAttribute("aria-hidden", "true");
        await expect(b).toHaveCSS("pointer-events", "none");
      }
      // Themed per tree (decorative motif only).
      await expect(tree(page, "shadow-magic").getByTestId("backdrop-tree")).toHaveAttribute("data-motif", "vortex");
      await expect(tree(page, "holy").getByTestId("backdrop-tree")).toHaveAttribute("data-motif", "rays");
      // Interaction is unaffected: the title, link and nodes beneath/above the art stay clickable.
      await expect(page.getByRole("link", { name: "Open the talent calculator" })).toBeVisible();
      await talent(page, "shadow-magic", "Shadow Focus").click();
      await expect(spent(page)).toHaveText("1/51");
      // The art adds no focusable or text content of its own.
      await expect(page.getByTestId("class-hero").locator("svg a, svg button, svg [tabindex]")).toHaveCount(0);
    });

    test("class cards show the class illustration behind readable, clickable content", async ({ page }) => {
      await page.goto("/guides/classes");
      for (const id of CLASS_IDS) {
        const card = page.getByTestId(`class-card-${id}`);
        await expect(card.getByTestId("class-card-art")).toHaveAttribute("aria-hidden", "true");
        await expect(card.getByTestId("class-card-art")).toHaveAttribute("src", `/class-cards/${id}.webp`);
        await expect(card.getByRole("link", { name: "Talent calculator" })).toBeVisible();
      }
      await expect(page.locator('[data-testid="class-card-art"]')).toHaveCount(9);
      await page.getByTestId("class-card-druid").getByRole("link", { name: "Druid" }).click();
      await expect(page).toHaveURL(/\/guides\/classes\/druid$/);
    });

    test("tooltips are not clipped: no ancestor of the tooltip hides overflow", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      await talent(page, "discipline", "Martyrdom").hover();
      const tip = page.getByTestId("talent-tooltip");
      await expect(tip).toBeVisible();
      const clipping = await tip.evaluate((el) => {
        const bad: string[] = [];
        for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
          const o = getComputedStyle(n);
          if (o.overflowX !== "visible" || o.overflowY !== "visible") bad.push(`${n.tagName}.${n.className}`);
        }
        return bad;
      });
      expect(clipping).toEqual([]);
      // And it stays inside the viewport.
      const box = await tip.boundingBox();
      const vp = page.viewportSize()!;
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
    });
  });

  test("accessibility (axe WCAG 2.2 AA) with points allocated, a talent selected and a tooltip open", async ({ page }) => {
    const code = codeFor([["Power in Light", 5], ["Wand Specialization", 2], ["Shadow Focus", 3], ["Blackout", 5]]);
    await page.goto(`/guides/classes/priest?${BUILD_PARAM}=${code}`);
    await talent(page, "discipline", "Silent Resolve").click();
    await talent(page, "shadow-magic", "Improved Psychic Scream").hover();
    await expect(page.getByTestId("talent-tooltip")).toBeVisible();
    await expect(page.getByTestId("talent-detail")).toContainText("Silent Resolve");
    const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) - ${v.help}`)).toEqual([]);
  });

  test("the Shadow guide page lists the tree and keeps the Shadow tree outlined", async ({ page }) => {
    await page.goto("/guides/classes/priest/shadow");
    await expect(page.getByRole("table", { name: "Talents of the Shadow Magic tree by tier" })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: "Shadowform" })).toBeVisible();
    await expect(page.getByText("Not verified yet.")).toBeVisible();
  });
});

test.describe("Talent calculator (touch / mobile)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "touch layout");
  });

  for (const path of ["/guides/classes", "/guides/classes/priest", "/guides/classes/priest/shadow"]) {
    test(`no horizontal page scroll: ${path}`, async ({ page }) => {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("tap adds a point, the detail panel removes it, targets are large enough", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const pil = talent(page, "discipline", "Power in Light");
    const box = await pil.boundingBox();
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);

    await pil.scrollIntoViewIfNeeded();
    await pil.tap();
    await pil.tap();
    await expect(spent(page)).toHaveText("2/51");
    const panel = page.getByTestId("talent-detail");
    await expect(panel).toContainText("Power in Light");
    await expect(panel).toContainText("Rank 2/5");

    await panel.getByRole("button", { name: /Remove a point from Power in Light/ }).tap();
    await expect(spent(page)).toHaveText("1/51");
    await panel.getByRole("button", { name: /Remove a point/ }).tap();
    await expect(spent(page)).toHaveText("0/51");
    await expect(panel.getByRole("button", { name: /Remove a point/ })).toBeDisabled();
    await panel.getByRole("button", { name: /Add a point to Power in Light/ }).tap();
    await expect(spent(page)).toHaveText("1/51");
  });
  test("tapping a talent shows its real description in the panel, with no floating tooltip", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const soul = talent(page, "discipline", "Soul Warding");
    await soul.scrollIntoViewIfNeeded();
    await soul.tap({ force: true }); // locked (aria-disabled): selecting it to read it is still allowed
    const panel = page.getByTestId("talent-detail");
    await expect(panel.getByTestId("talent-description")).toHaveText("Reduces the cooldown on your Power Word: Shield spell by 4 sec and reduces its mana cost by 15%.");
    const penance = talent(page, "discipline", "Penance");
    await penance.scrollIntoViewIfNeeded();
    await penance.tap({ force: true });
    await expect(panel.locator('[data-gap="spell"]').first()).toBeVisible();
    await expect(panel.getByTestId("talent-description-gaps")).toBeVisible();
    await expect(page.getByTestId("talent-tooltip")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

});
