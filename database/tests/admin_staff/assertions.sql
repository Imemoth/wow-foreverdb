\set ON_ERROR_STOP on
do $acl$
declare n text; p record;
begin
  if (select rolcanlogin or rolinherit or rolbypassrls from pg_roles
      where rolname='admin_executor')
     or pg_has_role('anon','admin_executor','MEMBER')
     or pg_has_role('authenticated','admin_executor','MEMBER')
     or pg_has_role('service_role','admin_executor','MEMBER')
     or has_schema_privilege('authenticated','admin_private','USAGE')
     or has_schema_privilege('service_role','admin_private','USAGE') then
    raise exception 'executor or schema exposed'; end if;
  foreach n in array array['bootstrap_control','staff_action_approvals',
    'staff_audit_head','staff_audit_events','staff_emergency_reviews'] loop
    if not exists(select 1 from pg_class where relnamespace='admin_private'::regnamespace
       and relname=n and relrowsecurity and relforcerowsecurity)
       or has_table_privilege('authenticated',format('admin_private.%I',n),'SELECT')
       or has_table_privilege('service_role',format('admin_private.%I',n),'INSERT')
       then raise exception '0023 table boundary leak: %',n; end if;
  end loop;
  foreach n in array array[
    'fdb_admin_staff_prepare','fdb_admin_role_propose','fdb_admin_role_approve',
    'fdb_admin_grant_propose','fdb_admin_grant_approve','fdb_admin_staff_suspend',
    'fdb_admin_staff_reinstate','fdb_admin_role_revoke','fdb_admin_grant_revoke',
    'fdb_admin_emergency_review'] loop
    select * into p from pg_proc where proname=n and pronamespace='public'::regnamespace;
    if p.oid is null or pg_get_userbyid(p.proowner)<>'admin_executor'
       or not p.prosecdef or p.proconfig<>array['search_path=""']::text[]
       or has_function_privilege('anon',p.oid,'EXECUTE')
       or has_function_privilege('service_role',p.oid,'EXECUTE')
       or not has_function_privilege('authenticated',p.oid,'EXECUTE') then
      raise exception 'public RPC boundary leak: %',n; end if;
  end loop;
  foreach n in array array[
    'staff_actor','staff_is_owner','staff_grant_ceiling',
    'append_staff_audit','eligible_staff_identity','record_staff_denial',
    'schedule_emergency_review','arm_initial_owner','bootstrap_initial_owner',
    'expire_staff_authority','require_staff_fresh_commit','valid_staff_reason'] loop
    for p in select * from pg_proc where proname=n and pronamespace='admin_private'::regnamespace loop
      if p.proconfig<>array['search_path=""']::text[]
         or has_function_privilege('anon',p.oid,'EXECUTE')
         or has_function_privilege('authenticated',p.oid,'EXECUTE')
         or has_function_privilege('service_role',p.oid,'EXECUTE') then
        raise exception 'private function boundary leak: %',n; end if;
    end loop;
  end loop;
  if has_table_privilege('admin_executor','admin_private.staff_audit_events','UPDATE')
     or has_table_privilege('admin_executor','admin_private.staff_audit_events','DELETE')
     then raise exception 'audit events are mutable by executor'; end if;
  if (select payload from public.account_sentinel where id=1)<>'untouched'
     or (select payload from private.guildbook_sentinel where id=1)<>'untouched'
     then raise exception 'Account or Guildbook isolation changed'; end if;
end $acl$;

-- All identities and approvals below exist only in a disposable database.
insert into auth.users(id,email_confirmed_at) values
 ('00000000-0000-0000-0000-000000000101',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000102',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000103',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000104',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000105',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000106',clock_timestamp());
insert into auth.mfa_factors(id,user_id,factor_type,status) values
 ('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000101','totp','verified'),
 ('00000000-0000-0000-0000-000000000302','00000000-0000-0000-0000-000000000102','totp','verified'),
 ('00000000-0000-0000-0000-000000000303','00000000-0000-0000-0000-000000000103','totp','verified'),
 ('00000000-0000-0000-0000-000000000304','00000000-0000-0000-0000-000000000104','totp','verified'),
 ('00000000-0000-0000-0000-000000000305','00000000-0000-0000-0000-000000000105','totp','verified'),
 ('00000000-0000-0000-0000-000000000306','00000000-0000-0000-0000-000000000106','totp','verified');
insert into auth.sessions(id,user_id,factor_id,aal) values
 ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000301','aal2'),
 ('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000302','aal2'),
 ('00000000-0000-0000-0000-000000000203','00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-000000000303','aal2'),
 ('00000000-0000-0000-0000-000000000204','00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-000000000304','aal1'),
 ('00000000-0000-0000-0000-000000000205','00000000-0000-0000-0000-000000000105','00000000-0000-0000-0000-000000000305','aal2'),
 ('00000000-0000-0000-0000-000000000206','00000000-0000-0000-0000-000000000106','00000000-0000-0000-0000-000000000306','aal2');
insert into auth.refresh_tokens(session_id) values
 ('00000000-0000-0000-0000-000000000201'),
 ('00000000-0000-0000-0000-000000000202'),
 ('00000000-0000-0000-0000-000000000203'),
 ('00000000-0000-0000-0000-000000000204'),
 ('00000000-0000-0000-0000-000000000205'),
 ('00000000-0000-0000-0000-000000000206');
insert into auth.mfa_amr_claims(session_id,authentication_method,updated_at) values
 ('00000000-0000-0000-0000-000000000201','totp',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000202','totp',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000203','totp',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000204','totp',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000205','totp',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000206','totp',clock_timestamp());

do $t$
declare uid uuid:='00000000-0000-0000-0000-000000000101';
        sid uuid:='00000000-0000-0000-0000-000000000201';
        digest bytea:=decode(repeat('ab',32),'hex');
begin
  if (select version_id from admin_private.active_policy)<>0
     or exists(select 1 from admin_private.staff_subjects) then
    raise exception 'migration activated staff';
  end if;
  if admin_private.bootstrap_initial_owner(uid,sid,digest,
       '00000000-0000-0000-0000-000000000102',gen_random_uuid(),'bootstrap')
     then raise exception 'unarmed bootstrap succeeded'; end if;
  if not admin_private.arm_initial_owner(uid,digest,clock_timestamp()+interval '10 minutes',
       '00000000-0000-0000-0000-000000000104',
       '00000000-0000-0000-0000-000000000102')
     or not admin_private.bootstrap_initial_owner(uid,sid,digest,
       '00000000-0000-0000-0000-000000000102',gen_random_uuid(),'bootstrap')
     or admin_private.bootstrap_initial_owner(uid,sid,digest,
       '00000000-0000-0000-0000-000000000102',gen_random_uuid(),'bootstrap')
     then raise exception 'bootstrap once-only failed'; end if;
  if (select count(*) from admin_private.role_assignments where role_name='Owner')<>1
     or (select event_no from admin_private.staff_audit_head)<>4 then
    raise exception 'bootstrap assignment/audit missing'; end if;
end $t$;

-- No policy activation is in migration 0023. Only this disposable fixture
-- activates version 1 to test guarded writes.
alter table admin_private.policy_versions disable trigger policy_versions_immutable;
update admin_private.policy_versions set approval_state='approved',
 activated_at=clock_timestamp() where version_id=1;
alter table admin_private.policy_versions enable trigger policy_versions_immutable;
alter table admin_private.active_policy disable trigger active_policy_immutable;
update admin_private.active_policy set version_id=1,epoch=1,
 activated_at=clock_timestamp() where singleton;
alter table admin_private.active_policy enable trigger active_policy_immutable;

set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $t$
declare proposal uuid; g uuid; target uuid:='00000000-0000-0000-0000-000000000103';
begin
  if not public.fdb_admin_staff_prepare(target,'staff_onboarding')
     then raise exception 'staff prepare failed'; end if;
  if public.fdb_admin_role_propose('00000000-0000-0000-0000-000000000101',
    'Owner',30,'role_change') is not null
    or public.fdb_admin_role_propose(target,'Owner',30,'role_change') is not null
    then raise exception 'Owner or self promotion allowed'; end if;
  proposal:=public.fdb_admin_role_propose(target,'Editor',30,'role_change');
  if proposal is null or public.fdb_admin_role_approve(proposal)
     then raise exception 'self approval was allowed'; end if;
end $t$;
reset role;

-- Second independent synthetic Owner is fixture-only, never migration seed.
insert into admin_private.staff_subjects(user_id,status) values
 ('00000000-0000-0000-0000-000000000102','active');
insert into admin_private.role_assignments(user_id,role_name,policy_version_id,
 environment_scope,scope_kind,starts_at,review_due_at,status,approved_by,reason)
values('00000000-0000-0000-0000-000000000102','Owner',1,'staging','global',
 clock_timestamp()-interval '1 minute','infinity','active',
 '00000000-0000-0000-0000-000000000101','synthetic second owner');

set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
do $t$
begin
  if public.fdb_admin_staff_suspend('00000000-0000-0000-0000-000000000101','emergency_revoke')
     then raise exception 'Owner suspension allowed'; end if;
end $t$;
reset role;

select assignment_id as proposal from admin_private.role_assignments
 where user_id='00000000-0000-0000-0000-000000000103'
   and role_name='Editor' and status='proposed' \gset
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_admin_role_approve(:'proposal'::uuid) as approved \gset
reset role;
do $t$ begin
  if not exists(select 1 from admin_private.role_assignments
      where user_id='00000000-0000-0000-0000-000000000103'
        and role_name='Editor' and status='active') then
    raise exception 'independent approval failed';
  end if;
end $t$;

do $t$
begin
  if (select count(*) from admin_private.staff_audit_events)<>(
     select event_no from admin_private.staff_audit_head)
     or exists(select 1 from admin_private.staff_audit_events e
       where e.event_no>1 and e.previous_hash is distinct from
         (select p.event_hash from admin_private.staff_audit_events p
          where p.event_no=e.event_no-1))
     then raise exception 'audit chain gap'; end if;
end $t$;
