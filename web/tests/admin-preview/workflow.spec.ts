import { expect, test } from "@playwright/test";
import { GOOD, actAs, createDraft, fillEditor, go, open, toast } from "./helpers";

test.describe("1. Dashboard navigation", () => {
  test("signed-out gate, sign-in with simulated TOTP, then clickable summary cards navigate", async ({ page }) => {
    await open(page);
    await expect(page.getByRole("heading", { name: "Sign in to the Admin preview" })).toBeVisible();
    await page.getByRole("button", { name: /Mira Fennick/ }).click();
    await expect(page.getByRole("heading", { name: /Verify TOTP/ })).toBeVisible();
    await page.getByLabel("6-digit code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Incorrect code" })).toBeVisible();
    await page.getByLabel("6-digit code").fill("123456");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Dashboard" })).toBeVisible();
    await expect(page.getByTestId("session-chip")).toContainText("MFA verified");

    await page.getByTestId("card-drafts").click();
    await expect(page).toHaveURL(/\/admin-preview\/articles\?status=draft/);
    await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("draft");
    await go(page, "Dashboard");
    await page.getByTestId("card-awaiting").click();
    await expect(page.getByRole("heading", { level: 1, name: "Editorial Review Queue" })).toBeVisible();
    for (const name of ["Staff & Roles", "Audit Log", "Settings", "Dashboard"]) {
      await go(page, name);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
      await expect(page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: new RegExp(`^${name}`) })).toHaveAttribute("aria-current", "page");
    }
  });

  test("clearly separates implemented, simulated and future capabilities", async ({ page }) => {
    await open(page, "/admin-preview/settings");
    const map = page.getByTestId("capability-map");
    await expect(map).toContainText("Backend inactive");
    await expect(map).toContainText("Simulated");
    await expect(map).toContainText("Future");
    await expect(map).toContainText("PR #201");
    await expect(map).toContainText("PR #202");
  });
});

test.describe("2-4. Draft lifecycle", () => {
  test("creates a draft with validation feedback, then edits it into a new immutable revision, then requests review", async ({ page }) => {
    await open(page);
    await actAs(page, "mira");
    await go(page, "Articles / News");
    await page.getByTestId("new-draft").click();

    // form validation: empty form, then a reserved slug and a short title
    await page.getByTestId("save-draft").click();
    await expect(page.getByText("Slug: lowercase letters")).toBeVisible();
    await expect(page.getByText("A draft needs at least a short title.")).toBeVisible();
    await page.getByLabel("Slug (permanent)").fill("entry");
    await expect(page.getByText('"entry" is a reserved route segment.')).toBeVisible();
    await page.getByLabel("Slug (permanent)").fill("realm-population-census");
    await expect(page.getByText("already reserved by another article")).toBeVisible();

    // 2. create
    await fillEditor(page, { slug: "my-first-preview-draft", tags: "census, Realms" });
    await expect(page.getByTestId("md-preview").getByRole("heading", { name: "Heading" })).toBeVisible();
    await page.getByTestId("save-draft").click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(GOOD.title);
    await expect(toast(page, "success")).toContainText("Draft created");
    await expect(page.getByText("Head r1: draft")).toBeVisible();

    // 3. edit => new immutable revision r2
    await page.getByTestId("edit-article").click();
    await expect(page.getByLabel("Slug (permanent)")).toBeDisabled();
    await page.getByLabel("Title", { exact: true }).fill("A perfectly valid preview title, revised");
    await page.getByTestId("save-draft").click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("revised");
    await expect(page.getByText("Head r2: draft")).toBeVisible();
    await page.getByRole("tab", { name: /Revisions/ }).click();
    const rows = page.getByTestId("revisions-table").locator("tbody tr");
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText("r2");
    await expect(rows.last()).toContainText("r1");
    await expect(rows.last()).toContainText("superseded");
    await page.getByRole("button", { name: "View" }).last().click();
    await expect(page.getByRole("dialog")).toContainText("A perfectly valid preview title");
    await expect(page.getByRole("dialog")).not.toContainText("revised");
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Working vs published" }).click();
    await expect(page.getByTestId("diff-view")).toContainText("Title");

    // saving identical content creates nothing
    await page.getByTestId("edit-article").click();
    await page.getByTestId("save-draft").click();
    await expect(toast(page, "info")).toContainText("No changes");

    // 4. review request
    await page.getByRole("link", { name: "Cancel" }).click();
    await page.getByTestId("act-submit").click();
    await expect(toast(page, "success")).toContainText("submitted for review");
    await expect(page.getByText("Head r2: in review")).toBeVisible();
    await go(page, "Editorial Review Queue");
    await expect(page.getByTestId("queue-in-review")).toContainText("my-first-preview-draft");
  });

  test("an incomplete draft cannot be submitted and the failing rule is explained", async ({ page }) => {
    await open(page);
    await actAs(page, "mira");
    await createDraft(page, "too-short-body", { body: "Short." });
    await page.getByTestId("act-submit").click();
    await expect(toast(page, "warning")).toContainText("Validation failed");
    await expect(page.getByText("Head r1: draft")).toBeVisible();
  });
});

test.describe("5-7. Independent approval and simulated publication of highlighted content", () => {
  test("self-approval is rejected even for an Owner, an independent Administrator approves, the Owner publishes (simulated)", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
    await open(page);
    await actAs(page, "selene");
    await createDraft(page, "winter-veil-owner-feature", { title: "Owner-authored highlighted announcement", featured: true });
    await expect(page.getByText("High-impact").first()).toBeVisible();
    await page.getByTestId("act-submit").click();
    await expect(page.getByText("Head r1: in review")).toBeVisible();

    // 5. unauthorized self-approval — explained before the click, rejected on the click, audited
    await expect(page.getByTestId("eligibility")).toContainText("Self-approval rejected");
    await page.getByTestId("act-approve").click();
    await expect(toast(page, "error")).toContainText("Self-approval rejected");
    await expect(toast(page, "error")).toContainText("authored r1");
    await expect(page.getByText("Head r1: in review")).toBeVisible();
    // an Owner also cannot publish unapproved highlighted content
    await page.getByRole("tab", { name: "Approval & independence" }).click();
    await expect(page.getByText("No independent approvals recorded.")).toBeVisible();

    // 6. a valid, independent approval
    await actAs(page, "aldric");
    await page.getByTestId("act-approve").click();
    await expect(toast(page, "success")).toContainText("approved (independent, revision-bound)");
    await expect(page.getByText("Head r1: approved")).toBeVisible();
    await page.getByRole("tab", { name: "Approval & independence" }).click();
    await expect(page.getByText("Unused")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Approval & independence" })).toBeVisible();

    // 7. simulated publication: queued first, public only after the simulated receipt
    await actAs(page, "selene");
    await page.getByTestId("act-publish").click();
    await expect(page.getByRole("dialog")).toContainText("simulation");
    await page.getByRole("button", { name: "Queue publication" }).click();
    await expect(toast(page, "success")).toContainText("Publication of r1 queued");
    await expect(page.getByText("Publish pending").first()).toBeVisible();
    await expect(page.getByText("Live r1")).toHaveCount(0);
    await expect(page.getByTestId("delivery-sim")).toBeVisible();
    await page.getByTestId("sim-receipt").click();
    await expect(page.getByText("Live r1")).toBeVisible();
    await page.getByRole("tab", { name: "Approval & independence" }).click();
    await expect(page.getByText("Used once")).toBeVisible();

    // Isolation: the whole flow made zero network requests apart from the document, framework chunks and static assets. No POST. No API.
    expect(requests.filter((r) => r.startsWith("POST"))).toEqual([]);
    expect(requests.filter((r) => /\/api\/|supabase|\/account\/|\/admin\/api/.test(r))).toEqual([]);
  });

  test("highlighted classification cannot be lowered (V1) and editing after approval voids the approval", async ({ page }) => {
    await open(page);
    await actAs(page, "isolde");
    await go(page, "Articles / News");
    await page.getByRole("link", { name: "Winter Veil event schedule and rewards" }).click();
    await page.getByTestId("edit-article").click();
    await expect(page.getByText("V1: no classification downgrade")).toBeVisible();
    await page.getByLabel(/^Featured/).setChecked(false);
    await page.getByRole("combobox", { name: "Classification" }).selectOption("normal");
    await page.getByTestId("save-draft").click();
    await expect(page.getByTestId("editor-denial")).toContainText("classification cannot be downgraded");
    // content-only edit is fine and creates r2; the earlier in-review revision is superseded
    await page.getByLabel(/^Featured/).setChecked(true);
    await page.getByRole("combobox", { name: "Classification" }).selectOption("highlighted");
    await page.getByLabel("Title", { exact: true }).fill("Winter Veil event schedule, updated");
    await page.getByTestId("save-draft").click();
    await expect(page.getByText("Head r2: draft")).toBeVisible();
  });

  test("revision comparison shows the working revision against the published revision", async ({ page }) => {
    await open(page);
    await actAs(page, "mira");
    await go(page, "Articles / News");
    await page.getByRole("link", { name: "Realm population census: week 46" }).click();
    await expect(page.getByText("Published · newer draft")).toBeVisible();
    await expect(page.getByText("Live r1")).toBeVisible();
    await page.getByRole("tab", { name: "Working vs published" }).click();
    await expect(page.getByText("Working revision r2 vs published revision r1")).toBeVisible();
    const diff = page.getByTestId("diff-view");
    await expect(diff).toContainText("Method notes");
    await expect(diff.locator(".text-conf-high").first()).toBeVisible();
    await expect(diff.locator(".text-danger").first()).toBeVisible();
  });

  test("unpublish is queued and only takes effect on the simulated receipt; failed delivery keeps the old state and can be retried", async ({ page }) => {
    await open(page);
    await actAs(page, "brenna");
    await go(page, "Articles / News");
    await page.getByRole("link", { name: "Emergency maintenance: Ember Vale data refresh" }).click();
    await page.getByTestId("act-unpublish").click();
    await page.getByRole("button", { name: "Queue unpublish" }).click();
    await expect(page.getByText("Unpublish pending").first()).toBeVisible();
    await page.getByTestId("sim-fail").click();
    await expect(page.getByText("Delivery failed").first()).toBeVisible();
    await expect(page.getByText("Live r1")).toBeVisible();
    await page.getByTestId("sim-retry").click();
    await page.getByTestId("sim-receipt").click();
    await expect(page.getByText("Unpublished").first()).toBeVisible();
    await expect(page.getByText("Live r1")).toHaveCount(0);
  });
});
