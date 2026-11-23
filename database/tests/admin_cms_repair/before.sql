\set ON_ERROR_STOP on
-- ADM-03B/03C hotfix, phase 1 (BEFORE migration 0028): synthetic fixtures on top of the lifecycle data, then a reproduction of both confirmed defects.
-- Disposable only. Users: 101 Editor (author, holds scoped publish grants), 104 and 105 Administrators (independent approvers). The lifecycle
-- fixtures leave 102 demoted to Editor, so it is not used here.
insert into auth.users(id,email_confirmed_at) select ('00000000-0000-0000-0000-000000000'||n)::uuid,clock_timestamp() from unnest(array['104','105']) n;
insert into auth.mfa_factors(id,user_id,factor_type,status)
  select ('00000000-0000-0000-0000-000000000'||(n::int+200))::uuid,('00000000-0000-0000-0000-000000000'||n)::uuid,'totp','verified' from unnest(array['104','105']) n;
insert into auth.sessions(id,user_id,factor_id,aal)
  select ('00000000-0000-0000-0000-000000000'||(n::int+100))::uuid,('00000000-0000-0000-0000-000000000'||n)::uuid,
         ('00000000-0000-0000-0000-000000000'||(n::int+200))::uuid,'aal2' from unnest(array['104','105']) n;
insert into auth.refresh_tokens(session_id) select ('00000000-0000-0000-0000-000000000'||(n::int+100))::uuid from unnest(array['104','105']) n;
insert into auth.mfa_amr_claims(session_id,authentication_method,updated_at)
  select ('00000000-0000-0000-0000-000000000'||(n::int+100))::uuid,'totp',clock_timestamp() from unnest(array['104','105']) n;
insert into admin_private.staff_subjects(user_id,status) select ('00000000-0000-0000-0000-000000000'||n)::uuid,'active' from unnest(array['104','105']) n;
insert into admin_private.role_assignments(user_id,role_name,policy_version_id,environment_scope,scope_kind,starts_at,expires_at,review_due_at,status,approved_by,reason)
  select ('00000000-0000-0000-0000-000000000'||n)::uuid,'Administrator',1,'staging','global',clock_timestamp()-interval '1 minute',
    clock_timestamp()+interval '29 days',clock_timestamp()+interval '30 days','active','00000000-0000-0000-0000-000000000101','repair fixture' from unnest(array['104','105']) n;
-- Scoped publish/unpublish grants of the author for every article the repair tests publish.
insert into admin_private.direct_grants(user_id,permission_key,policy_version_id,environment_scope,scope_kind,scope_id,starts_at,expires_at,status,approved_by,reason)
select '00000000-0000-0000-0000-000000000101',p,1,'staging','article',a,clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days','active','00000000-0000-0000-0000-000000000102','repair fixture'
from unnest(array['00000000-0000-0000-0000-000000000701','00000000-0000-0000-0000-000000000702','00000000-0000-0000-0000-000000000703',
  '00000000-0000-0000-0000-000000000704','00000000-0000-0000-0000-000000000705','00000000-0000-0000-0000-000000000706',
  '00000000-0000-0000-0000-000000000707','00000000-0000-0000-0000-000000000708','00000000-0000-0000-0000-000000000709',
  '00000000-0000-0000-0000-000000000710','00000000-0000-0000-0000-000000000711']) a,
  unnest(array['news.article.publish','news.article.unpublish']) p;

create schema repairtest;
grant usage on schema repairtest to authenticated, azerdex_cms_dispatch;
create table repairtest.fp as
  select p.oid::regprocedure::text sig, pg_get_userbyid(p.proowner) owner, coalesce(p.proacl::text,'') acl, p.prosecdef secdef, coalesce(p.proconfig,'{}'::text[]) config,
         p.prosrc src, md5(p.prosrc) src_md5
  from pg_proc p where p.oid in ('editorial_private.run_action(text,uuid,uuid,jsonb,text,text,uuid)'::regprocedure,'editorial_private.delivery_eligible(uuid)'::regprocedure);
create table repairtest.state(k text primary key, v text);
insert into repairtest.state values
  ('executor_member',pg_has_role('fdb_migrator','admin_executor','MEMBER')::text),
  ('executor_create',has_schema_privilege('admin_executor','editorial_private','CREATE')::text);
create function repairtest.fail(p text) returns void language plpgsql as $$ begin raise exception 'REPAIR TEST FAILED: %',p; end $$;

\set c101 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}'
\set c104 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000104","session_id":"00000000-0000-0000-0000-000000000204","aal":"aal2","exp":4102444800}'
\set c105 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000105","session_id":"00000000-0000-0000-0000-000000000205","aal":"aal2","exp":4102444800}'

-- ---- Defect 1: a stale edit raises 40001 (the code PostgREST retries forever).
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000701','repair-stale',
  '{"title":"Repair stale article","summary":"A synthetic article for the stale revision regression.","body_markdown":"First body.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000801');
reset role;
select current_revision_id as s_r1 from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000701' \gset
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_edit_draft('00000000-0000-0000-0000-000000000701',:'s_r1',
  '{"title":"Repair stale article v2","summary":"A synthetic article for the stale revision regression.","body_markdown":"Second body.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000802');
\set ON_ERROR_STOP off
select public.fdb_cms_edit_draft('00000000-0000-0000-0000-000000000701',:'s_r1',
  '{"title":"Stale attempt","summary":"A synthetic article for the stale revision regression.","body_markdown":"Stale body.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000803');
\set ON_ERROR_STOP on
reset role;
insert into repairtest.state values('stale_edit_sqlstate_before',:'LAST_ERROR_SQLSTATE');

-- ---- Defect 2: a highlighted publication cannot even be qualified (ambiguous ap.approval_id).
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000702','repair-highlighted',
  '{"title":"Repair highlighted article","summary":"A synthetic highlighted article for the delivery regression.","body_markdown":"Highlighted body.","classification":"highlighted","featured":true}',
  '00000000-0000-0000-0000-000000000811');
reset role;
select current_revision_id as h_r1 from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000702' \gset
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_submit_review('00000000-0000-0000-0000-000000000702',:'h_r1','00000000-0000-0000-0000-000000000812');
select set_config('request.jwt.claims',:'c104',false);
select public.fdb_cms_approve_highlighted('00000000-0000-0000-0000-000000000702',:'h_r1','00000000-0000-0000-0000-000000000813');
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000702',:'h_r1','00000000-0000-0000-0000-000000000814');
reset role;
select intent_id as h_intent from editorial_private.publication_intents where request_id='00000000-0000-0000-0000-000000000814' \gset
update editorial_private.delivery_control set enabled=true, reviewed_config_id='00000000-0000-0000-0000-000000000901' where singleton;
set role azerdex_cms_dispatch;
\set ON_ERROR_STOP off
select editorial_private.cms_dispatch_qualify(:'h_intent'::uuid);
\set ON_ERROR_STOP on
reset role;
insert into repairtest.state values('highlighted_qualify_sqlstate_before',:'LAST_ERROR_SQLSTATE');
