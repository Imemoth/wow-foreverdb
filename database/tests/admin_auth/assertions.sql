\set ON_ERROR_STOP on
do $test$
declare p record; n text;
begin
  if (select version_id from admin_private.active_policy) <> 0
     or exists (select 1 from admin_private.staff_subjects) then
    raise exception '0022 activated Admin authority';
  end if;
  if has_schema_privilege('authenticated','admin_private','USAGE')
     or has_table_privilege('authenticated','admin_private.handoff_tokens','SELECT')
     or has_table_privilege('service_role','admin_private.session_revocations','INSERT')
     or has_table_privilege('admin_executor','auth.mfa_amr_claims','SELECT') then
    raise exception 'private schema/Auth grant leak';
  end if;
  if not (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
      where relnamespace='admin_private'::regnamespace and relname in ('handoff_tokens','session_revocations')) then
    raise exception 'new tables lack forced RLS';
  end if;
  foreach n in array array['fdb_admin_entry_ready','fdb_admin_handoff_start','fdb_admin_handoff_redeem','fdb_admin_session_revoke'] loop
    select * into p from pg_proc where proname=n and pronamespace='public'::regnamespace;
    if p.oid is null or pg_get_userbyid(p.proowner)<>'admin_executor'
       or not p.prosecdef or p.proconfig<>array['search_path=""']::text[]
       or has_function_privilege('anon',p.oid,'EXECUTE')
       or not has_function_privilege('authenticated',p.oid,'EXECUTE') then
      raise exception 'narrow RPC boundary failed: %',n;
    end if;
  end loop;
  select * into p from pg_proc where oid='admin_private.fresh_totp_session(uuid,uuid)'::regprocedure;
  if p.oid is null or not p.prosecdef or p.proconfig<>array['search_path=""']::text[]
     or not (select rolbypassrls from pg_roles where oid=p.proowner)
     or has_function_privilege('authenticated',p.oid,'EXECUTE') then
    raise exception 'elevated MFA helper boundary failed';
  end if;
end $test$;

set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $test$ begin
  if public.fdb_admin_entry_ready()
     or public.fdb_admin_handoff_start('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ') then
    raise exception 'deny-all policy admitted Admin entry';
  end if;
end $test$;
reset role;

-- Synthetic staff/policy only in this disposable database.
alter table admin_private.policy_versions disable trigger policy_versions_immutable;
update admin_private.policy_versions set approval_state='approved',activated_at=clock_timestamp() where version_id=1;
alter table admin_private.policy_versions enable trigger policy_versions_immutable;
alter table admin_private.active_policy disable trigger active_policy_immutable;
update admin_private.active_policy set version_id=1,epoch=1,activated_at=clock_timestamp();
alter table admin_private.active_policy enable trigger active_policy_immutable;
insert into auth.users(id) values ('00000000-0000-0000-0000-000000000101');
insert into auth.mfa_factors(id,user_id,factor_type,status) values
  ('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000101','totp','verified');
insert into auth.sessions(id,user_id,factor_id,aal) values
  ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000301','aal2'),
  ('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000301','aal2');
insert into auth.refresh_tokens(session_id) values
  ('00000000-0000-0000-0000-000000000201'),('00000000-0000-0000-0000-000000000202');
insert into auth.mfa_amr_claims(session_id,authentication_method,updated_at) values
  ('00000000-0000-0000-0000-000000000201','totp',clock_timestamp()),
  ('00000000-0000-0000-0000-000000000202','totp',clock_timestamp());
insert into admin_private.staff_subjects(user_id,status) values
  ('00000000-0000-0000-0000-000000000101','active');
insert into admin_private.role_assignments
  (user_id,role_name,policy_version_id,environment_scope,scope_kind,starts_at,review_due_at,status,approved_by,reason)
values ('00000000-0000-0000-0000-000000000101','Editor',1,'staging','global',
  clock_timestamp()-interval '1 day',clock_timestamp()+interval '30 days','active',
  '00000000-0000-0000-0000-000000000302','synthetic only');

set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $test$ begin
  if not public.fdb_admin_entry_ready() then raise exception 'synthetic fresh TOTP entry denied'; end if;
  if not public.fdb_admin_handoff_start('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ')
     or not public.fdb_admin_handoff_redeem('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ')
     or public.fdb_admin_handoff_redeem('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ') then
    raise exception 'single-use handoff failed';
  end if;
end $test$;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
do $test$ begin
  if public.fdb_admin_handoff_redeem('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ') then
    raise exception 'cross-session redemption admitted';
  end if;
end $test$;
reset role;

update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '16 minutes';
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $test$ begin
  if public.fdb_admin_entry_ready() then raise exception 'stale TOTP admitted'; end if;
end $test$;
reset role;
update auth.mfa_amr_claims set updated_at=clock_timestamp();
-- A refreshed JWT iat/exp cannot manufacture a new TOTP event.
update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '16 minutes'
where session_id='00000000-0000-0000-0000-000000000201';
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","iat":4102444700,"exp":4102444800}';
do $test$ begin
  if public.fdb_admin_entry_ready() then raise exception 'JWT refresh manufactured fresh TOTP'; end if;
end $test$;
reset role;
update auth.mfa_amr_claims set updated_at=clock_timestamp()
where session_id='00000000-0000-0000-0000-000000000201';
update auth.mfa_factors set status='unverified';
set role authenticated;
do $test$ begin
  if public.fdb_admin_entry_ready() then raise exception 'removed/unverified factor admitted'; end if;
end $test$;
reset role;
update auth.mfa_factors set status='verified';
update auth.sessions set aal='aal1' where id='00000000-0000-0000-0000-000000000201';
set role authenticated;
do $test$ begin
  if public.fdb_admin_entry_ready() then raise exception 'downgraded AAL admitted'; end if;
end $test$;
reset role;
update auth.sessions set aal='aal2' where id='00000000-0000-0000-0000-000000000201';
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal1","exp":4102444800}';
do $test$ begin
  if public.fdb_admin_entry_ready() then raise exception 'AAL1 JWT admitted after session recovery'; end if;
end $test$;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
set role authenticated;
do $test$ begin
  if not public.fdb_admin_session_revoke() or public.fdb_admin_entry_ready() then
    raise exception 'local Admin session revocation failed';
  end if;
end $test$;
reset role;
