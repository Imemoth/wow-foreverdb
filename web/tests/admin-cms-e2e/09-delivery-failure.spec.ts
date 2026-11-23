import type { Page, Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { DELIVERY, expect, test, newCtx, aal2Token, db, makeStaff, newStaffPage, newUser, rest, runWorker, articleRow, type Staff } from "./fixtures";

test.skip(!DELIVERY, "needs the ADM-03C delivery ledger, worker and public-read database (up.sh with FDB_ADM03C_DIR)");

const act = async (page: Page, id: string): Promise<void> => { await page.getByTestId(id).click(); };
const confirm = async (page: Page, name: string | RegExp): Promise<void> => { await page.getByRole("dialog").getByRole("button", { name }).click(); };
const publicStatus = async (request: import("@playwright/test").APIRequestContext, slug: string): Promise<number> => (await request.get(`/news/${slug}`)).status();
const status = (page: Page) => page.getByTestId("article-status");

async function team(browser: Browser, tag: string): Promise<{ ed: Staff; owner: Staff; pe: Page; po: Page }> {
  const ed = await newUser(`${tag}-ed`), owner = await newUser(`${tag}-own`);
  await makeStaff(ed, "Editor"); await makeStaff(owner, "Owner");
  return { ed, owner, pe: await newStaffPage(await newCtx(browser), ed), po: await newStaffPage(await newCtx(browser), owner) };
}

/**
 * Runs LAST on purpose. A permanently failing intent stays retryable and the pinned ADM-03C worker retries it on EVERY pass; because the first
 * failure aborts the batch, one such intent blocks every later delivery (head-of-line blocking, recorded in docs/admin/adm-04-real-admin-cms-ui.md).
 * Any spec that needs a working worker therefore runs before this one.
 */
test.describe("failed delivery", () => {
  test("a delivery that fails is shown as FAILED (retryable) with the previous public state unchanged", async ({ browser, request }) => {
    const t = await team(browser, "fail");
    // A rights-verified registry asset whose file does not exist: the real worker validates the bytes and records a retryable failure.
    const assetId = crypto.randomUUID();
    const c = await db();
    try {
      await c.query("insert into editorial_private.media_assets(asset_id,asset_version,path,content_sha256,rights_source,rights_license,attribution,verified_by,verified_at) values($1,1,$2,$3,'E2E fixture source','CC0-1.0','E2E fixture',$4,clock_timestamp())",
        [assetId, `/content-images/e2e-missing/${assetId.slice(0, 8)}.png`, createHash("sha256").update("missing").digest(), t.owner.uid]);
    } finally { await c.end(); }
    const token = await aal2Token(t.ed);
    const slug = `fail-${assetId.slice(0, 8)}`;
    const created = await rest(token, "rpc/fdb_cms_create_draft", { method: "POST", body: { p_article: crypto.randomUUID(), p_slug: slug, p_request: crypto.randomUUID(),
      p_snapshot: { title: "Article with a missing image", summary: "A summary that is certainly long enough to pass.", body_markdown: "Body text.", classification: "normal", images: [{ asset_id: assetId, alt: "A missing image" }] } } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const row = await articleRow(slug);
    await t.pe.goto(`/admin/articles/${row.article_id}`);
    await act(t.pe, "act-submit"); await confirm(t.pe, "Submit"); await expect(status(t.pe)).toHaveText("In review");
    await t.po.goto(`/admin/articles/${row.article_id}`);
    await act(t.po, "act-publish"); await confirm(t.po, /Request publish/);
    await expect(status(t.po)).toHaveText("Publish pending");
    expect(() => runWorker()).toThrow(/missing_asset/);
    await t.po.reload();
    await expect(status(t.po)).toHaveText("Delivery failed");
    await t.po.getByRole("tab", { name: /Delivery/ }).click();
    await expect(t.po.getByTestId("delivery-state").first()).toHaveText("retryable");
    await expect(t.po.getByTestId("intent-table")).toContainText("missing_asset");
    expect(await publicStatus(request, slug)).toBe(404);
  });
});
