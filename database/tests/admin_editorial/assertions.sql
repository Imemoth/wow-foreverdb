\set ON_ERROR_STOP on
do $acl$
declare p record;
begin
  if (select version_id from admin_private.active_policy where singleton)<>0
     or exists(select 1 from admin_private.staff_subjects)
     or has_schema_privilege('authenticated','admin_private','USAGE')
     or has_schema_privilege('service_role','admin_private','USAGE')
     or pg_has_role('authenticated','admin_executor','MEMBER') then
    raise exception 'inactive or private boundary changed'; end if;
  for p in select * from pg_proc where pronamespace='admin_private'::regnamespace
      and proname in ('editorial_actor','append_editorial_audit') loop
    if pg_get_userbyid(p.proowner)<>'admin_executor' or not p.prosecdef
       or p.proconfig<>array['search_path=""']::text[]
       or has_function_privilege('anon',p.oid,'EXECUTE')
       or has_function_privilege('authenticated',p.oid,'EXECUTE')
       or has_function_privilege('service_role',p.oid,'EXECUTE') then
      raise exception 'private editorial function exposed'; end if;
  end loop;
  if (select count(*) from pg_proc where pronamespace='admin_private'::regnamespace
      and proname in ('editorial_actor','append_editorial_audit'))<>2 then
    raise exception 'private editorial function missing'; end if;
  if (select payload from public.account_sentinel where id=1)<>'untouched'
     or (select payload from private.guildbook_sentinel where id=1)<>'untouched' then
    raise exception 'Account/Guildbook changed'; end if;
end $acl$;

-- Synthetic identities and policy exist solely in this disposable database.
insert into auth.users(id,email_confirmed_at) values
 ('00000000-0000-0000-0000-000000000101',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000102',clock_timestamp());
insert into auth.mfa_factors(id,user_id,factor_type,status) values
 ('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000101','totp','verified'),
 ('00000000-0000-0000-0000-000000000302','00000000-0000-0000-0000-000000000102','totp','verified');
insert into auth.sessions(id,user_id,factor_id,aal) values
 ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000301','aal2'),
 ('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000302','aal2');
insert into auth.refresh_tokens(session_id) values
 ('00000000-0000-0000-0000-000000000201'),
 ('00000000-0000-0000-0000-000000000202');
insert into auth.mfa_amr_claims(session_id,authentication_method,updated_at) values
 ('00000000-0000-0000-0000-000000000201','totp',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000202','totp',clock_timestamp());
insert into admin_private.staff_subjects(user_id,status) values
 ('00000000-0000-0000-0000-000000000101','active');
insert into admin_private.role_assignments(user_id,role_name,policy_version_id,
 environment_scope,scope_kind,starts_at,expires_at,review_due_at,status,approved_by,reason)
values('00000000-0000-0000-0000-000000000101','Editor',1,'staging','global',
 clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days',
 clock_timestamp()+interval '30 days','active',
 '00000000-0000-0000-0000-000000000102','synthetic fixture');
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $t$ begin
  if admin_private.editorial_actor('news.draft.write','article-1') is not null
     then raise exception 'deny-all policy was bypassed'; end if;
end $t$;
reset role;
alter table admin_private.policy_versions disable trigger policy_versions_immutable;
update admin_private.policy_versions set approval_state='approved',activated_at=clock_timestamp()
 where version_id=1;
alter table admin_private.policy_versions enable trigger policy_versions_immutable;
alter table admin_private.active_policy disable trigger active_policy_immutable;
update admin_private.active_policy set version_id=1,epoch=1,activated_at=clock_timestamp()
 where singleton;
alter table admin_private.active_policy enable trigger active_policy_immutable;

-- A synthetic protected write is never a CMS article. It proves that the
-- private gate, write and existing append-only hash chain share a transaction.
create table public.editorial_probe(id integer primary key);
grant insert on public.editorial_probe to admin_executor;
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $t$ declare actor uuid;
begin
  actor:=admin_private.editorial_actor('news.draft.write','article-1');
  if actor is null then raise exception 'valid editor denied'; end if;
  insert into public.editorial_probe values(1);
  perform admin_private.append_editorial_audit('news.draft.write','article-1',actor,
    gen_random_uuid(),'{"rev":0}'::jsonb,'{"rev":1}'::jsonb);
  if admin_private.editorial_actor('news.article.publish','article-1') is not null
     or admin_private.editorial_actor('news.draft.write','other-article') is null then
    raise exception 'permission or scope default incorrect'; end if;
end $t$;
reset role;

insert into admin_private.direct_grants(user_id,permission_key,policy_version_id,
 environment_scope,scope_kind,scope_id,starts_at,expires_at,status,approved_by,reason)
values('00000000-0000-0000-0000-000000000101','news.article.publish',1,
 'staging','article','article-1',clock_timestamp()-interval '1 minute',
 clock_timestamp()+interval '29 days','active',
 '00000000-0000-0000-0000-000000000102','synthetic scoped grant');
set role admin_executor;
do $t$ begin
  if admin_private.editorial_actor('news.article.publish','article-1') is null
     or admin_private.editorial_actor('news.article.publish','article-2') is not null
     or admin_private.authorize_action('news.article.publish','production','article','article-1')
     then raise exception 'delegated publishing scope leaked'; end if;
end $t$;
reset role;

-- Role metadata and forged AAL claims cannot substitute for Auth-session
-- liveness or the server-maintained TOTP timestamp.
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
do $t$ begin
  if admin_private.editorial_actor('news.draft.write','article-1') is not null
     then raise exception 'forged session identity allowed'; end if;
end $t$;
reset role;
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal1","exp":4102444800}';
do $t$ begin
  if admin_private.editorial_actor('news.draft.write','article-1') is not null
     then raise exception 'AAL1 claim allowed'; end if;
end $t$;
reset role;
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $t$ begin
  if admin_private.editorial_actor('news.article.submit','article-1') is null
     or admin_private.editorial_actor('news.article.approve_highlighted','article-1') is not null
     or admin_private.editorial_actor('news.draft.write','Article-1') is not null
     or admin_private.editorial_actor('staff.role.propose','article-1') is not null
     or admin_private.authorize_action('news.draft.write','production','article','article-1')
     then raise exception 'action, scope or environment gate failed'; end if;
end $t$;
reset role;

update auth.sessions set not_after=clock_timestamp()-interval '1 second'
 where id='00000000-0000-0000-0000-000000000201';
set role admin_executor;
do $t$ begin
  if admin_private.editorial_actor('news.draft.write','article-1') is not null
     then raise exception 'stale Auth session allowed'; end if;
end $t$;
reset role;
update auth.sessions set not_after=null
 where id='00000000-0000-0000-0000-000000000201';
do $t$ begin
  if (select count(*) from public.editorial_probe)<>1
     or (select count(*) from admin_private.staff_audit_events where reason='editorial_action')<>1
     or (select event_no from admin_private.staff_audit_head)<>1 then
    raise exception 'write/audit atomicity failed'; end if;
end $t$;

update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '16 minutes'
 where session_id='00000000-0000-0000-0000-000000000201';
set role admin_executor;
do $t$ begin
  if admin_private.editorial_actor('news.draft.write','article-1') is not null
     then raise exception 'stale TOTP allowed'; end if;
end $t$;
reset role;
update auth.mfa_amr_claims set updated_at=clock_timestamp()
 where session_id='00000000-0000-0000-0000-000000000201';

set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
do $t$ begin
  if admin_private.editorial_actor('news.draft.write','article-1') is not null
     then raise exception 'ordinary user allowed'; end if;
end $t$;
reset role;
