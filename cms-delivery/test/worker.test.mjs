import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dispatchOnce, requireDisposable, validateEnvelope } from '../src/once.mjs';

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
