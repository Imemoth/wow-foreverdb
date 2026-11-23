// ADM-03B/03C hotfix: the REAL worker against the repaired private + public databases.
//   1. highlighted publication -> signed receipt -> private pointer -> public visibility (this failed before migration 0028)
//   2. signed receipts / MACs are still enforced on the highlighted path
//   3. a retryable failure followed by an unrelated successful delivery in the SAME pass, with retry state, audit evidence and idempotency preserved
// Requires the FDB_CMS_* worker environment of cms-delivery/test/integration.mjs, plus the fixtures of database/tests/admin_cms_repair/worker-fixtures.sql.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { main } from '../src/once.mjs';

process.env.FDB_CMS_ASSET_ROOT ||= mkdtempSync(join(tmpdir(), 'cms-repair-assets-')); // an asset root that does NOT contain the registry image
const privateDb = new pg.Client({ connectionString: process.env.FDB_CMS_PRIVATE_URL });
const publicDb = new pg.Client({ connectionString: process.env.FDB_CMS_PUBLIC_URL });
await privateDb.connect(); await publicDb.connect();
const one = async (db, sql, args = []) => (await db.query(sql, args)).rows[0];
const intentOf = async (slug) => (await one(privateDb,
  `select i.intent_id from editorial_private.publication_intents i join editorial_private.articles a using(article_id) where a.slug=$1 order by i.generation desc limit 1`, [slug])).intent_id;
const ledger = async (intent) => one(privateDb, 'select state,attempt,last_error_code,public_receipt from editorial_private.delivery_state where intent_id=$1', [intent]);
const article = async (slug) => one(privateDb, 'select article_id,review_state,published_revision_id,current_revision_id,generation from editorial_private.articles where slug=$1', [slug]);
const auditCount = async (action, articleId) => Number((await one(privateDb,
  "select count(*) n from admin_private.staff_audit_events where action_key=$1 and resource_key=$2", [action, `article:${articleId}`])).n);
const reader = async (slug) => { // exactly what the website's public adapter calls, as the read-only web role
  await publicDb.query('set role foreverdb_web_reader');
  try { return (await one(publicDb, 'select web_api.cms_article($1) as value', [slug])).value; } finally { await publicDb.query('reset role'); }
};

try {
  const highlighted = await intentOf('repair-highlighted');
  const failing = await intentOf('repair-failing-delivery');
  const unrelated = await intentOf('repair-unrelated-delivery');
  const forged = await intentOf('repair-forged-receipt');
  assert.equal((await article('repair-highlighted')).published_revision_id, null, 'nothing is public before delivery');
  assert.equal(await reader('repair-highlighted'), null);

  // ---- 2. signed receipts still bind the highlighted path: a forged private acknowledgement and a forged public MAC are both refused
  await privateDb.query('set role azerdex_cms_dispatch');
  assert.equal((await one(privateDb, 'select editorial_private.cms_dispatch_qualify($1) as ok', [forged])).ok, true);
  const claim = (await one(privateDb, 'select editorial_private.cms_dispatch_claim($1) as value', [forged])).value;
  const forgedReceipt = { intent_id: forged, article_id: claim.article_id, generation: claim.generation, kind: 'publish',
    payload_hash: claim.payload_hash, applied_at: new Date().toISOString(), receipt_mac: '0'.repeat(64) };
  assert.equal((await one(privateDb, 'select editorial_private.cms_dispatch_ack($1,$2,$3::jsonb) as value',
    [forged, claim.claim_token, JSON.stringify(forgedReceipt)])).value, null, 'a forged receipt must not be acknowledged');
  await privateDb.query('reset role');
  await publicDb.query('set role azerdex_cms_delivery');
  const { claim_token: _t, is_compensation: _s, intent_created_at: _c, ...envelope } = claim;
  await assert.rejects(publicDb.query('select pub_admin.cms_apply($1::jsonb)', [JSON.stringify({ ...envelope, auth_mac: '0'.repeat(64) })]), /MAC mismatch/);
  assert.equal((await one(publicDb, 'select pub_admin.cms_receipt($1) as value', [forged])).value, null);
  await publicDb.query('reset role');
  assert.equal((await article('repair-forged-receipt')).published_revision_id, null, 'the pointer must not move without a verified receipt');
  assert.equal(await reader('repair-forged-receipt'), null);

  // ---- 1 + 3. one real worker pass at a time until the failing intent has been attempted (older fixture intents may consume earlier slots)
  let firstFailurePass = null;
  for (let pass = 1; pass <= 6 && !firstFailurePass; pass++) {
    const report = await main();
    if (report.failures.some((f) => f.intent_id === failing)) firstFailurePass = report;
  }
  assert.ok(firstFailurePass, 'the failing intent was never attempted');

  // the failure is isolated: reported, recorded with retry state and audit evidence ...
  assert.deepEqual(firstFailurePass.failures.filter((f) => f.intent_id === failing), [{ intent_id: failing, code: 'missing_asset' }]);
  const f1 = await ledger(failing);
  assert.equal(f1.state, 'retryable');
  assert.equal(f1.last_error_code, 'missing_asset');
  assert.equal(Number(f1.attempt), 1);
  const failingArticle = await article('repair-failing-delivery');
  assert.equal(failingArticle.published_revision_id, null);
  assert.equal(await reader('repair-failing-delivery'), null, 'a failed delivery must never become public');
  assert.equal(await auditCount('news.delivery.failure', failingArticle.article_id), 1);
  // ... and the UNRELATED intent, ordered after it, was delivered in the SAME pass
  assert.ok(firstFailurePass.timings.some((t) => t.intentId === unrelated), JSON.stringify(firstFailurePass.timings.map((t) => t.intentId)));
  assert.equal((await ledger(unrelated)).state, 'delivered');
  const g = await article('repair-unrelated-delivery');
  assert.equal(g.published_revision_id, g.current_revision_id);
  assert.equal(g.review_state, 'published');
  assert.equal((await reader('repair-unrelated-delivery')).revision_id, g.published_revision_id);

  // ---- 1. the highlighted publication: delivered with a signed receipt, pointer moved only after it, visible through the public reader
  assert.equal((await ledger(highlighted)).state, 'delivered', 'highlighted intent must be delivered by the worker');
  const h = await article('repair-highlighted');
  const hl = await ledger(highlighted);
  assert.match(hl.public_receipt.receipt_mac, /^[0-9a-f]{64}$/, 'the receipt is signed');
  assert.equal(String(hl.public_receipt.intent_id), highlighted);
  assert.equal(h.review_state, 'published');
  assert.equal(h.published_revision_id, h.current_revision_id);
  const publicRow = await reader('repair-highlighted');
  assert.equal(publicRow.revision_id, h.published_revision_id);
  assert.equal(publicRow.tombstone, false);
  assert.equal(publicRow.snapshot.classification, 'highlighted');
  const receipt = await one(publicDb, 'select pub_admin.cms_receipt($1) as value', [highlighted]);
  assert.equal(receipt.value.receipt_mac, hl.public_receipt.receipt_mac, 'public and private receipts agree');
  await publicDb.query('set role foreverdb_web_reader');
  assert.equal(Number((await one(publicDb, "select count(*) n from web_api.cms_list(50,0) as t(value) where value->>'slug'='repair-highlighted'")).n), 1);
  await publicDb.query('reset role');

  // ---- 3. retry state, idempotency: the next pass retries ONLY the failing intent, again in isolation, and delivers nothing twice
  const second = await main();
  assert.ok(second.failures.some((f) => f.intent_id === failing), 'the retryable intent must be retried');
  assert.ok(!second.timings.some((t) => t.intentId === unrelated || t.intentId === highlighted), 'a delivered intent must not be delivered again');
  const f2 = await ledger(failing);
  assert.equal(f2.state, 'retryable');
  assert.equal(Number(f2.attempt), 2, 'the retry count is preserved across passes');
  assert.equal(await auditCount('news.delivery.failure', failingArticle.article_id), 2, 'every failure leaves audit evidence');
  assert.equal(Number((await one(publicDb, 'select count(*) n from cms_pub.articles where article_id=$1', [g.article_id])).n), 1, 'exactly one public row for the unrelated article');
  assert.equal(Number((await one(publicDb, 'select generation from cms_pub.articles where article_id=$1', [g.article_id])).generation), Number(g.generation));
  console.log('repaired delivery worker (real databases): PASS');
} finally { await privateDb.end(); await publicDb.end(); }
