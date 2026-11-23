\set ON_ERROR_STOP on
-- Fixtures for cms-delivery/test/repair-worker.mjs (run AFTER the repair is applied and asserted).
\set c101 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}'
\set c104 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000104","session_id":"00000000-0000-0000-0000-000000000204","aal":"aal2","exp":4102444800}'

-- 709: a second highlighted article, used to prove that signed receipts are enforced on the highlighted path too.
\set article 00000000-0000-0000-0000-000000000709
\set slug repair-forged-receipt
\set appr :c104
\ir variant.sql

-- 710 (F): a normal article whose registry image does not exist on disk -> the worker records a RETRYABLE failure for it.
-- 711 (G): created after F, a perfectly valid article -> must be delivered in the SAME pass as F's failure.
insert into editorial_private.media_assets(asset_id,asset_version,path,content_sha256,rights_source,rights_license,attribution,verified_by,verified_at)
  values('00000000-0000-0000-0000-0000000007a1',1,'/content-images/repair-missing/never-shipped.png',pg_catalog.sha256(pg_catalog.convert_to('no such file','UTF8')),
    'synthetic source','test-only license','Synthetic author','00000000-0000-0000-0000-000000000101',clock_timestamp());
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000710','repair-failing-delivery',
  '{"title":"Failing delivery article","summary":"A synthetic article whose image file is missing from the asset root.","body_markdown":"Failing body.","classification":"normal","images":[{"asset_id":"00000000-0000-0000-0000-0000000007a1","alt":"A missing image"}]}',
  gen_random_uuid());
reset role;
select current_revision_id as f_rev from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000710' \gset
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_submit_review('00000000-0000-0000-0000-000000000710',:'f_rev'::uuid,gen_random_uuid());
select public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000710',:'f_rev'::uuid,gen_random_uuid());
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000711','repair-unrelated-delivery',
  '{"title":"Unrelated delivery article","summary":"A synthetic, valid article delivered in the same pass as a failing one.","body_markdown":"Unrelated body.","classification":"normal"}',
  gen_random_uuid());
reset role;
select current_revision_id as g_rev from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000711' \gset
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_submit_review('00000000-0000-0000-0000-000000000711',:'g_rev'::uuid,gen_random_uuid());
select public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000711',:'g_rev'::uuid,gen_random_uuid());
reset role;
