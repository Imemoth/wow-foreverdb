import AxeBuilder from "@axe-core/playwright";
import { expect, test, createDraft, makeStaff, newStaffPage, newUser, newCtx } from "./fixtures";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

test.describe("accessibility and responsive layout of the real Admin", () => {
  test("axe WCAG 2.2 AA on every screen, the editor, an article and an open dialog", async ({ browser }) => {
    const ed = await newUser("a11y-ed"), owner = await newUser("a11y-own");
    await makeStaff(ed, "Editor"); await makeStaff(owner, "Owner");
    const pe = await newStaffPage(await newCtx(browser), ed);
    const po = await newStaffPage(await newCtx(browser), owner);
    const a = await createDraft(pe);
    const scan = async (page: import("@playwright/test").Page, label: string): Promise<void> => {
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const r = await new AxeBuilder({ page: page as never }).withTags(TAGS).analyze();
      expect(r.violations.map((v) => `${label} ${v.id}: ${v.nodes.length} node(s) — ${v.help} — ${v.nodes[0]?.target}`)).toEqual([]);
    };
    for (const [label, path] of [["dashboard", "/admin"], ["articles", "/admin/articles"], ["new", "/admin/articles/new"], ["review", "/admin/review"], ["staff", "/admin/staff"], ["settings", "/admin/settings"], ["article", a.url], ["edit", `${a.url}/edit`]] as const) {
      await pe.goto(path);
      await scan(pe, `editor ${label}`);
    }
    await po.goto("/admin/audit");
    await scan(po, "owner audit");
    await pe.goto(a.url);
    await pe.getByTestId("act-submit").click();
    await expect(pe.getByRole("dialog")).toBeVisible();
    const r = await new AxeBuilder({ page: pe as never }).withTags(TAGS).analyze();
    expect(r.violations.map((v) => `dialog ${v.id}: ${v.help}`)).toEqual([]);
    // Escape closes the dialog without acting, and the article is unchanged
    await pe.keyboard.press("Escape");
    await expect(pe.getByRole("dialog")).toBeHidden();
    await expect(pe.getByTestId("article-status")).toHaveText("Draft");
  });

  test("mobile width: no horizontal page scroll, menu toggles, environment banner stays visible", async ({ browser }) => {
    const ed = await newUser("mobile-ed");
    await makeStaff(ed, "Editor");
    const ctx = await newCtx(browser);
    const page = await newStaffPage(ctx, ed);
    await createDraft(page);
    await page.setViewportSize({ width: 375, height: 800 });
    for (const path of ["/admin", "/admin/articles", "/admin/articles/new", "/admin/review", "/admin/staff", "/admin/settings"]) {
      await page.goto(path);
      await expect(page.getByText("ISOLATED DISPOSABLE ADMIN — LOCAL BACKEND — NOT PRODUCTION")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
    }
    await page.goto("/admin");
    const menu = page.getByRole("button", { name: /Menu/ });
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: /^Audit Log/ }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Audit Log" })).toBeVisible();
  });

  test("the Admin shell does not carry the public site chrome and is not indexable or cacheable", async ({ page, browser }) => {
    const ed = await newUser("chrome-ed");
    await makeStaff(ed, "Editor");
    const p = await newStaffPage(await newCtx(browser), ed);
    await p.goto("/admin");
    await expect(p.locator("header a[href='/database']")).toHaveCount(0); // no public header navigation
    const res = await p.request.get("/admin");
    expect(res.headers()["cache-control"]).toMatch(/no-store/);
    expect(res.headers()["x-robots-tag"] ?? "").toMatch(/noindex/);
    void page;
  });
});
