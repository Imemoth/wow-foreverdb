import type { Page } from "@playwright/test";
import { expect, test, newCtx, createDraft, makeStaff, newStaffPage, newUser, runWorker, articleRow, db } from "./fixtures";

const act = async (page: Page, id: string): Promise<void> => { await page.getByTestId(id).click(); };
const confirm = async (page: Page, name: string | RegExp): Promise<void> => { await page.getByRole("dialog").getByRole("button", { name }).click(); };

/**
 * Highlighted content needs an independent, revision-bound approval before it may be published. Since the ADM-03B/03C backend hotfix (migration 0028)
 * the full path works end to end: the real worker delivers it, the signed receipts are recorded in both databases, and it is public everywhere.
 * A failed publication fails this test; there is no fallback that accepts it.
 */
test("highlighted content: approval by another person, publish intent, real worker delivery, signed receipt and public visibility", async ({ browser, request }) => {
  const ed = await newUser("hl-dlv-ed"), adm = await newUser("hl-dlv-adm"), owner = await newUser("hl-dlv-own");
  await makeStaff(ed, "Editor"); await makeStaff(adm, "Administrator"); await makeStaff(owner, "Owner");
  const pe = await newStaffPage(await newCtx(browser), ed);
  const pa = await newStaffPage(await newCtx(browser), adm);
  const po = await newStaffPage(await newCtx(browser), owner);
  const a = await createDraft(pe, { highlighted: true, title: "Highlighted delivered article" });
  await act(pe, "act-submit"); await confirm(pe, "Submit"); await expect(pe.getByTestId("article-status")).toHaveText("In review");

  // an independent approver is required: the Owner cannot publish before the Administrator's approval
  await pa.goto(a.url); await act(pa, "act-approve"); await confirm(pa, "Approve"); await expect(pa.getByTestId("article-status")).toHaveText("Approved");
  await po.goto(a.url); await act(po, "act-publish"); await confirm(po, /Request publish/);
  await expect(po.getByTestId("article-status")).toHaveText("Publish pending");
  expect((await request.get(`/news/${a.slug}`)).status()).toBe(404); // an intent alone is never public

  // the REAL worker: strict pass, no failure is accepted
  const rep = runWorker();
  expect(rep.failures).toEqual([]);
  expect(rep.delivered).toBeGreaterThanOrEqual(1);

  await po.reload();
  await expect(po.getByTestId("article-status")).toHaveText("Published");
  await po.getByRole("tab", { name: /Delivery/ }).click();
  await expect(po.getByTestId("delivery-state").first()).toHaveText("delivered");
  expect((await articleRow(a.slug)).published_revision_id).not.toBeNull();

  // signed receipt: the private ledger holds the delivered state with the MAC-signed public receipt that the worker read back from the public database
  const c = await db();
  try {
    const led = await c.query(
      `select s.state, s.public_receipt->>'receipt_mac' as mac, s.public_receipt->>'kind' as kind, s.public_applied_at is not null as applied
         from editorial_private.delivery_state s join editorial_private.articles a using(article_id) where a.slug=$1`, [a.slug]);
    expect(led.rows).toHaveLength(1);
    expect(led.rows[0]).toMatchObject({ state: "delivered", kind: "publish", applied: true });
    expect(led.rows[0].mac).toMatch(/^[0-9a-f]{64}$/);
  } finally { await c.end(); }

  // public: article page, archive, RSS and sitemap
  const art = await request.get(`/news/${a.slug}`);
  expect(art.status()).toBe(200);
  expect(await art.text()).toContain("Highlighted delivered article");
  expect(await (await request.get("/news")).text()).toContain(`/news/${a.slug}`);
  expect(await (await request.get("/news/rss.xml")).text()).toContain(`/news/${a.slug}`);
  expect(await (await request.get("/sitemap.xml")).text()).toContain(`/news/${a.slug}`);

  // idempotent: a second pass delivers nothing again and does not fail
  const again = runWorker();
  expect(again.failures).toEqual([]);
  expect(again.delivered).toBe(0);
});
