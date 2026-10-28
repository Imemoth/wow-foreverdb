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

// Alphabetical, the order of the class chooser.
const CLASS_IDS = ["druid", "hunter", "mage", "paladin", "priest", "rogue", "shaman", "warlock", "warrior"];

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
      await expect(panel.getByTestId("talent-description-gaps")).toContainText("marks a value that is not available for this build yet");
      // The reasons are one click away instead of always on screen.
      const reasons = panel.getByTestId("talent-description-gap-reasons");
      await expect(reasons).not.toHaveAttribute("open", "");
      await reasons.getByText("Why?").click();
      await expect(reasons).toContainText("another spell whose data is not available for this build yet");
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

    test("without the icon switch every talent shows its name plate (no icons are requested)", async ({ page }) => {
      await page.goto("/guides/classes/priest");
      await expect(page.getByTestId("talent-icon")).toHaveCount(0);
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

    test("class cards carry a backdrop behind readable, clickable content", async ({ page }) => {
      await page.goto("/guides/classes");
      for (const id of ["warrior", "priest", "druid"]) {
        const card = page.getByTestId(`class-card-${id}`);
        await expect(card.getByTestId("backdrop-card")).toHaveAttribute("aria-hidden", "true");
        await expect(card.getByRole("link", { name: "Talent calculator" })).toBeVisible();
      }
      await expect(page.locator('[data-testid="backdrop-card"]')).toHaveCount(9);
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

test.describe("Talent calculator UI V2 (desktop)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop interactions; the mobile project has its own tests below");
  });

  test("the technical provenance panel is gone everywhere, and the legal notice stays in the footer", async ({ page }) => {
    for (const url of ["/guides/classes", "/guides/classes/priest", "/guides/classes/priest/shadow"]) {
      await page.goto(url);
      await expect(page.getByText("Talent structure (names, ranks", { exact: false })).toHaveCount(0);
      await expect(page.getByText("as extracted by the Everloot project")).toHaveCount(0);
      await expect(page.getByText("have a verified description")).toHaveCount(0);
      const footer = page.getByRole("contentinfo");
      await expect(footer).toContainText("independent, free, non-commercial fan project");
      await expect(footer).toContainText("not affiliated with or endorsed by Blizzard Entertainment");
      await expect(footer).toContainText("Blizzard Entertainment, Inc. All rights reserved");
      await expect(footer).toContainText("talent names, descriptions and icons");
    }
    // The provenance itself is documented on the data page.
    await page.goto("/about/data");
    await expect(page.locator("#class-guides")).toBeVisible();
    await expect(page.locator("#class-guides").locator("xpath=following-sibling::p[1]")).toContainText("Everloot");
  });

  test("the class chooser lists the classes alphabetically", async ({ page }) => {
    await page.goto("/guides/classes");
    const names = await page.locator('[data-testid^="class-card-"] h2').allTextContents();
    expect(names.map((n) => n.trim())).toEqual(["Druid", "Hunter", "Mage", "Paladin", "Priest", "Rogue", "Shaman", "Warlock", "Warrior"]);
    await page.goto("/guides");
    const entry = await page.getByTestId("class-guides-entry").getByRole("link").allTextContents();
    const order = entry.map((t) => t.trim()).filter((t) => CLASS_IDS.map((c) => c[0]!.toUpperCase() + c.slice(1)).includes(t));
    expect(order).toEqual([...order].sort((a, b) => a.localeCompare(b)));
  });

  test("node states are distinct: available, locked, in progress, maxed, plus a separate selected mark", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const pil = talent(page, "discipline", "Power in Light");
    const wand = talent(page, "discipline", "Wand Specialization");
    const silent = talent(page, "discipline", "Silent Resolve");
    await expect(pil).toHaveAttribute("data-state", "available");
    await expect(silent).toHaveAttribute("data-state", "locked");
    // Only locked nodes carry the lock glyph; every node shows its rank as text in a badge.
    await expect(silent.locator("svg")).toHaveCount(1);
    await expect(pil.locator("svg")).toHaveCount(0);
    await expect(pil.getByTestId("rank-badge")).toHaveText("0/5");
    await pil.click();
    await expect(pil).toHaveAttribute("data-state", "partial");
    await expect(pil.getByTestId("rank-badge")).toHaveText("1/5");
    for (let i = 0; i < 4; i++) await pil.click();
    await expect(pil).toHaveAttribute("data-state", "maxed");
    await expect(pil.getByTestId("rank-badge")).toHaveText("5/5");
    // The badge is compact (10-11px) but still readable text.
    const size = await pil.getByTestId("rank-badge").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(10);
    expect(size).toBeLessThanOrEqual(11);
    // Selection is its own mark (data-selected), independent of the state.
    await expect(pil).toHaveAttribute("data-selected", "true");
    await expect(wand).not.toHaveAttribute("data-selected", "true");
    await wand.click();
    await expect(wand).toHaveAttribute("data-selected", "true");
    await expect(pil).not.toHaveAttribute("data-selected", "true");
    await expect(pil).toHaveAttribute("data-state", "maxed");
    // The five states are listed in a legend.
    await expect(page.getByRole("list", { name: "Talent states" }).getByRole("listitem")).toHaveText(["Available", "In progress", "Maxed", "Locked", "Selected"]);
  });

  test("prerequisite connections: unmet are dashed, met are solid, and the selected talent's lines are emphasised", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const disc = tree(page, "discipline");
    // Soul Warding needs Improved Power Word: Shield at rank 3: that connection starts unmet.
    const links = disc.locator("[data-link-state]");
    expect(await links.count()).toBeGreaterThan(1);
    await expect(disc.locator('[data-link-state="met"]')).toHaveCount(0);
    expect(await disc.locator('[data-link-state="unmet"]').count()).toBeGreaterThan(0);
    await expect(disc.locator("[data-link-focus]")).toHaveCount(0);
    const target = talent(page, "discipline", "Soul Warding");
    await clickLocked(target);
    const focused = await disc.locator("[data-link-focus]").count();
    expect(focused).toBeGreaterThan(0);
    // Buying the prerequisite at full rank makes its connection met (build from a known-legal code).
    const code = codeFor([["Power in Light", 5], ["Twin Disciplines", 5], ["Improved Power Word: Shield", 3]]);
    await page.goto(`/guides/classes/priest?${BUILD_PARAM}=${code}`);
    expect(await tree(page, "discipline").locator('[data-link-state="met"]').count()).toBeGreaterThan(0);
  });

  test("the detail panel shows the selected rank as text and pips, and the buttons follow the rules", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const panel = page.getByTestId("talent-detail");
    const pil = talent(page, "discipline", "Power in Light");
    await pil.click();
    await expect(panel.getByTestId("rank-summary")).toContainText("Rank 1/5");
    await expect(panel.getByTestId("rank-pips").locator("span")).toHaveCount(5);
    await expect(panel.getByTestId("rank-pips").locator("span.bg-violet-300")).toHaveCount(1);
    await panel.getByRole("button", { name: /Add a point to Power in Light/ }).click();
    await expect(panel.getByTestId("rank-summary")).toContainText("Rank 2/5");
    await expect(panel.getByTestId("rank-pips").locator("span.bg-violet-300")).toHaveCount(2);
    await panel.getByRole("button", { name: /Remove a point from Power in Light/ }).click();
    await expect(panel.getByTestId("rank-summary")).toContainText("Rank 1/5");
    for (let i = 0; i < 4; i++) await panel.getByRole("button", { name: /Add a point/ }).click();
    await expect(panel.getByTestId("rank-summary")).toContainText("Rank 5/5");
    await expect(panel.getByRole("button", { name: /Add a point/ })).toBeDisabled();
    await expect(panel.getByTestId("talent-status")).toHaveText("Maximum rank");
    await expect(panel.getByTestId("rank-pips").locator("span.bg-gold-300")).toHaveCount(5);
  });

  test("tooltip: compact and hover-only; the panel keeps the long form with the reasons behind 'Why?'", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    await clickLocked(talent(page, "discipline", "Penance"));
    await page.mouse.move(0, 0);
    const panel = page.getByTestId("talent-detail");
    await expect(panel.getByTestId("talent-description-gap-reasons")).toBeVisible();
    // Hovering another talent with gaps: the tooltip has no 'Why?' block, only the one-line note, and it vanishes on leave.
    const mart = talent(page, "discipline", "Martyrdom");
    await mart.hover();
    const tip = page.getByTestId("talent-tooltip");
    await expect(tip).toBeVisible();
    await expect(tip.getByTestId("talent-description-gap-reasons")).toHaveCount(0);
    await expect(tip.getByTestId("talent-description-gaps")).toContainText("not available for this build yet");
    await expect(tip.getByTestId("rank-summary")).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(tip).toHaveCount(0);
    // The panel still shows Penance, not Martyrdom (hover never selects).
    await expect(panel).toContainText("Penance");
  });

  test("keyboard still works: arrows move, Enter adds, Backspace removes, Escape clears", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const pil = talent(page, "discipline", "Power in Light");
    await pil.focus();
    await page.keyboard.press("Enter");
    await expect(pil.getByTestId("rank-badge")).toHaveText("1/5");
    await page.keyboard.press("ArrowRight");
    await expect(page.getByTestId("talent-detail")).toContainText("Wand Specialization");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Backspace");
    await expect(pil.getByTestId("rank-badge")).toHaveText("0/5");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("talent-detail")).toContainText("Select a talent");
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
    // The sheet starts collapsed (name, rank, Add/Remove); the toggle shows the full details.
    await expect(panel.getByTestId("talent-description")).toBeHidden();
    await panel.getByTestId("panel-toggle").tap();
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

test.describe("Talent calculator V2.1: compact geometry", () => {
  // Every class page, every tree: the frame, hit area, badge and connector geometry is measured in the browser, not assumed.
  for (const id of CLASS_IDS) {
    test(`${id}: square compact nodes, 44px hit areas, no overlaps, connectors end on node centres`, async ({ page }, testInfo) => {
      const mobile = testInfo.project.name === "mobile";
      await page.goto(`/guides/classes/${id}`);
      await expect(page.getByTestId("talent-grid").first()).toBeVisible();
      const report = await page.evaluate(() => {
        type R = { x: number; y: number; w: number; h: number };
        const rect = (el: Element): R => {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        };
        const hit = (a: R, b: R) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
        const out: { trees: number; nodes: number; problems: string[]; frame: number[]; hitMin: number; badgeFont: number[]; tops: number[]; lines: number } = {
          trees: 0, nodes: 0, problems: [], frame: [], hitMin: 999, badgeFont: [], tops: [], lines: 0,
        };
        for (const grid of Array.from(document.querySelectorAll('[data-testid="talent-grid"]'))) {
          out.trees++;
          const cols = Number(grid.getAttribute("data-cols"));
          const rows = Number(grid.getAttribute("data-rows"));
          const g = rect(grid);
          out.tops.push(Math.round(g.y));
          const cw = g.w / cols;
          const ch = g.h / rows;
          const nodes = Array.from(grid.querySelectorAll<HTMLButtonElement>("button[data-talent-id]")).map((b) => {
            const f = b.querySelector('[data-testid="node-frame"]')!;
            const bd = b.querySelector('[data-testid="rank-badge"]')!;
            return { name: b.getAttribute("aria-label")!, btn: rect(b), frame: rect(f), badge: rect(bd), font: parseFloat(getComputedStyle(bd).fontSize) };
          });
          out.nodes += nodes.length;
          for (const n of nodes) {
            out.frame.push(Math.round(n.frame.w * 10) / 10);
            if (Math.abs(n.frame.w - n.frame.h) > 0.5) out.problems.push(`${n.name}: frame not square ${n.frame.w}x${n.frame.h}`);
            if (n.btn.w < 44 || n.btn.h < 44) out.problems.push(`${n.name}: hit area ${n.btn.w}x${n.btn.h}`);
            out.hitMin = Math.min(out.hitMin, n.btn.w, n.btn.h);
            out.badgeFont.push(n.font);
            // The frame is centred in its cell.
            const cx = n.frame.x + n.frame.w / 2;
            const cy = n.frame.y + n.frame.h / 2;
            if (Math.abs(cx - (n.btn.x + n.btn.w / 2)) > 0.6 || Math.abs(cy - (n.btn.y + n.btn.h / 2)) > 0.6) out.problems.push(`${n.name}: frame not centred in its cell`);
            // The badge stays inside the cell (so it can never reach a neighbour) and is a small corner mark.
            if (n.badge.x < n.btn.x - 0.5 || n.badge.y < n.btn.y - 0.5 || n.badge.x + n.badge.w > n.btn.x + n.btn.w + 0.5 || n.badge.y + n.badge.h > n.btn.y + n.btn.h + 0.5) out.problems.push(`${n.name}: badge leaves its cell`);
            const ix = Math.max(0, Math.min(n.badge.x + n.badge.w, n.frame.x + n.frame.w) - Math.max(n.badge.x, n.frame.x));
            const iy = Math.max(0, Math.min(n.badge.y + n.badge.h, n.frame.y + n.frame.h) - Math.max(n.badge.y, n.frame.y));
            if (ix * iy > 0.16 * n.frame.w * n.frame.h) out.problems.push(`${n.name}: badge covers ${Math.round((100 * ix * iy) / (n.frame.w * n.frame.h))}% of the icon`);
          }
          for (let i = 0; i < nodes.length; i++)
            for (let j = i + 1; j < nodes.length; j++) {
              const a = nodes[i]!, b = nodes[j]!;
              if (hit(a.btn, b.btn) || hit(a.frame, b.frame) || hit(a.badge, b.badge) || hit(a.badge, b.frame) || hit(b.badge, a.frame)) out.problems.push(`${a.name} overlaps ${b.name}`);
            }
          // Connectors: both ends of every line are on a node centre.
          const svg = grid.querySelector("svg")!;
          const s = rect(svg);
          for (const line of Array.from(svg.querySelectorAll("line"))) {
            out.lines++;
            for (const [px, py] of [[Number(line.getAttribute("x1")), Number(line.getAttribute("y1"))], [Number(line.getAttribute("x2")), Number(line.getAttribute("y2"))]] as const) {
              const x = s.x + (px / cols) * s.w;
              const y = s.y + (py / rows) * s.h;
              const near = nodes.some((n) => Math.abs(n.frame.x + n.frame.w / 2 - x) <= 1 && Math.abs(n.frame.y + n.frame.h / 2 - y) <= 1);
              if (!near) out.problems.push(`connector end (${x.toFixed(1)}, ${y.toFixed(1)}) misses every node centre`);
            }
          }
          if (Math.abs(cw - ch) > 0.1) out.problems.push(`cells not square ${cw}x${ch}`);
        }
        return out;
      });
      expect(report.problems).toEqual([]);
      expect(report.trees).toBe(3);
      expect(report.nodes).toBeGreaterThan(30);
      expect(report.lines).toBeGreaterThan(0);
      // Frames: ~46px on desktop, ~42px on phones; the hit area is the 48/56px cell.
      const [lo, hi] = mobile ? [40, 44] : [44, 48];
      for (const f of report.frame) {
        expect(f).toBeGreaterThanOrEqual(lo);
        expect(f).toBeLessThanOrEqual(hi);
      }
      expect(report.hitMin).toBeGreaterThanOrEqual(44);
      for (const f of report.badgeFont) {
        expect(f).toBeGreaterThanOrEqual(10);
        expect(f).toBeLessThanOrEqual(11);
      }
      // The three trees of a class sit on one line on desktop.
      if (!mobile) expect(new Set(report.tops).size).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    });
  }
});

test.describe("Talent calculator V2.1: panel, help and tooltip (desktop)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop interactions");
  });

  test("the detail panel is compact and dismissible: close button, Escape, focus returns to the talent", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const panel = page.getByTestId("talent-detail");
    const pil = talent(page, "discipline", "Power in Light");
    await expect(panel.getByTestId("talent-detail-card")).toHaveCount(0);
    await pil.click();
    const card = panel.getByTestId("talent-detail-card");
    await expect(card).toBeVisible();
    // Compact: a horizontal header (name + rank + actions on one row on desktop) and a short card.
    const box = (await card.boundingBox())!;
    expect(box.height).toBeLessThan(300);
    const name = (await card.getByText("Power in Light", { exact: true }).boundingBox())!;
    const add = (await card.getByRole("button", { name: /Add a point/ }).boundingBox())!;
    expect(Math.abs(name.y - add.y)).toBeLessThan(40);
    await expect(card.getByRole("button", { name: "Close talent details" })).toBeVisible();
    await expect(card.getByTestId("panel-toggle")).toBeHidden(); // the collapse control is a phone-only affordance
    await expect(card.getByTestId("talent-detail-body")).toBeVisible();
    // The wrapper lets clicks through; only the card itself takes them.
    expect(await panel.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    expect(await card.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");
    // Close: the panel goes, the build is untouched, the talent keeps focus but is not re-selected.
    await card.getByRole("button", { name: "Close talent details" }).click();
    await expect(panel.getByTestId("talent-detail-card")).toHaveCount(0);
    await expect(pil).not.toHaveAttribute("data-selected", "true");
    await expect(pil).toBeFocused();
    await expect(pil.getByTestId("rank-badge")).toHaveText("1/5");
    // Escape does the same.
    await pil.click();
    await expect(panel.getByTestId("talent-detail-card")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel.getByTestId("talent-detail-card")).toHaveCount(0);
  });

  test("the detail panel never swallows a click on a talent next to it", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    await talent(page, "discipline", "Power in Light").click();
    const wand = talent(page, "discipline", "Wand Specialization");
    await wand.click();
    await expect(page.getByTestId("talent-detail")).toContainText("Wand Specialization");
    await expect(wand.getByTestId("rank-badge")).toHaveText("1/2");
  });

  test("keyboard and right-click removal still work with the compact node", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const pil = talent(page, "discipline", "Power in Light");
    await pil.click();
    await pil.click();
    await expect(pil.getByTestId("rank-badge")).toHaveText("2/5");
    await pil.click({ button: "right" });
    await expect(pil.getByTestId("rank-badge")).toHaveText("1/5");
    await pil.click({ modifiers: ["Shift"] });
    await expect(pil.getByTestId("rank-badge")).toHaveText("0/5");
  });

  test("the header keeps the points and Share/Reset prominent; the instructions live in a Help disclosure", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    for (const id of ["points-spent", "points-remaining", "required-level", "share-build", "reset-build"]) await expect(page.getByTestId(id)).toBeVisible();
    // The long keyboard/mouse instructions are not on the page until the disclosure is opened; one concise hint is.
    await expect(page.getByText("Shift+click")).toBeHidden();
    await expect(page.getByTestId("talent-hint")).toContainText("Click to add a point, right-click to remove.");
    const help = page.getByTestId("talent-help");
    await help.getByText("How to use").click();
    await expect(help.getByText("Shift+click")).toBeVisible();
    await expect(help.getByText("arrow keys")).toBeVisible();
    await expect(help).toHaveAttribute("open", "");
    await help.getByText("How to use").click();
    await expect(page.getByText("Shift+click")).toBeHidden();
    // The legend is light: small swatches, small type.
    const sw = (await page.getByRole("list", { name: "Talent states" }).locator("span").first().boundingBox())!;
    expect(sw.width).toBeLessThanOrEqual(14);
  });

  test("the tooltip has a fixed width, a muted Spell ID, and stays inside the viewport at every corner of the tree", async ({ page }) => {
    for (const vp of [{ width: 1280, height: 800 }, { width: 1024, height: 700 }]) {
      await page.setViewportSize(vp);
      await page.goto("/guides/classes/priest");
      const last = page.getByTestId("tree-shadow-magic");
      await last.scrollIntoViewIfNeeded();
      const buttons = last.getByRole("button");
      const n = await buttons.count();
      for (const i of [0, 3, n - 4, n - 1]) {
        const b = buttons.nth(i);
        await b.scrollIntoViewIfNeeded();
        await b.hover();
        const tip = page.getByTestId("talent-tooltip");
        await expect(tip).toBeVisible();
        const r = (await tip.boundingBox())!;
        expect(r.x, `left edge (${vp.width}, node ${i})`).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width, `right edge (${vp.width}, node ${i})`).toBeLessThanOrEqual(vp.width);
        expect(r.y, `top edge`).toBeGreaterThanOrEqual(0);
        expect(r.y + r.height, `bottom edge`).toBeLessThanOrEqual(vp.height);
        expect(Math.round(r.width)).toBe(288);
        await page.mouse.move(0, 0);
        await expect(tip).toHaveCount(0);
      }
    }
  });

  test("tooltip: next rank is secondary, the unresolved '?' is explicit, the Spell ID is quiet but present", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const pil = talent(page, "discipline", "Power in Light");
    await pil.click();
    await pil.hover();
    const tip = page.getByTestId("talent-tooltip");
    const label = tip.getByText("Next rank:");
    await expect(label).toBeVisible();
    const cur = await tip.getByTestId("talent-description").locator("p").first().evaluate((el) => getComputedStyle(el).color);
    const next = await label.locator("xpath=..").evaluate((el) => getComputedStyle(el).color);
    expect(next).not.toBe(cur);
    await expect(tip.getByText(/^Spell ID \d+$/)).toBeVisible();
    const id = await tip.getByText(/^Spell ID \d+$/).evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(id).toBeLessThanOrEqual(11);
    await page.mouse.move(0, 0);
    await talent(page, "discipline", "Penance").hover();
    await expect(page.getByTestId("talent-tooltip").locator('[data-gap]').first()).toHaveAccessibleName(/value not available/);
  });
});

test.describe("Talent calculator V2.1: bottom sheet (touch / mobile)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "touch layout");
  });

  test("the sheet starts collapsed and compact, expands to the full details, and closes", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const pil = talent(page, "discipline", "Power in Light");
    await pil.scrollIntoViewIfNeeded();
    await pil.tap();
    const panel = page.getByTestId("talent-detail");
    const card = panel.getByTestId("talent-detail-card");
    await expect(card).toHaveAttribute("data-sheet", "collapsed");
    const vp = page.viewportSize()!;
    const collapsed = (await card.boundingBox())!;
    expect(collapsed.height).toBeLessThan(vp.height * 0.3); // leaves most of the tree usable
    expect(collapsed.y + collapsed.height).toBeLessThanOrEqual(vp.height);
    await expect(card.getByTestId("talent-detail-body")).toBeHidden();
    // ≥44px controls, all inside the viewport width.
    for (const b of [card.getByRole("button", { name: /Add a point/ }), card.getByRole("button", { name: /Remove a point/ }), card.getByTestId("panel-toggle"), card.getByTestId("panel-close")]) {
      const r = (await b.boundingBox())!;
      expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(44);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(vp.width);
    }
    const toggle = card.getByTestId("panel-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.tap();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(card).toHaveAttribute("data-sheet", "expanded");
    await expect(card.getByTestId("talent-detail-body")).toBeVisible();
    await expect(card.getByTestId("talent-description")).toBeVisible();
    const expanded = (await card.boundingBox())!;
    expect(expanded.height).toBeGreaterThan(collapsed.height);
    expect(expanded.height).toBeLessThanOrEqual(vp.height * 0.62 + 1);
    expect(expanded.y + expanded.height).toBeLessThanOrEqual(vp.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    // Add from the sheet; close it.
    await expect(spent(page)).toHaveText("1/51"); // the tap that selected it also added a point
    await card.getByRole("button", { name: /Add a point/ }).tap();
    await expect(spent(page)).toHaveText("2/51");
    await card.getByTestId("panel-close").tap();
    await expect(panel.getByTestId("talent-detail-card")).toHaveCount(0);
    await expect(spent(page)).toHaveText("2/51");
  });

  test("the header wraps cleanly and the Help disclosure opens inside the screen", async ({ page }) => {
    await page.goto("/guides/classes/priest");
    const vp = page.viewportSize()!;
    for (const id of ["points-spent", "points-remaining", "required-level", "share-build", "reset-build"]) {
      const r = (await page.getByTestId(id).boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(vp.width);
    }
    await expect(page.getByTestId("talent-hint")).toContainText("Tap a talent to add a point.");
    const help = page.getByTestId("talent-help");
    await help.getByText("How to use").tap();
    const body = help.locator("div").first();
    await expect(body).toBeVisible();
    const r = (await body.boundingBox())!;
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width).toBeLessThanOrEqual(vp.width);
  });
});
