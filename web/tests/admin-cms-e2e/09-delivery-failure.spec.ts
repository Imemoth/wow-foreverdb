import type { Page, Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { expect, test, newCtx, aal2Token, db, makeStaff, newStaffPage, newUser, rest, runWorker, runWorkerPass, articleRow, createDraft, type Staff } from "./fixtures";

const act = async (page: Page, id: string): Promise<void> => { await page.getByTestId(id).click(); };
const confirm = async (page: Page, name: string | RegExp): Promise<void> => { await page.getByRole("dialog").getByRole("button", { name }).click(); };
const publicStatus = async (request: import("@playwright/test").APIRequestContext, slug: string): Promise<number> => (await request.get(`/news/${slug}`)).status();
const status = (page: Page) => page.getByTestId("article-status");
const PUBLIC_ROOT = resolve(__dirname, "../../public");

async function team(browser: Browser, tag: string): Promise<{ ed: Staff; owner: Staff; pe: Page; po: Page }> {
  const ed = await newUser(`${tag}-ed`), owner = await newUser(`${tag}-own`);
  await makeStaff(ed, "Editor"); await makeStaff(owner, "Owner");
  return { ed, owner, pe: await newStaffPage(await newCtx(browser), ed), po: await newStaffPage(await newCtx(browser), owner) };
}

/**
 * Failed delivery, isolation and recovery. Since the ADM-03B/03C backend hotfix (migration 0028) the worker isolates a recoverable per-intent failure: the
 * failing intent keeps its retry state and the same pass still delivers unrelated intents. There is no ordering workaround any more: this scenario may run
 * anywhere, and it leaves no stuck intent behind (the failing delivery is recovered at the end by the product's own retry).
 */
test.describe("failed delivery does not block unrelated deliveries", () => {
  test("a retryable failure and an unrelated valid delivery in the SAME worker pass; the failure keeps its retry state, then recovers", async ({ browser, request }) => {
    const t = await team(browser, "fail");

    // F: a rights-verified registry asset whose file does not exist yet. The real worker validates the bytes and records a retryable failure.
    const assetId = crypto.randomUUID();
    const rel = `/content-images/e2e-missing/${assetId.slice(0, 8)}.png`;
    const file = resolve(PUBLIC_ROOT, `.${rel}`);
    const bytes = Buffer.from("e2e fixture bytes");
    const c = await db();
    try {
      await c.query("insert into editorial_private.media_assets(asset_id,asset_version,path,content_sha256,rights_source,rights_license,attribution,verified_by,verified_at) values($1,1,$2,$3,'E2E fixture source','CC0-1.0','E2E fixture',$4,clock_timestamp())",
        [assetId, rel, createHash("sha256").update(bytes).digest(), t.owner.uid]);
    } finally { await c.end(); }
    const token = await aal2Token(t.ed);
    const slugF = `fail-${assetId.slice(0, 8)}`;
    const created = await rest(token, "rpc/fdb_cms_create_draft", { method: "POST", body: { p_article: crypto.randomUUID(), p_slug: slugF, p_request: crypto.randomUUID(),
      p_snapshot: { title: "Article with a missing image", summary: "A summary that is certainly long enough to pass.", body_markdown: "Body text.", classification: "normal", images: [{ asset_id: assetId, alt: "A missing image" }] } } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const rowF = await articleRow(slugF);
    await t.pe.goto(`/admin/articles/${rowF.article_id}`);
    await act(t.pe, "act-submit"); await confirm(t.pe, "Submit"); await expect(status(t.pe)).toHaveText("In review");
    await t.po.goto(`/admin/articles/${rowF.article_id}`);
    await act(t.po, "act-publish"); await confirm(t.po, /Request publish/);
    await expect(status(t.po)).toHaveText("Publish pending");

    // V: an unrelated, valid article requested AFTER F, so F is first in the worker's queue (the old behaviour aborted the pass at F and never reached V).
    const v = await createDraft(t.pe, { title: "Unrelated valid article" });
    await act(t.pe, "act-submit"); await confirm(t.pe, "Submit"); await expect(status(t.pe)).toHaveText("In review");
    await t.po.goto(v.url); await act(t.po, "act-publish"); await confirm(t.po, /Request publish/);
    await expect(status(t.po)).toHaveText("Publish pending");

    try {
      // ONE pass: F fails (isolated, reported, non-zero exit), V is delivered.
      const pass = runWorkerPass();
      expect(pass.status).toBe(1);
      expect(pass.report, pass.stderr).not.toBeNull();
      expect(pass.report!.failures.map((f) => f.code)).toContain("missing_asset");
      expect(pass.report!.delivered).toBeGreaterThanOrEqual(1);

      // V: delivered and public everywhere
      await t.po.goto(v.url);
      await expect(status(t.po)).toHaveText("Published");
      expect(await publicStatus(request, v.slug)).toBe(200);
      expect(await (await request.get("/news")).text()).toContain(`/news/${v.slug}`);
      expect(await (await request.get("/news/rss.xml")).text()).toContain(`/news/${v.slug}`);
      expect(await (await request.get("/sitemap.xml")).text()).toContain(`/news/${v.slug}`);

      // F: shown as FAILED, retryable, one attempt, the code is recorded, nothing public, one audit event
      await t.po.goto(`/admin/articles/${rowF.article_id}`);
      await expect(status(t.po)).toHaveText("Delivery failed");
      await t.po.getByRole("tab", { name: /Delivery/ }).click();
      await expect(t.po.getByTestId("delivery-state").first()).toHaveText("retryable");
      await expect(t.po.getByTestId("intent-table")).toContainText("missing_asset");
      expect(await publicStatus(request, slugF)).toBe(404);
      const d = await db();
      try {
        const st = await d.query("select state, attempt, last_error_code from editorial_private.delivery_state where article_id=$1", [rowF.article_id]);
        expect(st.rows).toEqual([{ state: "retryable", attempt: 1, last_error_code: "missing_asset" }]);
        const ev = await d.query("select count(*)::int n from admin_private.staff_audit_events where action_key='news.delivery.failure' and resource_key=$1", [`article:${rowF.article_id}`]);
        expect(ev.rows[0].n).toBe(1);
      } finally { await d.end(); }

      // Idempotency: a second pass fails F again (a new attempt) but never delivers V twice (exactly one public occurrence).
      const second = runWorkerPass();
      expect(second.status).toBe(1);
      expect(second.report!.delivered).toBe(0);
      expect(second.report!.failures.map((f) => f.code)).toContain("missing_asset");
      const rss = await (await request.get("/news/rss.xml")).text();
      expect(rss.split("<item>").filter((item) => item.includes(`/news/${v.slug}`))).toHaveLength(1); // one feed item (its link and guid both carry the slug)

      // Recovery: the asset appears, the retry state machine delivers F on the next pass, and the pass is clean.
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      const clean = runWorker();
      expect(clean.failures).toEqual([]);
      expect(clean.delivered).toBeGreaterThanOrEqual(1);
      await t.po.goto(`/admin/articles/${rowF.article_id}`);
      await expect(status(t.po)).toHaveText("Published");
      expect(await publicStatus(request, slugF)).toBe(200);
    } finally {
      rmSync(resolve(PUBLIC_ROOT, "content-images/e2e-missing"), { recursive: true, force: true });
    }
  });
});
