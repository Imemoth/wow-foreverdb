import { expect, test, aal2Token, db, enterAdmin, makeStaff, newUser, rest, articleRow } from "./fixtures";

/**
 * Stale revisions and concurrent updates against the REAL pinned PostgREST (through the gateway), and through the Admin adapter.
 * Before migration 0028 a stale edit raised SQLSTATE 40001, which PostgREST retries forever; since 0028 the database answers PT409 / HTTP 409 at once.
 * The adapter's own pre-check only has to cover the common case; the database now also answers the narrow race promptly.
 */
const snapshot = (title: string) => ({ title, summary: "A summary that is certainly long enough to pass.", body_markdown: `Body of ${title}.`, classification: "normal" });
const revisions = async (slug: string): Promise<number> => {
  const c = await db();
  try { return (await c.query("select count(*)::int n from editorial_private.revisions r join editorial_private.articles a using(article_id) where a.slug=$1", [slug])).rows[0].n; } finally { await c.end(); }
};

test.describe("stale revisions and concurrent updates (real PostgREST)", () => {
  test("a stale edit and a stale submit answer HTTP 409 PT409 promptly; the database never retries them and nothing is written", async () => {
    const ed = await newUser("stale-rpc");
    await makeStaff(ed, "Editor");
    const token = await aal2Token(ed);
    const slug = `stale-${crypto.randomUUID().slice(0, 8)}`;
    const article = crypto.randomUUID();
    const created = await rest(token, "rpc/fdb_cms_create_draft", { method: "POST", body: { p_article: article, p_slug: slug, p_request: crypto.randomUUID(), p_snapshot: snapshot("Race base") } });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const rev1 = (await articleRow(slug)).current_revision_id as string;
    const first = await rest(token, "rpc/fdb_cms_edit_draft", { method: "POST", body: { p_article: article, p_revision: rev1, p_snapshot: snapshot("Second"), p_request: crypto.randomUUID() } });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const head = (await articleRow(slug)).current_revision_id as string;
    expect(head).not.toBe(rev1);

    const t0 = Date.now();
    const staleEdit = await rest(token, "rpc/fdb_cms_edit_draft", { method: "POST", body: { p_article: article, p_revision: rev1, p_snapshot: snapshot("Stale"), p_request: crypto.randomUUID() } });
    const staleSubmit = await rest(token, "rpc/fdb_cms_submit_review", { method: "POST", body: { p_article: article, p_revision: rev1, p_request: crypto.randomUUID() } });
    expect(Date.now() - t0, "stale answers must not wait on PostgREST retries").toBeLessThan(4000);
    expect(staleEdit.status).toBe(409);
    expect(staleEdit.body.code).toBe("PT409");
    expect(staleSubmit.status).toBe(409);
    expect(staleSubmit.body.code).toBe("PT409");
    expect(await revisions(slug)).toBe(2);
    expect((await articleRow(slug)).current_revision_id).toBe(head);
    // nothing is left running in the database
    const c = await db();
    try {
      const active = await c.query("select count(*)::int n from pg_stat_activity where datname=current_database() and state='active' and pid<>pg_backend_pid() and query like '%fdb_cms_edit_draft%'");
      expect(active.rows[0].n).toBe(0);
    } finally { await c.end(); }
  });

  test("the narrow race: concurrent edits from the same base revision, directly at PostgREST: exactly one wins, the others are 409, no extra revision", async () => {
    const ed = await newUser("race-rpc");
    await makeStaff(ed, "Editor");
    const token = await aal2Token(ed);
    const slug = `race-${crypto.randomUUID().slice(0, 8)}`;
    const article = crypto.randomUUID();
    expect((await rest(token, "rpc/fdb_cms_create_draft", { method: "POST", body: { p_article: article, p_slug: slug, p_request: crypto.randomUUID(), p_snapshot: snapshot("Race base") } })).status).toBe(200);
    let base = (await articleRow(slug)).current_revision_id as string;
    for (let round = 0; round < 6; round++) {
      const before = await revisions(slug);
      const t0 = Date.now();
      const res = await Promise.all([0, 1, 2, 3].map((i) =>
        rest(token, "rpc/fdb_cms_edit_draft", { method: "POST", body: { p_article: article, p_revision: base, p_snapshot: snapshot(`Round ${round} writer ${i}`), p_request: crypto.randomUUID() } })));
      expect(Date.now() - t0, `round ${round} must finish promptly`).toBeLessThan(6000);
      const codes = res.map((r) => r.status).sort();
      expect(codes, JSON.stringify(res.map((r) => r.body))).toEqual([200, 409, 409, 409]);
      for (const r of res.filter((x) => x.status === 409)) expect(r.body.code).toBe("PT409");
      expect(await revisions(slug)).toBe(before + 1);
      base = (await articleRow(slug)).current_revision_id as string;
    }
  });

  test("through the Admin adapter: simultaneous edits from the same revision give one success and stale conflicts, quickly, with one new revision", async ({ page }) => {
    const ed = await newUser("race-ui");
    await makeStaff(ed, "Editor");
    await enterAdmin(page, ed);
    const csrf = (await (await page.request.get("/admin/api/csrf")).json()).token as string;
    const headers = { "x-fdb-csrf": csrf, origin: "http://localhost:3220", "content-type": "application/json" };
    const slug = `race-ui-${crypto.randomUUID().slice(0, 8)}`;
    const created = await page.request.post("/admin/api/cms/create", { headers, data: { requestId: crypto.randomUUID(), slug, snapshot: snapshot("UI race base") } });
    expect(created.status()).toBe(200);
    const row = await articleRow(slug);
    const t0 = Date.now();
    const res = await Promise.all([0, 1, 2, 3].map((i) =>
      page.request.post("/admin/api/cms/edit", { headers, data: { requestId: crypto.randomUUID(), articleId: row.article_id, revisionId: row.current_revision_id, snapshot: snapshot(`UI writer ${i}`) } })));
    expect(Date.now() - t0).toBeLessThan(8000);
    const statuses = res.map((r) => r.status()).sort();
    expect(statuses).toEqual([200, 409, 409, 409]);
    for (const r of res.filter((x) => x.status() === 409)) expect((await r.json()).error.kind).toBe("stale");
    expect(await revisions(slug)).toBe(2);
  });
});
