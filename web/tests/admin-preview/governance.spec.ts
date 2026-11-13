import { expect, test } from "@playwright/test";
import { actAs, createDraft, go, open, toast } from "./helpers";

test.describe("8. Staff role modification", () => {
  test("an Owner assigns the Moderator role, the change is visible and audited as a preview-only event", async ({ page }) => {
    await open(page);
    await actAs(page, "selene");
    await go(page, "Staff & Roles");
    await page.getByTestId("staff-row-st-pip").getByRole("link", { name: "View" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Pip Larkwood" })).toBeVisible();
    await page.getByTestId("assign-role").click();
    const dlg = page.getByTestId("dlg-assign");
    await dlg.getByLabel("Role").selectOption("moderator");
    await dlg.getByRole("button", { name: /Assign/ }).click();
    await expect(dlg.getByText("Give a reason or ticket reference.")).toBeVisible();
    await dlg.getByLabel("Reason or ticket").fill("Community moderator onboarding, ticket MOD-12");
    await dlg.getByTestId("dlg-assign-submit").click();
    await expect(toast(page, "success")).toContainText("Pip Larkwood is now Moderator");
    await expect(page.getByRole("main").getByText("Moderator").first()).toBeVisible();
    await go(page, "Audit Log");
    await expect(page.getByTestId("audit-table")).toContainText("staff.role.assign");
    await expect(page.getByTestId("audit-table")).toContainText("Preview-only");
  });

  test("grant duration limits, escalation denials and suspension take effect with clear messages", async ({ page }) => {
    await open(page);
    await actAs(page, "selene");
    await page.goto("/admin-preview/staff/st-mira");
    await page.getByTestId("create-grant").click();
    const dlg = page.getByTestId("dlg-grant");
    await expect(dlg.getByLabel("Duration (days)")).toHaveValue("30");
    await dlg.getByLabel("Duration (days)").fill("120");
    await expect(dlg.getByText("Limit: 90 days maximum")).toBeVisible();
    await dlg.getByLabel("Reason or ticket").fill("Delegated publishing, ticket ED-77");
    await dlg.getByTestId("dlg-grant-submit").click();
    await expect(dlg.getByRole("alert").filter({ hasText: "Denied" })).toContainText("Grant duration limit: 90 days maximum");
    await dlg.getByLabel("Duration (days)").fill("30");
    await dlg.getByTestId("dlg-grant-submit").click();
    await expect(toast(page, "success")).toContainText("Grant created for Mira Fennick");
    await expect(page.getByTestId("grants-table")).toContainText("news.article.publish");
    await expect(page.getByTestId("grants-table")).toContainText("30 d");

    // set expiration, with the 90 day ceiling
    await page.getByTestId("grants-table").getByRole("button", { name: "Set expiry…" }).first().click();
    const exp = page.getByTestId("dlg-expiry");
    await exp.getByLabel(/Total duration/).fill("91");
    await exp.getByTestId("dlg-expiry-submit").click();
    await expect(exp.getByRole("alert").filter({ hasText: "Denied" })).toContainText("90 days maximum");
    await exp.getByLabel(/Total duration/).fill("60");
    await exp.getByTestId("dlg-expiry-submit").click();
    await expect(page.getByTestId("grants-table")).toContainText("60 d");

    // Owner can never be assigned here
    await page.goto("/admin-preview/staff/st-mira");
    await page.getByTestId("assign-role").click();
    const a = page.getByTestId("dlg-assign");
    await a.getByLabel("Role").selectOption("owner");
    await a.getByLabel("Reason or ticket").fill("promote to owner please");
    await a.getByTestId("dlg-assign-submit").click();
    await expect(a.getByRole("alert").filter({ hasText: "Denied" })).toContainText("Owner cannot be assigned here");
    await a.getByRole("button", { name: "Cancel" }).click();

    // suspension takes effect on the next decision
    await page.getByTestId("suspend").click();
    await page.getByTestId("dlg-suspend").getByLabel("Reason (audited)").fill("Access review (test)");
    await page.getByTestId("dlg-suspend-submit").click();
    await expect(page.getByRole("main").getByText("Suspended").first()).toBeVisible();
    await actAs(page, "mira");
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "suspended" }).first()).toBeVisible();
  });

  test("an Administrator's elevated proposal needs an independent approver (the proposer cannot decide it)", async ({ page }) => {
    await open(page);
    await actAs(page, "selene");
    await page.goto("/admin-preview/staff/st-mira");
    await page.getByTestId("assign-role").click();
    const a = page.getByTestId("dlg-assign");
    await a.getByLabel("Role").selectOption("administrator");
    await a.getByLabel("Reason or ticket").fill("Promote Mira to Administrator");
    await a.getByTestId("dlg-assign-submit").click();
    await expect(toast(page, "success")).toContainText("pending an independent approver");
    await go(page, "Editorial Review Queue");
    const mine = page.locator("li", { hasText: "Promote Mira to Administrator" });
    await expect(mine).toContainText("Blocked for you");
    await mine.getByRole("button", { name: "Approve" }).click();
    await expect(toast(page, "error")).toContainText("cannot decide it");
    await actAs(page, "aldric");
    await expect(mine).toContainText("You can act");
    await mine.getByRole("button", { name: "Approve" }).click();
    await expect(toast(page, "success").last()).toContainText("approved and applied");
  });

  test("role & permission matrix and Owner ceremonies are simulation-only", async ({ page }) => {
    await open(page);
    await actAs(page, "selene");
    await go(page, "Staff & Roles");
    await page.getByRole("tab", { name: "Roles & permissions" }).click();
    const matrix = page.getByTestId("roles-matrix");
    for (const r of ["User", "Moderator", "Editor", "Administrator", "Owner"]) await expect(matrix.getByRole("columnheader", { name: r })).toBeVisible();
    await expect(matrix).toContainText("news.article.approve_highlighted");
    await page.getByRole("tab", { name: "Owner ceremonies" }).click();
    await expect(page.getByText("Simulation only").first()).toBeVisible();
    await page.getByTestId("owner-bootstrap").click();
    await expect(toast(page, "error")).toContainText("already consumed");
    await page.getByTestId("owner-recovery").click();
    await expect(toast(page, "success")).toContainText("Nothing was changed");
  });
});

test.describe("9. Permission denial", () => {
  test("an Editor without a grant cannot publish; the reason is explained and the denial is audited", async ({ page }) => {
    await open(page);
    await actAs(page, "mira");
    await page.goto("/admin-preview/articles");
    await page.getByRole("link", { name: "Blue post digest: week 46" }).click();
    await page.getByTestId("act-publish").click();
    await page.getByRole("button", { name: "Queue publication" }).click();
    await expect(toast(page, "error")).toContainText("delegated only through an explicit, scoped, expiring grant");
    await expect(toast(page, "error")).toContainText("expired");
    await page.getByRole("tab", { name: /Audit/ }).click();
    // Mira holds no audit grant, so the tab explains rather than leaking
    await expect(page.getByText("audit.editorial.read").first()).toBeVisible();
    await actAs(page, "selene");
    await go(page, "Audit Log");
    await page.getByRole("combobox", { name: "Result" }).selectOption("denied");
    await expect(page.getByTestId("audit-table")).toContainText("article.publish");
    await expect(page.getByTestId("audit-table")).toContainText("news.article.publish");
  });

  test("a Moderator has no News authority and cannot create drafts; a plain User cannot enter", async ({ page }) => {
    await open(page);
    await actAs(page, "garrick");
    await go(page, "Articles / News");
    await expect(page.getByTestId("new-draft")).toBeDisabled();
    await expect(page.getByText("holds no editorial permission")).toBeVisible();
    await actAs(page, "pip");
    await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "no staff role" }).first()).toBeVisible();
  });

  test("an Editor cannot change staff", async ({ page }) => {
    await open(page);
    await actAs(page, "mira");
    await page.goto("/admin-preview/staff/st-garrick");
    await page.getByTestId("assign-role").click();
    const a = page.getByTestId("dlg-assign");
    await a.getByLabel("Role").selectOption("editor");
    await a.getByLabel("Reason or ticket").fill("make garrick an editor");
    await a.getByTestId("dlg-assign-submit").click();
    await expect(a.getByRole("alert").filter({ hasText: "Denied" })).toContainText("does not hold staff.role.propose");
  });
});

test.describe("10. Audit event visibility", () => {
  test("simulated privileged operations produce preview-only events that can be filtered by user, action, result and date", async ({ page }) => {
    await open(page);
    await actAs(page, "selene");
    await page.getByRole("combobox", { name: /Act as/ }).selectOption("st-selene");
    await createDraft(page, "audit-trail-draft");
    await page.getByTestId("act-submit").click();
    await go(page, "Audit Log");
    const table = page.getByTestId("audit-table");
    await expect(table).toContainText("article.create");
    await expect(table).toContainText("audit-trail-draft");
    await expect(table.getByRole("columnheader")).toContainText(["Timestamp", "Actor", "Action", "Target", "Result", "Permission", "Correlation", "Origin"]);
    await expect(table.getByText("Preview-only").first()).toBeVisible();
    await expect(table.getByText(/PV-\d+/).first()).toBeVisible();
    await expect(page.getByText("Events created by what you do in this preview are labelled")).toBeVisible();

    const rows = page.getByTestId("audit-row");
    const total = await rows.count();
    await page.getByRole("combobox", { name: "Action" }).selectOption("article.create");
    expect(await rows.count()).toBeLessThan(total);
    await page.getByRole("combobox", { name: "Action" }).selectOption("all");
    await page.getByRole("combobox", { name: "User" }).selectOption({ label: "Isolde Marrow" });
    await expect(rows.first()).toContainText("Isolde Marrow");
    await page.getByRole("button", { name: "Clear" }).click();
    await page.getByRole("combobox", { name: "Result" }).selectOption("denied");
    for (const r of await rows.all()) await expect(r).toHaveAttribute("data-result", "denied");
    await page.getByRole("button", { name: "Clear" }).click();
    await page.getByLabel("From").fill("2026-11-12");
    for (const r of await rows.all()) await expect(r).not.toContainText("2026-11-09");
    await page.getByLabel("From").fill("2030-01-01");
    await expect(page.getByText("No events match")).toBeVisible();
  });

  test("audit visibility is permissioned", async ({ page }) => {
    await open(page);
    await actAs(page, "mira");
    await go(page, "Audit Log");
    await expect(page.getByText("No audit access")).toBeVisible();
    await actAs(page, "tomas"); // holds a scoped audit.editorial.read grant
    await expect(page.getByTestId("audit-table")).toBeVisible();
    await expect(page.getByText(/hidden by your permissions/)).toBeVisible();
  });
});

test.describe("11. Session expiration", () => {
  test("TOTP freshness expires after 15 minutes: critical actions need a step-up, others keep working", async ({ page }) => {
    await open(page);
    await actAs(page, "selene");
    await page.getByRole("button", { name: "Preview controls" }).click();
    await page.getByRole("button", { name: "+16 min" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("session-chip")).toContainText("MFA freshness expired");
    await expect(page.getByTestId("stale-banner")).toBeVisible();

    await page.goto("/admin-preview/articles");
    await page.getByRole("link", { name: "Blue post digest: week 46" }).click();
    await page.getByTestId("act-publish").click();
    await page.getByRole("button", { name: "Queue publication" }).click();
    const step = page.getByRole("dialog", { name: /Verify again to continue/ });
    await expect(step).toBeVisible();
    await step.getByLabel(/6-digit TOTP/).fill("999999");
    await step.getByRole("button", { name: "Verify and continue" }).click();
    await expect(step.getByRole("alert")).toContainText("Incorrect code");
    await step.getByLabel(/6-digit TOTP/).fill("123456");
    await step.getByRole("button", { name: "Verify and continue" }).click();
    // the original action is retried automatically after the step-up
    await expect(page.getByText("Publish pending").first()).toBeVisible();
    await expect(page.getByTestId("session-chip")).toContainText("MFA verified");
  });

  test("a revoked session is denied at the next decision and every state can be inspected", async ({ page }) => {
    await open(page);
    await actAs(page, "mira");
    await page.getByRole("button", { name: "Preview controls" }).click();
    await page.getByRole("button", { name: "Simulate session revocation" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Session revoked" })).toBeVisible();
    await page.getByRole("button", { name: "Sign in again" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to the Admin preview" })).toBeVisible();

    await page.goto("/admin-preview/settings");
    const states: [string, RegExp][] = [["signed_out", /Signed out/], ["mfa_required", /MFA required/], ["mfa_verified", /MFA verified/], ["mfa_stale", /MFA freshness expired/], ["revoked", /Session revoked/], ["access_denied", /Access denied/]];
    for (const [id, label] of states) {
      await page.getByTestId(`state-${id}`).click();
      await expect(page.getByTestId("session-chip")).toContainText(label);
    }
  });

  test("three wrong codes lock the simulated sign-in", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: /Brenna Holt/ }).click();
    for (let i = 0; i < 3; i++) {
      await page.getByLabel("6-digit code").fill("111111");
      await page.getByRole("button", { name: "Verify" }).click();
    }
    await page.getByLabel("6-digit code").fill("123456");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "simulated lockout" })).toBeVisible();
  });
});

test("state survives a reload within the tab and can be reset", async ({ page }) => {
  await open(page);
  await actAs(page, "mira");
  await createDraft(page, "survives-reload");
  await page.reload();
  await expect(page.getByTestId("session-chip")).toContainText("MFA verified");
  await go(page, "Articles / News");
  await expect(page.getByTestId("article-row-survives-reload")).toBeVisible();
  await page.goto("/admin-preview/settings");
  await page.getByTestId("reset-data").click();
  await page.goto("/admin-preview/articles");
  await expect(page.getByRole("heading", { name: "Sign in to the Admin preview" })).toBeVisible();
});
