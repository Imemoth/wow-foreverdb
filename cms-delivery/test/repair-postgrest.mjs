// ADM-03B/03C hotfix: stale-revision behaviour through a REAL PostgREST (pinned v12.2.12) in front of the repaired database.
// Before migration 0028 a stale edit raised SQLSTATE 40001, which PostgREST retries forever: the request never answered and held a pooled connection.
// Requires: FDB_REPAIR_PG_URL (superuser, disposable private database), FDB_REPAIR_REST_URL (loopback PostgREST), FDB_REPAIR_JWT_SECRET (public test value).
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';

const REST = process.env.FDB_REPAIR_REST_URL;
const SECRET = process.env.FDB_REPAIR_JWT_SECRET;
assert.match(REST ?? '', /^http:\/\/127\.0\.0\.1:[0-9]+$/, 'PostgREST must be a loopback disposable instance');
assert.ok(SECRET && process.env.FDB_REPAIR_PG_URL);
const db = new pg.Client({ connectionString: process.env.FDB_REPAIR_PG_URL });
await db.connect();

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (sub, sid) => {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ role: 'authenticated', sub, session_id: sid, aal: 'aal2', exp: 4102444800 });
  return `${head}.${body}.${createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')}`;
};
const EDITOR = jwt('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000201');
const ORDINARY = jwt('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000203');
const snapshot = (title, body) => ({ title, summary: 'A synthetic article for the real PostgREST stale revision regression.', body_markdown: body, classification: 'normal' });

async function rpc(fn, token, args, timeoutMs = 8000) {
  const started = Date.now();
  try {
    const res = await fetch(`${REST}/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(args), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, ms: Date.now() - started };
  } catch (e) { return { status: 0, body: String(e), ms: Date.now() - started }; }
}
const createDraft = async (slug) => {
  const article = randomUUID();
  const r = await rpc('fdb_cms_create_draft', EDITOR, { p_article: article, p_slug: slug, p_snapshot: snapshot('Original title', 'First body.'), p_request: randomUUID() });
  assert.equal(r.status, 200, JSON.stringify(r));
  const rev = (await db.query('select current_revision_id from editorial_private.articles where article_id=$1', [article])).rows[0].current_revision_id;
  return { article, rev1: rev };
};
const edit = (article, rev, title) => rpc('fdb_cms_edit_draft', EDITOR, { p_article: article, p_revision: rev, p_snapshot: snapshot(title, `Body of ${title}.`), p_request: randomUUID() });
const revisions = async (article) => Number((await db.query('select count(*) n from editorial_private.revisions where article_id=$1', [article])).rows[0].n);
const activeEdits = async () => Number((await db.query(
  "select count(*) n from pg_stat_activity where datname=current_database() and state='active' and pid<>pg_backend_pid() and query like '%fdb_cms_edit_draft%'")).rows[0].n);
const tag = randomUUID().slice(0, 8);

// 1. an ordinary edit from the current head works and a second one from the SAME (now old) head is a prompt, controlled 409
const a = await createDraft(`pgrst-stale-${tag}`);
const ok = await edit(a.article, a.rev1, 'Second title');
assert.equal(ok.status, 200, JSON.stringify(ok));
const stale = await edit(a.article, a.rev1, 'Stale title');
assert.equal(stale.status, 409, `stale edit answered ${stale.status} after ${stale.ms} ms: ${JSON.stringify(stale.body)}`);
assert.equal(stale.body.code, 'PT409');
assert.equal(stale.body.message, 'stale or uneditable revision');
assert.ok(stale.ms < 2000, `stale edit took ${stale.ms} ms: it must not be retried`);
assert.equal(await revisions(a.article), 2, 'a stale edit must not create a revision');

// 2. stale submit likewise (the other 40001 site)
const submitStale = await rpc('fdb_cms_submit_review', EDITOR, { p_article: a.article, p_revision: a.rev1, p_request: randomUUID() });
assert.equal(submitStale.status, 409, JSON.stringify(submitStale));
assert.equal(submitStale.body.code, 'PT409');
assert.ok(submitStale.ms < 2000);
assert.equal(Number((await db.query("select count(*) n from editorial_private.review_events where article_id=$1", [a.article])).rows[0].n), 0);

// 3. a flood of stale requests cannot pin the connection pool: all answer promptly and nothing stays active in the database
const flood = await Promise.all(Array.from({ length: 24 }, () => edit(a.article, a.rev1, 'Flood')));
assert.ok(flood.every((r) => r.status === 409 && r.body.code === 'PT409'), JSON.stringify(flood.map((r) => r.status)));
assert.ok(Math.max(...flood.map((r) => r.ms)) < 5000, 'stale flood was not answered promptly');
assert.equal(await activeEdits(), 0, 'stale requests are still running in the database');
assert.equal(await revisions(a.article), 2);

// 4. the remaining race window: concurrent edits from the SAME base revision. Exactly one commits, every other one gets the controlled 409.
for (let round = 0; round < 12; round++) {
  const x = await createDraft(`pgrst-race-${tag}-${round}`);
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => edit(x.article, x.rev1, `Racer ${round}-${i}`)));
  const wins = results.filter((r) => r.status === 200);
  const conflicts = results.filter((r) => r.status === 409);
  assert.equal(wins.length, 1, `round ${round}: ${JSON.stringify(results.map((r) => r.status))}`);
  assert.equal(conflicts.length, 3, `round ${round}: ${JSON.stringify(results.map((r) => [r.status, r.body]))}`);
  assert.ok(conflicts.every((r) => r.body.code === 'PT409' && r.ms < 5000));
  assert.equal(await revisions(x.article), 2, `round ${round}: optimistic concurrency violated`);
  const head = (await db.query('select current_revision_id, review_state from editorial_private.articles where article_id=$1', [x.article])).rows[0];
  assert.notEqual(head.current_revision_id, x.rev1);
  assert.equal(head.review_state, 'draft');
}
assert.equal(await activeEdits(), 0);

// 5. permission denial is still a denial (403 / 42501), never the conflict code; an unknown article is a denial too, and nothing leaks
const denied = await edit(a.article, a.rev1, 'Unauthorised');
assert.equal(denied.status, 409, 'control: the editor (authorised) still gets the conflict');
const ordinary = await rpc('fdb_cms_edit_draft', ORDINARY, { p_article: a.article, p_revision: a.rev1, p_snapshot: snapshot('Unauthorised', 'x'), p_request: randomUUID() });
assert.equal(ordinary.status, 403, JSON.stringify(ordinary));
assert.equal(ordinary.body.code, '42501');
const unknown = await rpc('fdb_cms_edit_draft', EDITOR, { p_article: randomUUID(), p_revision: a.rev1, p_snapshot: snapshot('Unknown', 'x'), p_request: randomUUID() });
assert.equal(unknown.status, 403);
assert.equal(unknown.body.code, '42501');
const anonymous = await fetch(`${REST}/rpc/fdb_cms_edit_draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
assert.ok([401, 403, 404].includes(anonymous.status), `anonymous answered ${anonymous.status}`);

await db.end();
console.log('real PostgREST stale-revision regression: PASS');
