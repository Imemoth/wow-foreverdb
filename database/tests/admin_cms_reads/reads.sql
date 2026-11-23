\set ON_ERROR_STOP on
-- ADM-04 read RPCs (0027). Synthetic, disposable-only activation; never run against hosted Auth.
-- Users: 101 Editor (author), 102 Owner, 103 ordinary account, 104 Administrator, 105 Moderator with an
-- Editor assignment scoped to ONE article, 106 Editor that gets suspended.
insert into auth.users(id,email_confirmed_at) select ('00000000-0000-0000-0000-000000000'||n)::uuid,clock_timestamp()
  from unnest(array['101','102','103','104','105','106']) n;
insert into auth.mfa_factors(id,user_id,factor_type,status)
  select ('00000000-0000-0000-0000-000000000'||(n::int+200))::uuid,('00000000-0000-0000-0000-000000000'||n)::uuid,'totp','verified'
  from unnest(array['101','102','103','104','105','106']) n;
-- sessions 3xx belong to users 1xx (session 307 is a second session of user 101, revoked later)
insert into auth.sessions(id,user_id,factor_id,aal)
  select ('00000000-0000-0000-0000-000000000'||(n::int+200))::uuid,('00000000-0000-0000-0000-000000000'||n)::uuid,
         ('00000000-0000-0000-0000-000000000'||(n::int+200))::uuid,'aal2'
  from unnest(array['101','102','103','104','105','106']) n;
insert into auth.sessions(id,user_id,factor_id,aal) values
  ('00000000-0000-0000-0000-000000000307','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000301','aal2');
insert into auth.refresh_tokens(session_id)
  select id from auth.sessions;
insert into auth.mfa_amr_claims(session_id,authentication_method,updated_at)
  select id,'totp',clock_timestamp() from auth.sessions;
insert into admin_private.staff_subjects(user_id,status) values
 ('00000000-0000-0000-0000-000000000101','active'),('00000000-0000-0000-0000-000000000102','active'),
 ('00000000-0000-0000-0000-000000000104','active'),('00000000-0000-0000-0000-000000000105','active'),
 ('00000000-0000-0000-0000-000000000106','active');
insert into admin_private.role_assignments(user_id,role_name,policy_version_id,
 environment_scope,scope_kind,starts_at,expires_at,review_due_at,status,approved_by,reason)
select u,r,1,'staging','global',clock_timestamp()-interval '1 minute',
  case when r='Owner' then null else clock_timestamp()+interval '29 days' end,
  clock_timestamp()+interval '30 days','active',a,'fixture'
from (values
 ('00000000-0000-0000-0000-000000000101'::uuid,'Editor','00000000-0000-0000-0000-000000000102'::uuid),
 ('00000000-0000-0000-0000-000000000102'::uuid,'Owner','00000000-0000-0000-0000-000000000101'::uuid),
 ('00000000-0000-0000-0000-000000000104'::uuid,'Administrator','00000000-0000-0000-0000-000000000102'::uuid),
 ('00000000-0000-0000-0000-000000000105'::uuid,'Moderator','00000000-0000-0000-0000-000000000102'::uuid),
 ('00000000-0000-0000-0000-000000000106'::uuid,'Editor','00000000-0000-0000-0000-000000000102'::uuid)) v(u,r,a);
-- 105: Moderator (admin.enter) plus an Editor assignment SCOPED to exactly one article.
insert into admin_private.role_assignments(user_id,role_name,policy_version_id,environment_scope,scope_kind,scope_id,
 starts_at,expires_at,review_due_at,status,approved_by,reason)
values('00000000-0000-0000-0000-000000000105','Editor',1,'staging','article','00000000-0000-0000-0000-000000000a03',
 clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days',clock_timestamp()+interval '30 days',
 'active','00000000-0000-0000-0000-000000000102','fixture');
alter table admin_private.policy_versions disable trigger policy_versions_immutable;
update admin_private.policy_versions set approval_state='approved',activated_at=clock_timestamp() where version_id=1;
alter table admin_private.policy_versions enable trigger policy_versions_immutable;
alter table admin_private.active_policy disable trigger active_policy_immutable;
update admin_private.active_policy set version_id=1,epoch=1,activated_at=clock_timestamp() where singleton;
alter table admin_private.active_policy enable trigger active_policy_immutable;

create schema readtest;
grant usage on schema readtest to authenticated, anon;
create function readtest.denied(p_sql text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when insufficient_privilege then return; end;
  raise exception 'expected 42501 but the call succeeded: %',p_sql;
end $$;
create function readtest.invalid(p_sql text) returns void language plpgsql as $$
begin
  begin execute p_sql; exception when invalid_parameter_value then return; end;
  raise exception 'expected 22023 but the call succeeded: %',p_sql;
end $$;
create function readtest.eq(p_label text,p_actual anyelement,p_expected anyelement) returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception '% : expected %, got %',p_label,p_expected,p_actual; end if;
end $$;
grant execute on all functions in schema readtest to authenticated, anon;

-- ---- fixture content, written through the real ADM-03B mutation RPCs as the Editor / Administrator / Owner
\set e1 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000301","aal":"aal2","exp":4102444800}'
\set e1b '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000307","aal":"aal2","exp":4102444800}'
\set o2 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000302","aal":"aal2","exp":4102444800}'
\set u3 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000103","session_id":"00000000-0000-0000-0000-000000000303","aal":"aal2","exp":4102444800}'
\set a4 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000104","session_id":"00000000-0000-0000-0000-000000000304","aal":"aal2","exp":4102444800}'
\set m5 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000105","session_id":"00000000-0000-0000-0000-000000000305","aal":"aal2","exp":4102444800}'
\set s6 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000106","session_id":"00000000-0000-0000-0000-000000000306","aal":"aal2","exp":4102444800}'

set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000a01','reads-normal',
  '{"title":"Normal read article","summary":"A synthetic normal summary for the read tests.","body_markdown":"First body.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000b01');
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000a02','reads-highlighted',
  '{"title":"Highlighted read article","summary":"A synthetic highlighted summary for read tests.","body_markdown":"Highlighted body.","classification":"highlighted","featured":true}',
  '00000000-0000-0000-0000-000000000b02');
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000a03','reads-scoped',
  '{"title":"Scoped read article","summary":"A synthetic scoped-grant summary for read tests.","body_markdown":"Scoped body.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000b03');
reset role;
select current_revision_id as a1r1 from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000a01' \gset
select current_revision_id as a2r1 from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000a02' \gset
set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
select public.fdb_cms_edit_draft('00000000-0000-0000-0000-000000000a01',:'a1r1',
  '{"title":"Normal read article v2","summary":"A synthetic normal summary for the read tests.","body_markdown":"Second body.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000b04');
select public.fdb_cms_submit_review('00000000-0000-0000-0000-000000000a02',:'a2r1','00000000-0000-0000-0000-000000000b05');
reset role;
set role authenticated;
select set_config('request.jwt.claims',:'a4',false);
select public.fdb_cms_approve_highlighted('00000000-0000-0000-0000-000000000a02',:'a2r1','00000000-0000-0000-0000-000000000b06');
reset role;
set role authenticated;
select set_config('request.jwt.claims',:'o2',false);
select public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000a02',:'a2r1','00000000-0000-0000-0000-000000000b07');
reset role;

-- ---- context
set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
select readtest.eq('editor context create',(public.fdb_cms_context()->>'can_create')::boolean,true);
select readtest.eq('editor context read',(public.fdb_cms_context()->>'can_read')::boolean,true);
select readtest.eq('editor context audit',(public.fdb_cms_context()->>'can_read_audit')::boolean,false);
select readtest.eq('editor context uid',public.fdb_cms_context()->>'user_id','00000000-0000-0000-0000-000000000101');
select set_config('request.jwt.claims',:'o2',false);
select readtest.eq('owner context audit',(public.fdb_cms_context()->>'can_read_audit')::boolean,true);
select readtest.eq('owner cannot author',(public.fdb_cms_context()->>'can_create')::boolean,false);
select set_config('request.jwt.claims',:'u3',false);
select readtest.denied($$select public.fdb_cms_context()$$);

-- ---- list
select set_config('request.jwt.claims',:'e1',false);
select readtest.eq('editor list size',jsonb_array_length(public.fdb_cms_articles(50)),3);
select readtest.eq('limit applies',jsonb_array_length(public.fdb_cms_articles(2)),2);
select readtest.invalid($$select public.fdb_cms_articles(0)$$);
select readtest.invalid($$select public.fdb_cms_articles(101)$$);
select readtest.invalid($$select public.fdb_cms_articles(null)$$);
do $$ declare v jsonb:=public.fdb_cms_articles(50); begin
  if (v->0->>'updated_at')::timestamptz < (v->2->>'updated_at')::timestamptz then
    raise exception 'list is not newest first'; end if;
  if exists(select 1 from jsonb_array_elements(v) x where x ? 'snapshot' or x::text like '%body_markdown%') then
    raise exception 'list leaks article bodies'; end if;
  if (select x->>'review_state' from jsonb_array_elements(v) x where x->>'slug'='reads-highlighted')<>'publish_pending' then
    raise exception 'publish pending state missing'; end if;
  if (select x->'latest_intent'->>'kind' from jsonb_array_elements(v) x where x->>'slug'='reads-highlighted')<>'publish' then
    raise exception 'latest intent missing'; end if;
  if (select x->'latest_intent'->'delivery'->>'state' from jsonb_array_elements(v) x where x->>'slug'='reads-highlighted') is null then
    raise exception 'delivery state missing'; end if;
end $$;
select set_config('request.jwt.claims',:'a4',false);
select readtest.eq('administrator reads via approve permission',jsonb_array_length(public.fdb_cms_articles(50)),3);
select set_config('request.jwt.claims',:'o2',false);
select readtest.eq('owner list',jsonb_array_length(public.fdb_cms_articles(50)),3);
select set_config('request.jwt.claims',:'u3',false);
select readtest.denied($$select public.fdb_cms_articles(10)$$);
-- 105: Moderator with an Editor assignment scoped to ONE article sees exactly that article
select set_config('request.jwt.claims',:'m5',false);
select readtest.eq('scoped list',jsonb_array_length(public.fdb_cms_articles(50)),1);
select readtest.eq('scoped slug',public.fdb_cms_articles(50)->0->>'slug','reads-scoped');
select readtest.denied($$select public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a01')$$);
select readtest.eq('scoped detail ok',public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a03')->'article'->>'slug','reads-scoped');
select readtest.eq('scoped edit permitted',(public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a03')->'permitted'->>'edit')::boolean,true);
select readtest.eq('scoped publish not permitted',(public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a03')->'permitted'->>'publish')::boolean,false);

-- ---- detail and revisions
select set_config('request.jwt.claims',:'e1',false);
do $$ declare d jsonb:=public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a01'); begin
  if jsonb_array_length(d->'revisions')<>2 or (d->'revisions'->0->>'revision_no')::int<>2
     or (d->'article'->>'revision_no')::int<>2 or d->'article'->'snapshot'->>'title'<>'Normal read article v2' then
    raise exception 'revision history wrong: %',d; end if;
  if jsonb_array_length(d->'revisions'->0->'contributors')<>1 then raise exception 'contributors missing'; end if;
  if (d->'permitted'->>'edit')::boolean is not true or (d->'permitted'->>'publish')::boolean is not false
     or (d->'permitted'->>'approve')::boolean is not false then raise exception 'permitted flags wrong: %',d->'permitted'; end if;
  if jsonb_array_length(d->'intents')<>0 or jsonb_array_length(d->'approvals')<>0 then raise exception 'unexpected evidence'; end if;
end $$;
do $$ declare d jsonb:=public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a02'); begin
  if jsonb_array_length(d->'reviews')<>2 or jsonb_array_length(d->'approvals')<>1
     or (d->'approvals'->0->>'consumed')::boolean is not true
     or d->'approvals'->0->>'approver_id'<>'00000000-0000-0000-0000-000000000104'
     or jsonb_array_length(d->'intents')<>1 or d->'intents'->0->>'kind'<>'publish'
     or d->'intents'->0->'delivery'->>'state' is null then
    raise exception 'highlighted evidence wrong: %',d; end if;
end $$;
select readtest.eq('revision hash matches',public.fdb_cms_revision('00000000-0000-0000-0000-000000000a01',:'a1r1')->>'snapshot_hash',
  (select x->>'snapshot_hash' from jsonb_array_elements(public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a01')->'revisions') x where (x->>'revision_no')::int=1));
select readtest.eq('revision body',public.fdb_cms_revision('00000000-0000-0000-0000-000000000a01',:'a1r1')->'snapshot'->>'body_markdown','First body.');
select readtest.denied(format($$select public.fdb_cms_revision('00000000-0000-0000-0000-000000000a02',%L)$$,:'a1r1'));
select readtest.denied($$select public.fdb_cms_article_detail('00000000-0000-0000-0000-0000000000ff')$$);
select readtest.denied($$select public.fdb_cms_revision(null,null)$$);
select set_config('request.jwt.claims',:'u3',false);
select readtest.denied($$select public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a01')$$);
select readtest.denied(format($$select public.fdb_cms_revision('00000000-0000-0000-0000-000000000a01',%L)$$,:'a1r1'));
reset role;

-- ---- delivery ledger (only when the ADM-03C migration is present): states reach the UI as recorded
\if :delivery
insert into editorial_private.delivery_state(intent_id,article_id,generation,state,attempt,last_error_code)
  select intent_id,article_id,generation,'retryable',2,'public_unavailable' from editorial_private.publication_intents
  where article_id='00000000-0000-0000-0000-000000000a02';
set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
select readtest.eq('retryable state shown',public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a02')->'intents'->0->'delivery'->>'state','retryable');
select readtest.eq('error code shown',public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a02')->'intents'->0->'delivery'->>'error_code','public_unavailable');
select readtest.eq('attempt shown',(public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a02')->'intents'->0->'delivery'->>'attempt')::int,2);
reset role;
update editorial_private.delivery_state set state='cancelled',last_error_code='actor_revoked' where article_id='00000000-0000-0000-0000-000000000a02';
set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
select readtest.eq('cancelled state shown',(select x->'latest_intent'->'delivery'->>'state' from jsonb_array_elements(public.fdb_cms_articles(50)) x where x->>'slug'='reads-highlighted'),'cancelled');
reset role;
\endif

-- ---- audit read
set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
select readtest.denied($$select public.fdb_cms_audit(10,null)$$);
select set_config('request.jwt.claims',:'u3',false);
select readtest.denied($$select public.fdb_cms_audit(10,null)$$);
select set_config('request.jwt.claims',:'o2',false);
do $$ declare v jsonb:=public.fdb_cms_audit(100,null); first_no bigint; page jsonb; begin
  if jsonb_array_length(v)<7 then raise exception 'owner audit too short: %',jsonb_array_length(v); end if;
  if exists(select 1 from jsonb_array_elements(v) x where x->>'action_key' not like 'news.%') then
    raise exception 'non-editorial audit events leaked'; end if;
  if v::text like '%body_markdown%' or v::text like '%First body.%' then raise exception 'audit leaks article body'; end if;
  if exists(select 1 from jsonb_array_elements(v) x where x ? 'session_id' or x ? 'event_hash') then
    raise exception 'audit leaks session or hash chain'; end if;
  if (v->0->>'event_no')::bigint < (v->1->>'event_no')::bigint then raise exception 'audit not newest first'; end if;
  page:=public.fdb_cms_audit(2,(v->1->>'event_no')::bigint);
  if jsonb_array_length(page)<>2 or (page->0->>'event_no')::bigint >= (v->1->>'event_no')::bigint then
    raise exception 'audit paging wrong'; end if;
end $$;
select readtest.invalid($$select public.fdb_cms_audit(0,null)$$);
select readtest.invalid($$select public.fdb_cms_audit(10,0)$$);
select set_config('request.jwt.claims',:'a4',false);
select readtest.eq('administrator audit ok',jsonb_array_length(public.fdb_cms_audit(5,null))>0,true);
reset role;
-- An audit.editorial.read direct grant is NOT an executable grant cell in this slice (0021): an Editor holding one still cannot read
-- the audit trail. The read fails closed; only Administrator/Owner role mappings carry the permission.
insert into admin_private.direct_grants(grant_id,user_id,permission_key,policy_version_id,environment_scope,scope_kind,scope_id,
 starts_at,expires_at,status,approved_by,reason)
values('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000101','audit.editorial.read',1,'staging','collection','news',
 clock_timestamp()-interval '1 hour',clock_timestamp()+interval '29 days','active','00000000-0000-0000-0000-000000000102','fixture');
set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
select readtest.denied($$select public.fdb_cms_audit(5,null)$$);
select readtest.eq('grant does not widen the context',(public.fdb_cms_context()->>'can_read_audit')::boolean,false);
reset role;
update admin_private.direct_grants set status='revoked',revoked_at=clock_timestamp() where grant_id='00000000-0000-0000-0000-0000000000c1';
set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
select readtest.denied($$select public.fdb_cms_audit(5,null)$$);
reset role;

-- ---- session, freshness and staff-status negatives
update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '16 minutes' where session_id='00000000-0000-0000-0000-000000000301';
set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
select readtest.denied($$select public.fdb_cms_articles(5)$$);
select readtest.denied($$select public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a01')$$);
select readtest.denied($$select public.fdb_cms_context()$$);
reset role;
update auth.mfa_amr_claims set updated_at=clock_timestamp() where session_id='00000000-0000-0000-0000-000000000301';
set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
select readtest.eq('freshness restored',jsonb_array_length(public.fdb_cms_articles(5)),3);
reset role;
insert into admin_private.session_revocations(session_id,user_id) values
 ('00000000-0000-0000-0000-000000000307','00000000-0000-0000-0000-000000000101');
set role authenticated;
select set_config('request.jwt.claims',:'e1b',false);
select readtest.denied($$select public.fdb_cms_articles(5)$$);
select readtest.denied($$select public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a01')$$);
select set_config('request.jwt.claims',:'e1',false);
select readtest.eq('other session of the same user unaffected',jsonb_array_length(public.fdb_cms_articles(5)),3);
select set_config('request.jwt.claims',:'s6',false);
select readtest.eq('before suspension',jsonb_array_length(public.fdb_cms_articles(5)),3);
reset role;
update admin_private.staff_subjects set status='suspended' where user_id='00000000-0000-0000-0000-000000000106';
set role authenticated;
select set_config('request.jwt.claims',:'s6',false);
select readtest.denied($$select public.fdb_cms_articles(5)$$);
-- forged / wrong claims: AAL1, expired token, wrong role
select set_config('request.jwt.claims','{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000301","aal":"aal1","exp":4102444800}',false);
select readtest.denied($$select public.fdb_cms_articles(5)$$);
select set_config('request.jwt.claims','{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000301","aal":"aal2","exp":1}',false);
select readtest.denied($$select public.fdb_cms_articles(5)$$);
select set_config('request.jwt.claims','',false);
select readtest.denied($$select public.fdb_cms_articles(5)$$);
reset role;
-- anon and service_role have no EXECUTE at all
set role anon;
do $$ begin
  begin perform public.fdb_cms_articles(5); raise exception 'anon executed a CMS read';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- ---- ACLs and shape of the 0027 surface
do $assert$
declare f record;
begin
  for f in select p.oid,p.proname,p.prosecdef,p.proconfig,p.proowner from pg_proc p
      where p.pronamespace='public'::regnamespace and p.proname in
        ('fdb_cms_context','fdb_cms_articles','fdb_cms_article_detail','fdb_cms_revision','fdb_cms_audit') loop
    if not f.prosecdef or pg_get_userbyid(f.proowner)<>'admin_executor' or f.proconfig<>array['search_path=""']::text[]
       or has_function_privilege('anon',f.oid,'EXECUTE') or has_function_privilege('service_role',f.oid,'EXECUTE')
       or has_function_privilege('authenticator',f.oid,'EXECUTE')
       or not has_function_privilege('authenticated',f.oid,'EXECUTE') then
      raise exception '0027 RPC ACL or owner incorrect: %',f.proname; end if;
  end loop;
  if (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'fdb_cms_%')<>13 then
    raise exception 'unexpected CMS RPC count'; end if;
  for f in select p.oid,p.proname from pg_proc p where p.pronamespace='editorial_private'::regnamespace
      and p.proname in ('read_actor','audit_reader','intent_delivery') loop
    if has_function_privilege('authenticated',f.oid,'EXECUTE') or has_function_privilege('anon',f.oid,'EXECUTE') then
      raise exception 'internal helper exposed: %',f.proname; end if;
  end loop;
  if has_schema_privilege('authenticated','editorial_private','USAGE') then raise exception 'schema exposed'; end if;
  if exists(select 1 from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'fdb_cms_%'
      and p.proname not in ('fdb_cms_create_draft','fdb_cms_edit_draft','fdb_cms_submit_review','fdb_cms_review_decide',
        'fdb_cms_approve_highlighted','fdb_cms_publish_intent','fdb_cms_unpublish_intent','fdb_cms_article',
        'fdb_cms_context','fdb_cms_articles','fdb_cms_article_detail','fdb_cms_revision','fdb_cms_audit')) then
    raise exception 'unexpected CMS function'; end if;
end $assert$;
-- the reads changed nothing: no new audit events were written by a read
select count(*) as audit_after from admin_private.staff_audit_events where action_key like 'news.%' \gset
select 1/(case when :audit_after=7 then 1 else 0 end) as reads_wrote_no_audit_events;
