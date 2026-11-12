import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { actAs, go, open } from "./helpers";

const VIEWS: [string, string][] = [
  ["dashboard", "/admin-preview"], ["articles", "/admin-preview/articles"], ["article detail", "/admin-preview/articles/art-1"], ["article editor", "/admin-preview/articles/new"],
  ["review queue", "/admin-preview/review"], ["staff", "/admin-preview/staff"], ["staff detail", "/admin-preview/staff/st-tomas"], ["audit log", "/admin-preview/audit"], ["settings", "/admin-preview/settings"],
];

async function noHorizontalOverflow(page: Page): Promise<void> {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(o.sw, `document scrollWidth ${o.sw} should not exceed viewport ${o.cw}`).toBeLessThanOrEqual(o.cw + 1);
}

test.describe("12. Responsive layout", () => {
  for (const vp of [{ name: "desktop", width: 1366, height: 900 }, { name: "tablet landscape", width: 1024, height: 768 }, { name: "tablet portrait", width: 820, height: 1180 }]) {
    test(`no page-level horizontal scroll on every view at ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await open(page);
      await actAs(page, "selene");
      for (const [, path] of VIEWS) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await noHorizontalOverflow(page);
      }
    });
  }

  test("sidebar is persistent on desktop and collapses to a menu button on tablet", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await open(page);
    await actAs(page, "selene");
    const nav = page.getByRole("navigation", { name: "Admin" });
    await expect(nav).toBeVisible();
    await expect(page.getByRole("button", { name: /Menu/ })).toBeHidden();
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(nav).toBeHidden();
    const menu = page.getByRole("button", { name: /Menu/ });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: /^Audit Log/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Audit Log" })).toBeVisible();
    await expect(nav).toBeHidden();
    // the environment indicator stays visible at every width
    await expect(page.getByText("DEMO / ISOLATED PREVIEW — NO PRODUCTION ACCESS")).toBeVisible();
  });
});

test.describe("Accessibility", () => {
  for (const [name, path] of VIEWS) {
    test(`axe WCAG 2.2 AA: ${name}`, async ({ page }) => {
      await open(page);
      await actAs(page, "selene");
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const r = await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.help} — ${v.nodes[0]?.target}`)).toEqual([]);
    });
  }

  test("axe: sign-in gate, TOTP step and a modal dialog", async ({ page }) => {
    await open(page);
    const scan = async (): Promise<string[]> => (await new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze()).violations.map((v) => `${v.id}: ${v.help}`);
    expect(await scan()).toEqual([]);
    await page.getByRole("button", { name: /Mira Fennick/ }).click();
    expect(await scan()).toEqual([]);
    await actAs(page, "selene");
    await page.goto("/admin-preview/staff/st-mira");
    await page.getByTestId("create-grant").click();
    await expect(page.getByTestId("dlg-grant")).toBeVisible();
    expect(await scan()).toEqual([]);
  });

  test("keyboard: skip link, focus moves to the page heading on navigation, Escape closes dialogs and returns focus", async ({ page }) => {
    await open(page);
    await actAs(page, "selene");
    await page.goto("/admin-preview");
    await page.getByRole("heading", { level: 1, name: "Dashboard" }).waitFor();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to Admin content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#preview-main/);
    await go(page, "Audit Log");
    await expect(page.getByRole("heading", { level: 1, name: "Audit Log" })).toBeFocused();
    const trigger = page.getByRole("button", { name: "Preview controls" });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "Preview controls" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("tabs support arrow-key navigation", async ({ page }) => {
    await open(page);
    await actAs(page, "selene");
    await page.goto("/admin-preview/staff");
    const first = page.getByRole("tab", { name: /^Staff/ });
    await first.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: /^Requests/ })).toBeFocused();
    await expect(page.getByRole("tab", { name: /^Requests/ })).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("Consistent loading, empty, disabled and feedback states", () => {
  test("empty search results and disabled actions explain themselves", async ({ page }) => {
    await open(page);
    await actAs(page, "garrick");
    await go(page, "Articles / News");
    await page.getByRole("searchbox").fill("zzzz-no-such-article");
    await expect(page.getByText("No articles match")).toBeVisible();
    await expect(page.getByTestId("article-count")).toContainText("0 of");
    await expect(page.getByText(/New draft needs news.draft.write/)).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByTestId("article-count")).not.toContainText("0 of");
  });

  test("distinct success, warning and error feedback", async ({ page }) => {
    await open(page);
    await actAs(page, "mira");
    await go(page, "Articles / News");
    await page.getByTestId("new-draft").click();
    await page.getByTestId("save-draft").click();
    await expect(page.getByTestId("toast-warning")).toBeVisible();
    await page.getByLabel("Slug (permanent)").fill("feedback-tones");
    await page.getByLabel("Title", { exact: true }).fill("Feedback tone demonstration");
    await page.getByTestId("save-draft").click();
    await expect(page.getByTestId("toast-success").filter({ hasText: "Draft created" })).toBeVisible();
    await actAs(page, "garrick");
    await page.getByTestId("edit-article").click();
    await page.getByLabel("Title", { exact: true }).fill("Moderator cannot edit this");
    await page.getByTestId("save-draft").click();
    await expect(page.getByTestId("toast-error")).toBeVisible();
  });
});
