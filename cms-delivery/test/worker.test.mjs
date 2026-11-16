import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requireDisposable, validateEnvelope } from '../src/once.mjs';

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
