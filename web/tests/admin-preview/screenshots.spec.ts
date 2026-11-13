import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { actAs, go, open } from "./helpers";

/** Review screenshots of the primary Admin views. Only runs on request: SCREENSHOTS_DIR=<dir> npm run test:admin-preview -- screenshots */
const DIR = process.env.SCREENSHOTS_DIR;
test.skip(!DIR, "set SCREENSHOTS_DIR to capture review screenshots");

test("capture primary views", async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(DIR!, { recursive: true });
  const shot = async (name: string, full = true): Promise<void> => {
    if (!name.startsWith("09-")) for (const b of await page.getByRole("button", { name: "Dismiss notification" }).all()) await b.click();
    await page.waitForTimeout(250);
    // Make the viewport as tall as the page so the sticky environment banner stays at the top of the capture.
    const vp = page.viewportSize()!;
    if (full) { const h = await page.evaluate(() => document.documentElement.scrollHeight); await page.setViewportSize({ width: vp.width, height: Math.min(h, 2600) }); await page.waitForTimeout(150); }
    await page.screenshot({ path: `${DIR}/${name}.jpg`, type: "jpeg", quality: 82 });
    await page.setViewportSize(vp);
  };
  await page.setViewportSize({ width: 1366, height: 900 });
  await open(page);
  await shot("01-sign-in", false);
  await page.getByRole("button", { name: /Selene Ashvale/ }).click();
  await shot("02-totp-step", false);
  await actAs(page, "selene");
  await shot("03-dashboard");
  await go(page, "Articles / News");
  await shot("04-articles-list");
  await page.getByRole("link", { name: "Realm population census: week 46" }).click();
  await shot("05-article-detail-overview");
  await page.getByRole("tab", { name: "Working vs published" }).click();
  await shot("06-working-vs-published-diff");
  await page.getByRole("tab", { name: /Revisions/ }).click();
  await shot("07-revision-history");
  await go(page, "Articles / News");
  await page.getByTestId("new-draft").click();
  await page.getByLabel("Slug (permanent)").fill("screenshot-draft");
  await page.getByLabel("Title", { exact: true }).fill("Preview of the Markdown editor");
  await page.getByRole("textbox", { name: "Markdown" }).fill("## Editor\n\nLive **Markdown** preview with a list:\n\n- immutable revisions\n- independent approval");
  await shot("08-article-editor");
  await actAs(page, "isolde");
  await page.goto("/admin-preview/articles/art-2");
  await actAs(page, "isolde");
  await page.getByTestId("act-approve").click();
  await shot("09-self-approval-rejected");
  await actAs(page, "selene");
  await go(page, "Editorial Review Queue");
  await shot("10-review-queue");
  await go(page, "Staff & Roles");
  await shot("11-staff-list");
  await page.goto("/admin-preview/staff/st-tomas");
  await shot("12-staff-detail-grants");
  await page.getByRole("button", { name: "Create grant…" }).click();
  await page.getByLabel("Duration (days)").fill("120");
  await shot("13-grant-duration-limit", false);
  await page.keyboard.press("Escape");
  await go(page, "Staff & Roles");
  await page.getByRole("tab", { name: "Roles & permissions" }).click();
  await shot("14-roles-permission-matrix");
  await go(page, "Audit Log");
  await shot("15-audit-log");
  await go(page, "Settings");
  await shot("16-settings-capability-map");
  await page.getByRole("button", { name: "Preview controls" }).click();
  await page.getByRole("button", { name: "+16 min" }).click();
  await page.keyboard.press("Escape");
  await go(page, "Dashboard");
  await shot("17-mfa-freshness-expired", false);
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.goto("/admin-preview");
  await shot("18-tablet-dashboard", false);
});
