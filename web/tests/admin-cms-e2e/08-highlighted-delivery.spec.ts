import type { Page } from "@playwright/test";
import { DELIVERY, expect, test, newCtx, createDraft, makeStaff, newStaffPage, newUser, runWorker } from "./fixtures";

test.skip(!DELIVERY, "needs the ADM-03C delivery ledger, worker and public-read database (up.sh with FDB_ADM03C_DIR)");

const act = async (page: Page, id: string): Promise<void> => { await page.getByTestId(id).click(); };
const confirm = async (page: Page, name: string | RegExp): Promise<void> => { await page.getByRole("dialog").getByRole("button", { name }).click(); };

/**
 * Runs LAST on purpose. At the pinned ADM-03C commit (see web/tests/admin-cms-stack/adm03c.pin) the worker's eligibility function
 * (editorial_private.cms_dispatch_eligible) declares a record variable `ap` and also aliases `approvals ap`, so every HIGHLIGHTED publish fails with
 * `column reference "ap.approval_id" is ambiguous`, and one failing candidate aborts the whole worker batch. The UI must stay truthful meanwhile:
 * the article remains "Publish pending", nothing becomes public. The test asserts that fail-closed behaviour and, once ADM-03C is fixed, asserts the
 * full delivery instead. The defect is recorded as a test annotation and in docs/admin/adm-04-real-admin-cms-ui.md.
 */
test("highlighted content: approval by another person, publish intent, then real delivery (or, while ADM-03C has its known defect, a truthful pending state)", async ({ browser, request }) => {
  const ed = await newUser("hl-dlv-ed"), adm = await newUser("hl-dlv-adm"), owner = await newUser("hl-dlv-own");
  await makeStaff(ed, "Editor"); await makeStaff(adm, "Administrator"); await makeStaff(owner, "Owner");
  const pe = await newStaffPage(await newCtx(browser), ed);
  const pa = await newStaffPage(await newCtx(browser), adm);
  const po = await newStaffPage(await newCtx(browser), owner);
  const a = await createDraft(pe, { highlighted: true, title: "Highlighted delivered article" });
  await act(pe, "act-submit"); await confirm(pe, "Submit");
  await pa.goto(a.url); await act(pa, "act-approve"); await confirm(pa, "Approve");
  await po.goto(a.url); await act(po, "act-publish"); await confirm(po, /Request publish/);
  await expect(po.getByTestId("article-status")).toHaveText("Publish pending");
  let defect: string | null = null;
  try { runWorker(); } catch (e) { defect = String((e as Error).message); }
  await po.reload();
  const status = (await request.get(`/news/${a.slug}`)).status();
  if (defect === null) {
    await expect(po.getByTestId("article-status")).toHaveText("Published");
    expect(status).toBe(200);
  } else {
    expect(defect).toMatch(/ambiguous/);
    test.info().annotations.push({ type: "adm03c-defect", description: "cms_dispatch_eligible: column reference \"ap.approval_id\" is ambiguous for highlighted publishes (PR #206 @ pinned SHA)" });
    await expect(po.getByTestId("article-status")).toHaveText("Publish pending");
    expect(status).toBe(404); // fail closed: undelivered content is never public
  }
});
