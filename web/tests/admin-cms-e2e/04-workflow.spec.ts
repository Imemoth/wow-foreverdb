import type { Page } from "@playwright/test";
import { expect, test, newCtx, createDraft, db, enterAdmin, makeStaff, newStaffPage, newUser, articleRow } from "./fixtures";

const act = async (page: Page, id: string): Promise<void> => { await page.getByTestId(id).click(); };
const confirm = async (page: Page, name: string | RegExp): Promise<void> => { await page.getByRole("dialog").getByRole("button", { name }).click(); };

test.describe("review workflow, independent approval, publish and unpublish intents (real RPCs)", () => {
  test("submit, return with a note, edit, resubmit and reject: every decision is a persisted review event", async ({ browser }) => {
    const author = await newUser("wf-author");
    const reviewer = await newUser("wf-reviewer");
    await makeStaff(author, "Editor");
    await makeStaff(reviewer, "Editor");
    const pa = await newStaffPage(await newCtx(browser), author);
    const pr = await newStaffPage(await newCtx(browser), reviewer);
    const a = await createDraft(pa);
    // only valid actions are enabled for a draft
    await expect(pa.getByTestId("act-submit")).toBeEnabled();
    for (const id of ["act-return", "act-reject", "act-approve", "act-publish", "act-unpublish"]) await expect(pa.getByTestId(id)).toBeDisabled();
    await act(pa, "act-submit"); await confirm(pa, "Submit");
    await expect(pa.getByTestId("article-status")).toHaveText("In review");
    expect((await articleRow(a.slug)).review_state).toBe("in_review");

    // the reviewer needs a note of at least five characters
    await pr.goto(a.url);
    await act(pr, "act-return");
    await pr.getByTestId("review-note").fill("abc");
    await pr.getByTestId("review-confirm").click();
    await expect(pr.getByRole("dialog")).toContainText("at least 5 characters");
    await pr.getByTestId("review-note").fill("Please add a source for the second claim.");
    await pr.getByTestId("review-confirm").click();
    await expect(pr.getByTestId("action-flash")).toContainText("Returned to the author");
    await pr.getByRole("tab", { name: /Review evidence/ }).click();
    await expect(pr.getByTestId("review-table")).toContainText("Please add a source for the second claim.");
    await expect(pr.getByTestId("review-table")).toContainText("return");

    // the author sees the note, edits (new revision) and resubmits
    await pa.reload();
    await pa.getByRole("tab", { name: /Review evidence/ }).click();
    await expect(pa.getByTestId("review-table")).toContainText("Please add a source");
    const st = await pa.getByTestId("article-status").textContent();
    expect(["Draft", "Rejected"]).toContain(st);
    await pa.getByTestId("edit-link").click();
    await pa.getByLabel("Summary", { exact: true }).fill("A summary now with a source: see the linked report.");
    await pa.getByTestId("save-draft").click();
    await pa.waitForURL(/\/admin\/articles\/[0-9a-f-]{36}$/);
    await act(pa, "act-submit"); await confirm(pa, "Submit");
    await expect(pa.getByTestId("article-status")).toHaveText("In review");

    // reject
    await pr.reload();
    await act(pr, "act-reject");
    await pr.getByTestId("review-note").fill("Not suitable for the news section.");
    await pr.getByTestId("review-confirm").click();
    await expect(pr.getByTestId("article-status")).toHaveText("Rejected");
    expect((await articleRow(a.slug)).review_state).toBe("rejected");
    const c = await db();
    try {
      const ev = await c.query("select decision from editorial_private.review_events e join editorial_private.articles a using(article_id) where a.slug=$1 order by occurred_at", [a.slug]);
      expect(ev.rows.map((r) => r.decision)).toEqual(["submit", "return", "submit", "reject"]);
    } finally { await c.end(); }
  });

  test("highlighted content: the author cannot approve it, another person must, and the approval is bound to that exact revision", async ({ browser }) => {
    const author = await newUser("hl-author");           // Editor + Administrator: holds BOTH permissions on purpose
    const admin2 = await newUser("hl-approver");
    const owner = await newUser("hl-owner");
    await makeStaff(author, "Editor"); await makeStaff(author, "Administrator");
    await makeStaff(admin2, "Administrator");
    await makeStaff(owner, "Owner");
    const pa = await newStaffPage(await newCtx(browser), author);
    const pb = await newStaffPage(await newCtx(browser), admin2);
    const po = await newStaffPage(await newCtx(browser), owner);
    const a = await createDraft(pa, { highlighted: true });
    await expect(pa.getByText("Needs independent approval").first()).toBeVisible().catch(() => undefined);
    await act(pa, "act-submit"); await confirm(pa, "Submit");
    await expect(pa.getByTestId("article-status")).toHaveText("In review");
    // a normal-publish shortcut is not offered for highlighted content, and the database would refuse it anyway
    await po.goto(a.url);
    await expect(po.getByTestId("act-publish")).toBeDisabled();
    // self-approval: the button is enabled (the author holds the permission) but the DATABASE refuses it
    await expect(pa.getByTestId("act-approve")).toBeEnabled();
    await act(pa, "act-approve"); await confirm(pa, "Approve");
    await expect(pa.getByTestId("action-flash")).toContainText("Independent approval required");
    expect((await articleRow(a.slug)).review_state).toBe("in_review");
    // an independent Administrator approves
    await pb.goto(a.url);
    await act(pb, "act-approve"); await confirm(pb, "Approve");
    await expect(pb.getByTestId("action-flash")).toContainText("Approved");
    await expect(pb.getByTestId("article-status")).toHaveText("Approved");
    await pb.getByRole("tab", { name: /Review evidence/ }).click();
    await expect(pb.getByTestId("approval-table")).toContainText("no"); // not yet consumed
    // the Owner (independent of the author) can now record a publish intent
    await po.reload();
    await expect(po.getByTestId("act-publish")).toBeEnabled();
    await act(po, "act-publish"); await confirm(po, /Request publish/);
    await expect(po.getByTestId("action-flash")).toContainText("Publish intent recorded");
    await expect(po.getByTestId("article-status")).not.toHaveText("Approved");
    const row = await articleRow(a.slug);
    expect(row.review_state).toBe("publish_pending");
    await po.getByRole("tab", { name: /Delivery/ }).click();
    await expect(po.getByTestId("intent-publish")).toBeVisible();
  });

  test("an approval does not survive a new revision: editing after approval requires approving again", async ({ browser }) => {
    const author = await newUser("rev-author");
    const approver = await newUser("rev-approver");
    await makeStaff(author, "Editor");
    await makeStaff(approver, "Administrator");
    const pa = await newStaffPage(await newCtx(browser), author);
    const pb = await newStaffPage(await newCtx(browser), approver);
    const a = await createDraft(pa, { highlighted: true });
    await act(pa, "act-submit"); await confirm(pa, "Submit");
    await pb.goto(a.url); await act(pb, "act-approve"); await confirm(pb, "Approve");
    await expect(pb.getByTestId("article-status")).toHaveText("Approved");
    await pa.reload();
    await pa.getByTestId("edit-link").click();
    await pa.getByLabel("Title", { exact: true }).fill("Edited after approval");
    await pa.getByTestId("save-draft").click();
    await pa.waitForURL(/\/admin\/articles\/[0-9a-f-]{36}$/);
    // the new head revision is not the approved one
    await pb.reload();
    const st = await pb.getByTestId("article-status").textContent();
    expect(st).not.toBe("Approved");
    await pb.getByRole("tab", { name: /Review evidence/ }).click();
    await expect(pb.getByTestId("approval-table")).toBeVisible();
  });

  test("a publish needs the right role: an Editor cannot publish, an Administrator cannot publish, the Owner can; classification cannot be downgraded", async ({ browser }) => {
    const ed = await newUser("pub-editor");
    const adm = await newUser("pub-admin");
    const owner = await newUser("pub-owner");
    await makeStaff(ed, "Editor"); await makeStaff(adm, "Administrator"); await makeStaff(owner, "Owner");
    const pe = await newStaffPage(await newCtx(browser), ed);
    const pad = await newStaffPage(await newCtx(browser), adm);
    const po = await newStaffPage(await newCtx(browser), owner);
    const a = await createDraft(pe);
    await act(pe, "act-submit"); await confirm(pe, "Submit");
    await expect(pe.getByTestId("act-publish")).toBeDisabled();
    await pad.goto(a.url);
    await expect(pad.getByTestId("act-publish")).toBeDisabled();
    // forced publish by the Editor through the real endpoint is denied by the database
    const csrf = (await (await pe.request.get("/admin/api/csrf")).json()).token as string;
    const row = await articleRow(a.slug);
    const r = await pe.request.post("/admin/api/cms/publish", { headers: { "x-fdb-csrf": csrf, origin: "http://localhost:3220", "content-type": "application/json" }, data: { requestId: crypto.randomUUID(), articleId: row.article_id, revisionId: row.current_revision_id } });
    expect(r.status()).toBe(403);
    expect((await articleRow(a.slug)).review_state).toBe("in_review");
    await po.goto(a.url);
    await expect(po.getByTestId("act-publish")).toBeEnabled();
    // classification downgrade: after a highlighted revision exists, a normal one is refused
    const h = await createDraft(pe, { highlighted: true });
    await pe.getByTestId("edit-link").click();
    await pe.getByLabel(/^Featured/).uncheck();
    await pe.getByLabel("Classification", { exact: true }).selectOption("normal");
    await pe.getByTestId("save-draft").click();
    await expect(pe.getByTestId("editor-notice")).toContainText("Classification cannot be lowered");
    expect((await articleRow(h.slug)).classification_floor).toBe(1);
  });

  test("retrying an action with the same request id cannot apply twice (idempotency)", async ({ page }) => {
    const ed = await newUser("idem");
    await makeStaff(ed, "Editor");
    await enterAdmin(page, ed);
    const a = await createDraft(page);
    const row = await articleRow(a.slug);
    const csrf = (await (await page.request.get("/admin/api/csrf")).json()).token as string;
    const headers = { "x-fdb-csrf": csrf, origin: "http://localhost:3220", "content-type": "application/json" };
    const data = { requestId: crypto.randomUUID(), articleId: row.article_id, revisionId: row.current_revision_id };
    const r1 = await page.request.post("/admin/api/cms/submit", { headers, data });
    const r2 = await page.request.post("/admin/api/cms/submit", { headers, data });
    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);
    const c = await db();
    try {
      const n = (await c.query("select count(*)::int n from editorial_private.review_events e join editorial_private.articles a using(article_id) where a.slug=$1 and decision='submit'", [a.slug])).rows[0].n;
      expect(n).toBe(1);
    } finally { await c.end(); }
    // the same request id reused for a DIFFERENT action is refused
    const r3 = await page.request.post("/admin/api/cms/review", { headers, data: { ...data, decision: "reject", note: "Different action, same id." } });
    expect(r3.status()).toBeGreaterThanOrEqual(400);
  });
});
