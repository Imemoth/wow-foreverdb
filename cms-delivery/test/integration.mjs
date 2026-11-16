import assert from 'node:assert/strict';
import pg from 'pg';
import { main } from '../src/once.mjs';

const article = '00000000-0000-0000-0000-000000000401';
const privateDb = new pg.Client({ connectionString: process.env.FDB_CMS_PRIVATE_URL });
const publicDb = new pg.Client({ connectionString: process.env.FDB_CMS_PUBLIC_URL });
await privateDb.connect(); await publicDb.connect();
try {
  const intent = (await privateDb.query(`select intent_id from editorial_private.publication_intents
    where request_id='00000000-0000-0000-0000-000000000503'`)).rows[0].intent_id;
  await privateDb.query('set role azerdex_cms_dispatch');
  assert.equal((await privateDb.query('select editorial_private.cms_dispatch_qualify($1) as ok', [intent])).rows[0].ok, true);
  const claim = (await privateDb.query('select editorial_private.cms_dispatch_claim($1) as value', [intent])).rows[0].value;
  const forged = { intent_id: intent, article_id: article, generation: claim.generation,
    kind: 'publish', payload_hash: claim.payload_hash, applied_at: new Date().toISOString(),
    receipt_mac: '0'.repeat(64) };
  assert.equal((await privateDb.query('select editorial_private.cms_dispatch_ack($1,$2,$3::jsonb) as value',
    [intent, claim.claim_token, JSON.stringify(forged)])).rows[0].value, null);
  await privateDb.query('reset role');
  await publicDb.query('set role azerdex_cms_delivery');
  const { claim_token: _token, ...envelope } = claim;
  await assert.rejects(publicDb.query('select pub_admin.cms_apply($1::jsonb)',
    [JSON.stringify({ ...envelope, auth_mac: '0'.repeat(64) })]), /MAC mismatch/);
  assert.equal((await publicDb.query('select pub_admin.cms_receipt($1) as value', [intent])).rows[0].value, null);
  await publicDb.query('select pub_admin.cms_apply($1::jsonb)', [JSON.stringify(envelope)]);
  await publicDb.query('reset role');
  await privateDb.query(`update editorial_private.delivery_state
    set lease_until=pg_catalog.clock_timestamp()-interval '1 second' where intent_id=$1`, [intent]);
  const report = await main();
  assert.ok(report.delivered >= 1, JSON.stringify(report));
  const p = await privateDb.query('select published_revision_id,review_state from editorial_private.articles where article_id=$1', [article]);
  const u = await publicDb.query('select revision_id,tombstone from cms_pub.articles where article_id=$1', [article]);
  assert.equal(p.rows[0].review_state, 'published');
  assert.equal(p.rows[0].published_revision_id, u.rows[0].revision_id);
  assert.equal(u.rows[0].tombstone, false);
  await publicDb.query('set role foreverdb_web_reader');
  const liveReader = await publicDb.query('select web_api.cms_article($1) as value', ['cms-test-article']);
  assert.equal(liveReader.rows[0].value.revision_id, p.rows[0].published_revision_id);
  await publicDb.query('reset role');
  assert.equal((await main()).delivered, 0, 'replay must not create a new delivery');
  await privateDb.query(`update admin_private.direct_grants set status='revoked',
    revoked_at=pg_catalog.clock_timestamp() where user_id='00000000-0000-0000-0000-000000000101'
    and permission_key='news.article.publish' and scope_id=$1`, [article]);
  assert.ok((await main()).compensated >= 1, 'revocation must enqueue an ordered unpublish');
  assert.ok((await main()).delivered >= 1, 'compensating tombstone must be delivered');
  const tombstone = await publicDb.query('select generation,tombstone,revision_id from cms_pub.articles where article_id=$1', [article]);
  assert.equal(tombstone.rows[0].tombstone, true);
  assert.equal(tombstone.rows[0].revision_id, null);
  assert.equal(Number(tombstone.rows[0].generation), 2);
  await publicDb.query('set role foreverdb_web_reader');
  assert.equal((await publicDb.query('select web_api.cms_article($1) as value', ['cms-test-article'])).rows[0].value.tombstone, true);
  assert.equal((await publicDb.query('select count(*) as n from web_api.cms_list(50,0) as t(value) where value->>\'slug\'=$1',
    ['cms-test-article'])).rows[0].n, '0');
  await publicDb.query('reset role');
  const final = await privateDb.query('select published_revision_id,review_state from editorial_private.articles where article_id=$1', [article]);
  assert.equal(final.rows[0].published_revision_id, null);
  assert.equal(final.rows[0].review_state, 'unpublished');
  console.log('ADM-03C two-database worker: PASS');
} finally { await privateDb.end(); await publicDb.end(); }
