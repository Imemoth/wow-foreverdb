import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { classifyFailure, dispatchOnce, requireDisposable, validateEnvelope } from '../src/once.mjs';

const local = {
  FDB_CMS_DISPOSABLE: '1', FOREVERDB_DEPLOYMENT: 'local',
  FDB_CMS_CI: '1',
  FDB_CMS_PRIVATE_URL: 'postgres://test@127.0.0.1:5432/private',
  FDB_CMS_PUBLIC_URL: 'postgres://test@127.0.0.1:5432/public',
};
test('worker refuses hosted or shared databases', () => {
  assert.doesNotThrow(() => requireDisposable(local));
  assert.throws(() => requireDisposable({ ...local, VERCEL_ENV: 'preview' }));
  assert.throws(() => requireDisposable({ ...local, FDB_CMS_PUBLIC_URL: local.FDB_CMS_PRIVATE_URL }));
  assert.throws(() => requireDisposable({ ...local, FDB_CMS_PRIVATE_URL: 'postgres://test@production.example/private' }));
});
test('uncertain public commit preserves claim for receipt recovery', async () => {
  const id = '00000000-0000-0000-0000-000000000001';
  const calls = [];
  const privateDb = { async query(sql) {
    calls.push(sql);
    if (sql.includes('cms_dispatch_candidates')) return { rows: [{ intent_id: id }] };
    if (sql.includes('cms_dispatch_qualify')) return { rows: [{ value: true }] };
    if (sql.includes('cms_dispatch_claim')) return { rows: [{ value: {
      intent_id: id, article_id: id, claim_token: id, kind: 'unpublish',
      generation: 1, slug: 'test-slug', payload_hash: 'a'.repeat(64),
    } }] };
    if (sql.includes('cms_dispatch_recheck')) return { rows: [{ value: true }] };
    throw new Error(`unexpected private query: ${sql}`);
  } };
  const publicDb = { async query(sql) {
    if (sql.includes('cms_receipt')) return { rows: [{ value: null }] };
    if (sql.includes('cms_apply')) throw new Error('connection_lost_after_commit');
    throw new Error(`unexpected public query: ${sql}`);
  } };
  await assert.rejects(dispatchOnce(privateDb, publicDb, '/tmp'), /connection_lost_after_commit/);
  assert.ok(!calls.some((sql) => sql.includes('cms_dispatch_fail')));
  assert.ok(!calls.some((sql) => sql.includes('cms_dispatch_cancel')));
});
test('asset byte hash and rights are mandatory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cms-assets-'));
  try {
    const path = join(root, 'content-images');
    await import('node:fs/promises').then((fs) => fs.mkdir(path));
    const bytes = Buffer.from('disposable image bytes');
    await writeFile(join(path, 'sample.webp'), bytes);
    const asset = { path: '/content-images/sample.webp',
      content_sha256: createHash('sha256').update(bytes).digest('hex'),
      rights_source: 'synthetic test', rights_license: 'test fixture', attribution: 'test fixture' };
    const envelope = { intent_id: '00000000-0000-0000-0000-000000000001',
      article_id: '00000000-0000-0000-0000-000000000002',
      claim_token: '00000000-0000-0000-0000-000000000003', generation: 1,
      slug: 'test-slug', kind: 'publish', revision_id: '00000000-0000-0000-0000-000000000004',
      revision_hash: 'a'.repeat(64), payload_hash: 'b'.repeat(64),
      snapshot: { body_markdown: 'Safe text', related_links: ['https://example.com/news'], images: [asset] } };
    await validateEnvelope(envelope, root);
    await assert.rejects(validateEnvelope({ ...envelope, snapshot: { ...envelope.snapshot,
      images: [{ ...asset, content_sha256: '0'.repeat(64) }] } }, root), /asset_hash_mismatch/);
    await assert.rejects(validateEnvelope({ ...envelope, snapshot: { ...envelope.snapshot,
      related_links: ['javascript:alert(1)'] } }, root), /unsafe_link/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---- ADM-03C hotfix: per-intent failure isolation ----------------------------------------------------------------------------------------------
const uuid = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const publishClaim = (n, extra = {}) => ({ intent_id: uuid(n), article_id: uuid(1000 + n), claim_token: uuid(2000 + n), kind: 'unpublish',
  generation: 1, slug: `slug-${n}`, payload_hash: 'a'.repeat(64), ...extra });
/** In-memory private/public databases. `behaviour[n]` may override qualify/claim/apply/ack per intent number. */
function fakeDbs(order, behaviour = {}) {
  const log = [];
  const num = (sql, args) => order.find((n) => args?.some((a) => a === uuid(n)));
  const privateDb = { async query(sql, args = []) {
    log.push([sql.match(/cms_[a-z_]+/)?.[0], ...args]);
    if (sql.includes('cms_dispatch_candidates')) return { rows: order.map((n) => ({ intent_id: uuid(n) })) };
    if (sql.includes('cms_dispatch_reconcile_candidates')) return { rows: [] };
    const n = num(sql, args);
    const b = behaviour[n] ?? {};
    if (sql.includes('cms_dispatch_qualify')) { if (b.qualify) throw b.qualify; return { rows: [{ value: true }] }; }
    if (sql.includes('cms_dispatch_claim')) return { rows: [{ value: publishClaim(n, b.claim) }] };
    if (sql.includes('cms_dispatch_recheck')) return { rows: [{ value: true }] };
    if (sql.includes('cms_dispatch_fail')) return { rows: [{ value: true }] };
    if (sql.includes('cms_dispatch_ack')) return { rows: [{ value: b.ack ?? { acknowledged: true } }] };
    throw new Error(`unexpected private query: ${sql}`);
  } };
  const receipts = new Map();
  const publicDb = { async query(sql, args = []) {
    log.push([sql.match(/cms_[a-z_]+/)?.[0], ...args]);
    if (sql.includes('cms_receipt')) return { rows: [{ value: receipts.get(args[0]) ?? null }] };
    if (sql.includes('cms_apply')) {
      const p = JSON.parse(args[0]);
      const n = order.find((k) => uuid(k) === p.intent_id);
      if (behaviour[n]?.apply) throw behaviour[n].apply;
      const receipt = { intent_id: p.intent_id, article_id: p.article_id, generation: p.generation, kind: p.kind, payload_hash: p.payload_hash, applied_at: '2026-01-01T00:00:00Z' };
      receipts.set(p.intent_id, behaviour[n]?.badReceipt ? { ...receipt, payload_hash: 'f'.repeat(64) } : receipt);
      return { rows: [{ value: receipt }] };
    }
    throw new Error(`unexpected public query: ${sql}`);
  } };
  return { privateDb, publicDb, log };
}
const calls = (log, name) => log.filter(([n]) => n === name);

test('a failed delivery followed by an unrelated successful delivery in the SAME pass', async () => {
  // intent 1 carries an invalid claim (content validation fails before any public write); intent 2 is fine
  const { privateDb, publicDb, log } = fakeDbs([1, 2], { 1: { claim: { payload_hash: 'not-a-hash' } } });
  const report = await dispatchOnce(privateDb, publicDb, '/tmp');
  assert.equal(report.candidates, 2);
  assert.equal(report.delivered, 1, 'the unrelated intent must be delivered');
  assert.equal(report.failures.length, 1);
  assert.deepEqual(report.failures[0], { intent_id: uuid(1), code: 'invalid_claim' });
  // the failed intent keeps its retry state: recorded with its own claim token, never applied publicly, never acknowledged
  assert.deepEqual(calls(log, 'cms_dispatch_fail'), [['cms_dispatch_fail', uuid(1), uuid(2001), 'invalid_claim']]);
  assert.deepEqual(calls(log, 'cms_apply').map((c) => JSON.parse(c[1]).intent_id), [uuid(2)]);
  assert.deepEqual(calls(log, 'cms_dispatch_ack').map((c) => c[1]), [uuid(2)]);
  assert.equal(report.timings.length, 1);
  assert.equal(report.timings[0].intentId, uuid(2));
});

test('order is preserved: intents are processed sequentially in candidate order (compensation-first ordering stays with the database)', async () => {
  const { privateDb, publicDb, log } = fakeDbs([3, 1, 2], { 1: { claim: { payload_hash: 'bad' } } });
  await dispatchOnce(privateDb, publicDb, '/tmp');
  assert.deepEqual(calls(log, 'cms_dispatch_qualify').map((c) => c[1]), [uuid(3), uuid(1), uuid(2)]);
  assert.deepEqual(calls(log, 'cms_apply').map((c) => JSON.parse(c[1]).intent_id), [uuid(3), uuid(2)]);
});

test('a deterministic database error while evaluating ONE intent (before any claim) is isolated and records nothing', async () => {
  const sqlBug = Object.assign(new Error('column reference "ap.approval_id" is ambiguous'), { code: '42702' });
  const { privateDb, publicDb, log } = fakeDbs([1, 2], { 1: { qualify: sqlBug } });
  const report = await dispatchOnce(privateDb, publicDb, '/tmp');
  assert.equal(report.delivered, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0].code, 'delivery_failure');
  assert.equal(calls(log, 'cms_dispatch_fail').length, 0, 'no claim exists, so there is no claim token to fail with');
  assert.equal(calls(log, 'cms_apply').length, 1);
});

test('infrastructure failures still abort the whole pass and never continue to later intents', async () => {
  for (const error of [
    Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }),
    Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
    Object.assign(new Error('password authentication failed'), { code: '28P01' }),
    Object.assign(new Error('could not connect to server'), { code: '08006' }),
    Object.assign(new Error('permission denied for function'), { code: '42501' }),
    new Error('CMS delivery database role mismatch'),
    new Error('Connection terminated unexpectedly'),
  ]) {
    const { privateDb, publicDb, log } = fakeDbs([1, 2], { 1: { qualify: error } });
    await assert.rejects(dispatchOnce(privateDb, publicDb, '/tmp'), (e) => e === error);
    assert.equal(calls(log, 'cms_apply').length, 0, `no later intent may be delivered after: ${error.message}`);
    assert.equal(calls(log, 'cms_dispatch_qualify').length, 1);
  }
});

test('security-critical failures abort the pass (a receipt that does not match what was applied)', async () => {
  const { privateDb, publicDb, log } = fakeDbs([1, 2], { 1: { badReceipt: true } });
  await assert.rejects(dispatchOnce(privateDb, publicDb, '/tmp'), /public_receipt_mismatch/);
  assert.equal(calls(log, 'cms_dispatch_fail').length, 0, 'an uncertain public outcome must keep its claim for receipt recovery');
  assert.equal(calls(log, 'cms_dispatch_qualify').length, 1, 'the second intent must not be touched');
});

test('an uncertain public outcome (error after the public write started) aborts and keeps the claim', async () => {
  const lost = new Error('connection_lost_after_commit');
  const { privateDb, publicDb, log } = fakeDbs([1, 2], { 1: { apply: lost } });
  await assert.rejects(dispatchOnce(privateDb, publicDb, '/tmp'), (e) => e === lost && e.publicAttempted === true);
  assert.equal(calls(log, 'cms_dispatch_fail').length, 0);
  assert.equal(calls(log, 'cms_dispatch_cancel').length, 0);
  assert.equal(calls(log, 'cms_dispatch_qualify').length, 1);
});

test('a pending private acknowledgement is treated as an uncertain outcome, not as a retryable content failure', async () => {
  const { privateDb, publicDb, log } = fakeDbs([1, 2], { 1: { ack: { acknowledged: false } } });
  await assert.rejects(dispatchOnce(privateDb, publicDb, '/tmp'), /private_ack_pending/);
  assert.equal(calls(log, 'cms_dispatch_fail').length, 0);
});

test('failure classification table', () => {
  const c = (code, message = 'x') => classifyFailure(Object.assign(new Error(message), { code }));
  assert.equal(c('42501'), 'fatal');
  assert.equal(c('57P01'), 'fatal');
  assert.equal(c('08006'), 'fatal');
  assert.equal(c('53300'), 'fatal');
  assert.equal(c('ECONNRESET'), 'fatal');
  assert.equal(c('XX000'), 'fatal');
  assert.equal(classifyFailure(new Error('public_receipt_after_revoke')), 'fatal');
  assert.equal(classifyFailure(new Error('public_receipt_mismatch')), 'fatal');
  for (const message of ['invalid_claim', 'unsafe_markdown', 'unsafe_link', 'invalid_asset', 'missing_asset', 'asset_hash_mismatch', 'invalid_revision', 'invalid_snapshot']) {
    assert.equal(classifyFailure(new Error(message)), 'intent', message);
  }
  assert.equal(c('42702'), 'intent');
  assert.equal(c('22023'), 'intent');
  assert.equal(c('P0001'), 'intent');
});
