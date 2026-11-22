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
  const { claim_token: _token, is_compensation: _system,
    intent_created_at: _created, ...envelope } = claim;
  await assert.rejects(publicDb.query('select pub_admin.cms_apply($1::jsonb)',
    [JSON.stringify({ ...envelope, auth_mac: '0'.repeat(64) })]), /MAC mismatch/);
  assert.equal((await publicDb.query('select pub_admin.cms_receipt($1) as value', [intent])).rows[0].value, null);
  await publicDb.query('select pub_admin.cms_apply($1::jsonb)', [JSON.stringify(envelope)]);
  await publicDb.query('reset role');
  await privateDb.query(`update editorial_private.delivery_state
    set lease_until=pg_catalog.clock_timestamp()-interval '1 second' where intent_id=$1`, [intent]);
  await privateDb.query(`update admin_private.direct_grants set status='revoked',
    revoked_at=pg_catalog.clock_timestamp() where user_id='00000000-0000-0000-0000-000000000101'
    and permission_key='news.article.publish' and scope_id=$1`, [article]);
  const report = await main();
  assert.ok(report.delivered >= 1, JSON.stringify(report));
  assert.ok(report.compensated >= 1, 'in-flight publication revoke must queue compensation');
  assert.ok(report.timings.some((timing) => timing.recovered && timing.publicAppliedAt));
  const p = await privateDb.query('select published_revision_id,review_state from editorial_private.articles where article_id=$1', [article]);
  const u = await publicDb.query('select revision_id,tombstone from cms_pub.articles where article_id=$1', [article]);
  assert.equal(p.rows[0].review_state, 'unpublish_pending');
  assert.equal(p.rows[0].published_revision_id, u.rows[0].revision_id);
  assert.equal(u.rows[0].tombstone, false);
  await publicDb.query('set role foreverdb_web_reader');
  const liveReader = await publicDb.query('select web_api.cms_article($1) as value', ['cms-test-article']);
  assert.equal(liveReader.rows[0].value.revision_id, p.rows[0].published_revision_id);
  await publicDb.query('reset role');
  const compensationReport = await main();
  assert.ok(compensationReport.delivered >= 1, 'compensating tombstone must be delivered');
  assert.ok(compensationReport.timings.some((timing) =>
    timing.compensation && timing.publicAppliedAt && timing.privateAckAt));
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
  assert.equal((await main()).delivered, 0, 'replay must not create a new delivery');

  // A completed publication survives later grant loss. A revoked, unclaimed
  // unpublish is cancelled and audited, preserving the prior public revision.
  const stuck = '00000000-0000-0000-0000-000000000413';
  await privateDb.query(`insert into admin_private.direct_grants(user_id,permission_key,
    policy_version_id,environment_scope,scope_kind,scope_id,starts_at,expires_at,
    status,approved_by,reason) values
    ('00000000-0000-0000-0000-000000000101','news.article.publish',1,'staging',
     'article',$1,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days',
     'active','00000000-0000-0000-0000-000000000102','disposable fixture'),
    ('00000000-0000-0000-0000-000000000101','news.article.unpublish',1,'staging',
     'article',$1,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days',
     'active','00000000-0000-0000-0000-000000000102','disposable fixture')`, [stuck]);
  await privateDb.query('set role authenticated');
  await privateDb.query(`set request.jwt.claims = '{"role":"authenticated",
    "sub":"00000000-0000-0000-0000-000000000101",
    "session_id":"00000000-0000-0000-0000-000000000201",
    "aal":"aal2","exp":4102444800}'`);
  await privateDb.query(`select public.fdb_cms_create_draft($1,$2,$3::jsonb,$4)`,
    [stuck, 'cms-stuck-unpublish', JSON.stringify({ title: 'Stuck unpublish fixture',
      summary: 'A synthetic article proving revoked unpublish safety.',
      body_markdown: 'A safe disposable test body.', classification: 'normal' }),
    '00000000-0000-0000-0000-000000000601']);
  const revision = (await privateDb.query(
    "select (public.fdb_cms_article($1)->>'current_revision_id')::uuid as current_revision_id",
    [stuck])).rows[0].current_revision_id;
  await privateDb.query('select public.fdb_cms_submit_review($1,$2,$3)',
    [stuck, revision, '00000000-0000-0000-0000-000000000602']);
  await privateDb.query('select public.fdb_cms_publish_intent($1,$2,$3)',
    [stuck, revision, '00000000-0000-0000-0000-000000000603']);
  await privateDb.query('reset role');
  assert.ok((await main()).delivered >= 1, 'new article must publish first');
  await privateDb.query(`update admin_private.direct_grants set status='revoked',
    revoked_at=clock_timestamp() where user_id='00000000-0000-0000-0000-000000000101'
    and permission_key='news.article.publish' and scope_id=$1`, [stuck]);
  assert.equal((await main()).compensated, 0, 'completed publication must not depend on an old grant');
  assert.equal((await publicDb.query('select tombstone from cms_pub.articles where article_id=$1',
    [stuck])).rows[0].tombstone, false);
  await privateDb.query(`update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '20 minutes'
    where session_id='00000000-0000-0000-0000-000000000201' and authentication_method='totp'`);
  assert.equal((await main()).compensated, 0, 'completed publication must survive later TOTP freshness expiry');
  await privateDb.query(`update auth.mfa_amr_claims set updated_at=clock_timestamp()
    where session_id='00000000-0000-0000-0000-000000000201' and authentication_method='totp'`);
  await privateDb.query('set role authenticated');
  await privateDb.query('select public.fdb_cms_unpublish_intent($1,$2)',
    [stuck, '00000000-0000-0000-0000-000000000604']);
  await privateDb.query('reset role');
  await privateDb.query(`update admin_private.direct_grants set status='revoked',
    revoked_at=clock_timestamp() where user_id='00000000-0000-0000-0000-000000000101'
    and permission_key='news.article.unpublish' and scope_id=$1`, [stuck]);
  const cancelledUnpublish = await main();
  assert.ok(cancelledUnpublish.cancelled >= 1, 'unclaimed revoked unpublish must be cancelled');
  assert.equal(cancelledUnpublish.compensated, 0);
  const safe = await publicDb.query('select generation,tombstone from cms_pub.articles where article_id=$1', [stuck]);
  assert.equal(Number(safe.rows[0].generation), 1);
  assert.equal(safe.rows[0].tombstone, false);
  const privateStuck = await privateDb.query('select published_revision_id,review_state from editorial_private.articles where article_id=$1',
    [stuck]);
  assert.ok(privateStuck.rows[0].published_revision_id);
  assert.equal(privateStuck.rows[0].review_state, 'delivery_failed');
  assert.equal((await privateDb.query(`select state from editorial_private.delivery_state
    where article_id=$1 and generation=2`, [stuck])).rows[0].state, 'cancelled');

  // A later intent fences a claim that was already issued but not delivered.
  const superseded = '00000000-0000-0000-0000-000000000414';
  await privateDb.query(`insert into admin_private.direct_grants(user_id,permission_key,
    policy_version_id,environment_scope,scope_kind,scope_id,starts_at,expires_at,
    status,approved_by,reason) values
    ('00000000-0000-0000-0000-000000000101','news.article.publish',1,'staging',
     'article',$1,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days',
     'active','00000000-0000-0000-0000-000000000102','disposable fixture'),
    ('00000000-0000-0000-0000-000000000101','news.article.unpublish',1,'staging',
     'article',$1,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days',
     'active','00000000-0000-0000-0000-000000000102','disposable fixture')`, [superseded]);
  await privateDb.query('set role authenticated');
  await privateDb.query('select public.fdb_cms_create_draft($1,$2,$3::jsonb,$4)',
    [superseded, 'cms-superseded-claim', JSON.stringify({ title: 'Superseded claim fixture',
      summary: 'A synthetic article proving old dispatch fencing.',
      body_markdown: 'A safe disposable test body.', classification: 'normal' }),
    '00000000-0000-0000-0000-000000000611']);
  const rev414 = (await privateDb.query(
    "select (public.fdb_cms_article($1)->>'current_revision_id')::uuid as value", [superseded])).rows[0].value;
  await privateDb.query('select public.fdb_cms_submit_review($1,$2,$3)',
    [superseded, rev414, '00000000-0000-0000-0000-000000000612']);
  const oldIntent = (await privateDb.query('select public.fdb_cms_publish_intent($1,$2,$3) as value',
    [superseded, rev414, '00000000-0000-0000-0000-000000000613'])).rows[0].value;
  await privateDb.query('reset role');
  await privateDb.query('set role azerdex_cms_dispatch');
  assert.equal((await privateDb.query('select editorial_private.cms_dispatch_qualify($1) as value',
    [oldIntent])).rows[0].value, true);
  const oldClaim = (await privateDb.query('select editorial_private.cms_dispatch_claim($1) as value',
    [oldIntent])).rows[0].value;
  await privateDb.query('reset role');
  await privateDb.query('set role authenticated');
  await privateDb.query('select public.fdb_cms_unpublish_intent($1,$2)',
    [superseded, '00000000-0000-0000-0000-000000000614']);
  await privateDb.query('reset role');
  assert.equal((await privateDb.query('select state from editorial_private.delivery_state where intent_id=$1',
    [oldIntent])).rows[0].state, 'superseded');
  assert.equal((await privateDb.query(`select count(*)::int as n from admin_private.staff_audit_events
    where action_key='news.delivery.supersede' and resource_key=$1`,
    [`article:${superseded}`])).rows[0].n, 1);
  assert.ok((await main()).delivered >= 1, 'newer unpublish must become the tombstone');
  await publicDb.query('set role azerdex_cms_delivery');
  const { claim_token: _oldToken, is_compensation: _oldSystem,
    intent_created_at: _oldCreated, ...oldEnvelope } = oldClaim;
  await assert.rejects(publicDb.query('select pub_admin.cms_apply($1::jsonb)',
    [JSON.stringify(oldEnvelope)]), /stale or conflicting CMS generation/);
  await publicDb.query('reset role');
  const supersededPublic = await publicDb.query(
    'select generation,tombstone from cms_pub.articles where article_id=$1', [superseded]);
  assert.equal(Number(supersededPublic.rows[0].generation), 2);
  assert.equal(supersededPublic.rows[0].tombstone, true);
  console.log('ADM-03C two-database worker: PASS');
} finally { await privateDb.end(); await publicDb.end(); }
