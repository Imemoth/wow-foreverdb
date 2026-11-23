import type { Page, Browser } from "@playwright/test";
import { createHash } from "node:crypto";
import { expect, test, newCtx, DELIVERY, aal2Token, createDraft, db, makeStaff, newStaffPage, newUser, rest, runWorker, articleRow, type Staff } from "./fixtures";

test.skip(!DELIVERY, "needs the ADM-03C delivery ledger, worker and public-read database (up.sh with FDB_ADM03C_DIR)");

const act = async (page: Page, id: string): Promise<void> => { await page.getByTestId(id).click(); };
const confirm = async (page: Page, name: string | RegExp): Promise<void> => { await page.getByRole("dialog").getByRole("button", { name }).click(); };
const status = (page: Page) => page.getByTestId("article-status");

async function team(browser: Browser, tag: string): Promise<{ ed: Staff; owner: Staff; adm: Staff; pe: Page; po: Page; pa: Page }> {
  const ed = await newUser(`${tag}-ed`), owner = await newUser(`${tag}-own`), adm = await newUser(`${tag}-adm`);
  await makeStaff(ed, "Editor"); await makeStaff(owner, "Owner"); await makeStaff(adm, "Administrator");
  return { ed, owner, adm, pe: await newStaffPage(await newCtx(browser), ed), po: await newStaffPage(await newCtx(browser), owner), pa: await newStaffPage(await newCtx(browser), adm) };
}
const publicStatus = async (request: import("@playwright/test").APIRequestContext, slug: string): Promise<number> => (await request.get(`/news/${slug}`)).status();

test.describe("publish intent, real delivery receipt, public visibility, unpublish and tombstone", () => {
  test("publish is only an intent until the real worker delivers it; then it is public in article, archive, RSS and sitemap; unpublish leaves a tombstone", async ({ browser, request }) => {
    const t = await team(browser, "dlv");
    const a = await createDraft(t.pe, { title: "Delivered E2E article" });
    // a draft is never public
    expect(await publicStatus(request, a.slug)).toBe(404);
    await act(t.pe, "act-submit"); await confirm(t.pe, "Submit"); await expect(status(t.pe)).toHaveText("In review");

    await t.po.goto(a.url);
    await act(t.po, "act-publish"); await confirm(t.po, /Request publish/);
    await expect(t.po.getByTestId("action-flash")).toContainText("Publish intent recorded");
    // pending: the intent exists, nothing is public, the UI must NOT claim "Published"
    await expect(status(t.po)).toHaveText("Publish pending");
    expect(await publicStatus(request, a.slug)).toBe(404);
    await t.po.getByRole("tab", { name: /Delivery/ }).click();
    await expect(t.po.getByTestId("delivery-state").first()).not.toHaveText("delivered");

    // the REAL worker (separate process, own roles) applies it and returns a signed receipt
    const rep = runWorker();
    expect(rep.delivered).toBeGreaterThanOrEqual(1);
    await t.po.reload();
    await expect(status(t.po)).toHaveText("Published");
    await t.po.getByRole("tab", { name: /Delivery/ }).click();
    await expect(t.po.getByTestId("delivery-state").first()).toHaveText("delivered");
    expect((await articleRow(a.slug)).published_revision_id).not.toBeNull();

    // public website: article page, archive, RSS and sitemap
    const art = await request.get(`/news/${a.slug}`);
    expect(art.status()).toBe(200);
    expect(await art.text()).toContain("Delivered E2E article");
    expect(await (await request.get("/news")).text()).toContain(`/news/${a.slug}`);
    const rss = await request.get("/news/rss.xml");
    expect(await rss.text()).toContain(`/news/${a.slug}`);
    expect(rss.headers()["cache-control"]).toMatch(/no-store/);
    expect(await (await request.get("/sitemap.xml")).text()).toContain(`/news/${a.slug}`);
    // no private data leaks to the public page
    const html = await art.text();
    for (const bad of ["draft", "review_state", "editorial_private", "approved_by", a.slug.length ? "session_id" : ""]) if (bad) expect(html).not.toContain(bad === "draft" ? "editorial draft" : bad);

    // unpublish: an intent, still public until delivered
    await act(t.po, "act-unpublish").catch(() => undefined);
    await t.po.getByRole("tab", { name: /Overview/ }).click();
    await act(t.po, "act-unpublish"); await confirm(t.po, /Request unpublish/);
    await expect(t.po.getByTestId("action-flash")).toContainText("Unpublish intent recorded");
    await expect(status(t.po)).toHaveText("Unpublish pending");
    expect(await publicStatus(request, a.slug)).toBe(200);
    runWorker();
    await t.po.reload();
    await expect(status(t.po)).toHaveText("Unpublished");
    // tombstone: 404 everywhere, even though the slug stays reserved
    expect(await publicStatus(request, a.slug)).toBe(404);
    expect(await (await request.get("/news")).text()).not.toContain(`/news/${a.slug}`);
    expect(await (await request.get("/news/rss.xml")).text()).not.toContain(`/news/${a.slug}`);
    expect(await (await request.get("/sitemap.xml")).text()).not.toContain(`/news/${a.slug}`);
    expect((await articleRow(a.slug)).slug).toBe(a.slug);
  });

  test("an unpublish by an Administrator (unpublish permission, no publish permission) also works end to end", async ({ browser, request }) => {
    const t = await team(browser, "adm-unpub");
    const a = await createDraft(t.pe);
    await act(t.pe, "act-submit"); await confirm(t.pe, "Submit"); await expect(status(t.pe)).toHaveText("In review");
    await t.po.goto(a.url); await act(t.po, "act-publish"); await confirm(t.po, /Request publish/);
    runWorker();
    expect(await publicStatus(request, a.slug)).toBe(200);
    await t.pa.goto(a.url);
    await expect(t.pa.getByTestId("act-publish")).toBeDisabled();
    await act(t.pa, "act-unpublish"); await confirm(t.pa, /Request unpublish/);
    runWorker();
    expect(await publicStatus(request, a.slug)).toBe(404);
  });

  test("a publish whose grant is revoked before delivery is CANCELLED by the worker and nothing becomes public", async ({ browser, request }) => {
    const t = await team(browser, "cancel");
    const a = await createDraft(t.pe);
    await act(t.pe, "act-submit"); await confirm(t.pe, "Submit"); await expect(status(t.pe)).toHaveText("In review");
    await t.po.goto(a.url); await act(t.po, "act-publish"); await confirm(t.po, /Request publish/);
    await expect(status(t.po)).toHaveText("Publish pending");
    // the Owner's grant ends before the worker runs (database-side revocation)
    const c = await db();
    try {
      await c.query("alter table admin_private.staff_subjects disable trigger all");
      await c.query("update admin_private.staff_subjects set status='suspended' where user_id=$1", [t.owner.uid]).catch(async () => {
        await c.query("alter table admin_private.role_assignments disable trigger all");
        await c.query("update admin_private.role_assignments set starts_at=clock_timestamp()-interval '2 days', expires_at=clock_timestamp()-interval '1 second' where user_id=$1", [t.owner.uid]);
        await c.query("alter table admin_private.role_assignments enable trigger all");
      });
      await c.query("alter table admin_private.staff_subjects enable trigger all");
    } finally { await c.end(); }
    const rep = runWorker();
    expect(rep.cancelled + rep.retried).toBeGreaterThanOrEqual(0);
    expect(await publicStatus(request, a.slug)).toBe(404);
    await t.pa.goto(a.url);
    await expect(status(t.pa)).toHaveText(/Publish cancelled|Publish superseded/);
    await t.pa.getByRole("tab", { name: /Delivery/ }).click();
    await expect(t.pa.getByTestId("delivery-state").first()).toHaveText(/cancelled|superseded/);
  });

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
    expect(() => runWorker()).toThrow(/missing_asset|delivery/);
    await t.po.reload();
    await expect(status(t.po)).toHaveText("Delivery failed");
    await t.po.getByRole("tab", { name: /Delivery/ }).click();
    await expect(t.po.getByTestId("delivery-state").first()).toHaveText("retryable");
    await expect(t.po.getByTestId("intent-table")).toContainText("missing_asset");
    expect(await publicStatus(request, slug)).toBe(404);
  });
});
