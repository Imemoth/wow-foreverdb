-- Helper for after.sql. Expects psql variables: :article (uuid), :slug, :appr (approver JWT claims), :c101.
-- Complete highlighted flow with a SECOND, independent approver; leaves the publication intent id in :v_intent.
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_create_draft(:'article'::uuid,:'slug',
  '{"title":"Repair variant article","summary":"A synthetic variant article for fail-closed approval tests.","body_markdown":"Variant body.","classification":"highlighted","featured":true}',
  gen_random_uuid());
reset role;
select current_revision_id as v_rev from editorial_private.articles where article_id=:'article'::uuid \gset
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_submit_review(:'article'::uuid,:'v_rev'::uuid,gen_random_uuid());
select set_config('request.jwt.claims',:'appr',false);
select public.fdb_cms_approve_highlighted(:'article'::uuid,:'v_rev'::uuid,gen_random_uuid());
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_publish_intent(:'article'::uuid,:'v_rev'::uuid,gen_random_uuid()) as v_intent \gset
reset role;
