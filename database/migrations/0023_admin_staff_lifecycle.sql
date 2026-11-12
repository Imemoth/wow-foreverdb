-- ADM-01B-4: inactive staff lifecycle and one-time, operator-only Owner ceremony.
-- Additive source migration. Never apply to a hosted project without separate approval.
-- Policy 0 remains active; no staff, Owner, or recovery credential is seeded.
begin;

do $preflight$
begin
  if to_regprocedure('public.fdb_admin_entry_ready()') is null
     or to_regprocedure('admin_private.fresh_totp_session(uuid,uuid)') is null
     or to_regclass('admin_private.staff_audit_events') is not null
     or (select version_id from admin_private.active_policy where singleton) <> 0
     or exists (select 1 from admin_private.staff_subjects) then
    raise exception '0023 pre-flight: inert 0020-0022 foundation required';
  end if;
  if not (select rolbypassrls or rolsuper from pg_roles where rolname=current_user)
     or not has_table_privilege(current_user,'auth.users','SELECT')
     or not exists (select 1 from information_schema.columns where table_schema='auth'
       and table_name='users' and column_name='email_confirmed_at')
     or not exists (select 1 from information_schema.columns where table_schema='auth'
       and table_name='users' and column_name='phone_confirmed_at') then
    raise exception '0023 pre-flight: reviewed Auth identity read or confirmation columns missing';
  end if;
end $preflight$;

create table admin_private.bootstrap_control (
  singleton boolean primary key default true check (singleton),
  target_uid uuid,
  approval_digest bytea check (approval_digest is null or octet_length(approval_digest)=32),
  operator_id uuid,
  delegate_id uuid,
  armed_until timestamptz,
  consumed_at timestamptz,
  check ((target_uid is null and approval_digest is null and operator_id is null
       and delegate_id is null and armed_until is null)
      or (target_uid is not null and approval_digest is not null
       and operator_id is not null and delegate_id is not null and armed_until is not null))
);
insert into admin_private.bootstrap_control(singleton) values(true);

create table admin_private.staff_action_approvals (
  proposal_kind text not null check (proposal_kind in ('role','grant')),
  proposal_id uuid not null,
  approver_id uuid not null references admin_private.staff_subjects(user_id) on delete restrict,
  policy_version_id bigint not null references admin_private.policy_versions(version_id) on delete restrict,
  approved_at timestamptz not null default clock_timestamp(),
  primary key(proposal_kind,proposal_id,approver_id)
);

create table admin_private.staff_audit_head (
  singleton boolean primary key default true check(singleton),
  event_no bigint not null default 0 check(event_no >= 0),
  event_hash bytea not null default decode(repeat('00',32),'hex')
    check(octet_length(event_hash)=32)
);
insert into admin_private.staff_audit_head(singleton) values(true);
create table admin_private.staff_audit_events (
  event_no bigint primary key check(event_no > 0),
  occurred_at timestamptz not null,
  actor_id uuid,
  session_id uuid,
  target_id uuid,
  action_key text not null check(length(action_key) between 1 and 100),
  resource_key text not null check(length(resource_key) between 1 and 200),
  policy_version_id bigint not null,
  decision text not null check(decision in ('allow','deny')),
  outcome text not null check(outcome in ('success','denied')),
  request_id uuid not null,
  before_state jsonb not null,
  after_state jsonb not null,
  reason text not null check(length(reason) between 1 and 300),
  previous_hash bytea not null check(octet_length(previous_hash)=32),
  event_hash bytea not null check(octet_length(event_hash)=32)
);
create table admin_private.staff_emergency_reviews (
  event_no bigint primary key references admin_private.staff_audit_events(event_no) on delete restrict,
  initiator_id uuid not null,
  target_id uuid not null,
  review_due_at timestamptz not null,
  reviewer_id uuid,
  reviewed_at timestamptz,
  decision text check(decision in ('accepted','rejected')),
  check ((reviewer_id is null and reviewed_at is null and decision is null)
      or (reviewer_id is not null and reviewed_at is not null and decision is not null)),
  check (reviewer_id is null or reviewer_id<>initiator_id)
);

do $secure$
declare t text;
begin
  foreach t in array array['bootstrap_control','staff_action_approvals',
    'staff_audit_head','staff_audit_events','staff_emergency_reviews'] loop
    execute format('revoke all on admin_private.%I from public,anon,authenticated,service_role,authenticator',t);
    execute format('alter table admin_private.%I enable row level security',t);
    execute format('alter table admin_private.%I force row level security',t);
  end loop;
end $secure$;
grant select on admin_private.bootstrap_control,admin_private.staff_action_approvals,
  admin_private.staff_audit_head,admin_private.staff_audit_events,
  admin_private.staff_emergency_reviews to admin_executor;
grant insert on admin_private.staff_action_approvals,admin_private.staff_audit_events to admin_executor;
grant insert on admin_private.staff_emergency_reviews to admin_executor;
grant update(reviewer_id,reviewed_at,decision) on admin_private.staff_emergency_reviews to admin_executor;
grant update(singleton,event_no,event_hash) on admin_private.staff_audit_head to admin_executor;
create policy executor_approvals_read on admin_private.staff_action_approvals
  for select to admin_executor using(true);
create policy executor_approvals_insert on admin_private.staff_action_approvals
  for insert to admin_executor with check(true);
create policy executor_audit_read on admin_private.staff_audit_events
  for select to admin_executor using(true);
create policy executor_audit_insert on admin_private.staff_audit_events
  for insert to admin_executor with check(true);
create policy executor_audit_head_read on admin_private.staff_audit_head
  for select to admin_executor using(true);
create policy executor_audit_head_update on admin_private.staff_audit_head
  for update to admin_executor using(true) with check(true);
create policy executor_emergency_read on admin_private.staff_emergency_reviews
  for select to admin_executor using(true);
create policy executor_emergency_insert on admin_private.staff_emergency_reviews
  for insert to admin_executor with check(true);
create policy executor_emergency_update on admin_private.staff_emergency_reviews
  for update to admin_executor using(true) with check(true);

-- No Auth-table grant is added to admin_executor. The migration role owns this
-- fixed-query helper; its non-anonymous/confirmed result is advisory only until
-- the operator has verified the actual identity outside the database.
create function admin_private.eligible_staff_identity(p_uid uuid)
returns boolean language sql security definer set search_path = ''
as $$
  select exists(select 1 from auth.users u where u.id=p_uid
    and not u.is_anonymous and u.deleted_at is null
    and (u.banned_until is null or u.banned_until <= pg_catalog.clock_timestamp())
    and (u.email_confirmed_at is not null or u.phone_confirmed_at is not null))
$$;
revoke all on function admin_private.eligible_staff_identity(uuid)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.eligible_staff_identity(uuid) to admin_executor;

-- Fixed reason codes prevent caller-controlled prose, credentials and contact
-- details from entering immutable role/grant rows or audit payloads.
create function admin_private.valid_staff_reason(p_reason text)
returns boolean language sql immutable set search_path = ''
as $$
  select coalesce(p_reason in ('bootstrap','staff_onboarding',
    'role_change','grant_change','periodic_review','emergency_revoke',
    'recovery','denied'),false)
$$;
revoke all on function admin_private.valid_staff_reason(text)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.valid_staff_reason(text) to admin_executor;

-- One serialized head update and an append in the caller's transaction.
-- A local DB owner can rewrite this chain: externally anchored daily heads
-- remain a separate staging/production security and privacy gate.
create function admin_private.append_staff_audit(
  p_actor uuid,p_sid uuid,p_target uuid,p_action text,p_resource text,
  p_policy bigint,p_decision text,p_outcome text,p_request uuid,
  p_before jsonb,p_after jsonb,p_reason text
) returns bigint language plpgsql security definer set search_path = ''
as $audit$
declare h record; n bigint; t timestamptz; digest bytea; payload jsonb;
begin
  if p_request is null or p_action is null or p_resource is null
     or not admin_private.valid_staff_reason(p_reason)
     or p_decision not in ('allow','deny') or p_outcome not in ('success','denied')
     or p_before is null or p_after is null then
    raise exception 'invalid staff audit event';
  end if;
  select * into h from admin_private.staff_audit_head where singleton for update;
  if not found then raise exception 'staff audit head missing'; end if;
  n := h.event_no+1; t := pg_catalog.clock_timestamp();
  payload := pg_catalog.jsonb_build_object('n',n,'at',t,'actor',p_actor,
    'sid',p_sid,'target',p_target,'action',p_action,'resource',p_resource,
    'policy',p_policy,'decision',p_decision,'outcome',p_outcome,
    'request',p_request,'before',p_before,'after',p_after,'reason',p_reason);
  digest := pg_catalog.sha256(h.event_hash || pg_catalog.convert_to(payload::text,'UTF8'));
  insert into admin_private.staff_audit_events(event_no,occurred_at,actor_id,session_id,
    target_id,action_key,resource_key,policy_version_id,decision,outcome,request_id,
    before_state,after_state,reason,previous_hash,event_hash)
  values(n,t,p_actor,p_sid,p_target,p_action,p_resource,p_policy,p_decision,p_outcome,
    p_request,p_before,p_after,p_reason,h.event_hash,digest);
  update admin_private.staff_audit_head set event_no=n,event_hash=digest where singleton;
  return n;
end $audit$;
revoke all on function admin_private.append_staff_audit(uuid,uuid,uuid,text,text,bigint,text,text,uuid,jsonb,jsonb,text)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.append_staff_audit(uuid,uuid,uuid,text,text,bigint,text,text,uuid,jsonb,jsonb,text)
  to admin_executor;

create function admin_private.record_staff_denial(
  p_actor uuid,p_target uuid,p_action text
) returns void language plpgsql security definer set search_path = ''
as $denial$
declare c jsonb; sid uuid; pol bigint;
begin
  -- Unverified/ordinary requests are rejected by PostgREST or active deny-all;
  -- avoid an unauthenticated public audit-flood endpoint.
  if p_actor is null then return; end if;
  c := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
  sid := (c->>'session_id')::uuid;
  pol := (select version_id from admin_private.active_policy where singleton);
  perform admin_private.append_staff_audit(p_actor,sid,p_target,p_action,
    'staff.denied',pol,'deny','denied',pg_catalog.gen_random_uuid(),
    '{}'::jsonb,'{}'::jsonb,'denied');
end $denial$;
revoke all on function admin_private.record_staff_denial(uuid,uuid,text)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.record_staff_denial(uuid,uuid,text)
  to admin_executor;

create function admin_private.schedule_emergency_review(
  p_event bigint,p_actor uuid,p_target uuid
) returns void language plpgsql security definer set search_path = ''
as $schedule$
declare t timestamptz:=pg_catalog.clock_timestamp(); d integer;
begin
  d := extract(isodow from t);
  insert into admin_private.staff_emergency_reviews(
    event_no,initiator_id,target_id,review_due_at)
  values(p_event,p_actor,p_target,t+
    pg_catalog.make_interval(days=>
      case when d=5 then 3 when d=6 then 2 else 1 end));
end $schedule$;
revoke all on function admin_private.schedule_emergency_review(bigint,uuid,uuid)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.schedule_emergency_review(bigint,uuid,uuid)
  to admin_executor;

-- All staff wrappers are fixed to staging. PostgREST verifies the JWT before
-- setting claims; callers cannot supply a role, policy, environment or sid.
-- A future production action requires a distinct reviewed migration.
create function admin_private.staff_actor(p_permission text)
returns uuid language plpgsql security definer set search_path = ''
as $actor$
declare c jsonb; uid uuid; sid uuid; pol bigint; now_at timestamptz; delegated boolean;
begin
  if p_permission not in ('staff.role.propose','staff.grant.propose',
    'staff.role.approve','staff.grant.approve','staff.access.revoke') then return null; end if;
  c := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
  if c is null or c->>'role' is distinct from 'authenticated'
     or c->>'aal' is distinct from 'aal2'
     or coalesce(c->>'sub','') !~* '^[0-9a-f-]{36}$'
     or coalesce(c->>'session_id','') !~* '^[0-9a-f-]{36}$' then return null; end if;
  uid := (c->>'sub')::uuid; sid := (c->>'session_id')::uuid;
  if not admin_private.authorize_action('admin.enter','staging','global',null)
     then return null; end if;
  if exists(select 1 from admin_private.session_revocations r
       where r.session_id=sid and r.user_id=uid)
     or not admin_private.fresh_totp_session(uid,sid) then
    perform admin_private.record_staff_denial(uid,null,p_permission);
    return null;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  if admin_private.authorize_action(p_permission,'staging','global',null) then
    -- The permission evaluator may have waited on a policy or staff lock.
    -- Recheck the authoritative MFA timestamp after that wait.
    if admin_private.authorize_action(p_permission,'staging','global',null)
       and admin_private.fresh_totp_session(uid,sid)
       then return uid; end if;
    perform admin_private.record_staff_denial(uid,null,p_permission);
    return null;
  end if;
  if p_permission not in ('staff.role.approve','staff.grant.approve','staff.access.revoke')
     then
    perform admin_private.record_staff_denial(uid,null,p_permission);
    return null;
  end if;
  -- A delegated Administrator may exercise only an individually approved,
  -- current, staging-scoped direct grant. Role union cannot create this grant.
  select true into delegated
    from admin_private.role_assignments a
    join admin_private.direct_grants g on g.user_id=a.user_id
    where a.user_id=uid and a.role_name='Administrator'
      and a.policy_version_id=pol and a.environment_scope='staging'
      and a.scope_kind='global' and a.status='active'
      and a.starts_at<=pg_catalog.clock_timestamp()
      and a.expires_at>pg_catalog.clock_timestamp()
      and a.review_due_at>pg_catalog.clock_timestamp()
      and g.permission_key=p_permission and g.policy_version_id=pol
      and g.environment_scope='staging' and g.scope_kind='global'
      and g.status='active' and g.starts_at<=pg_catalog.clock_timestamp()
      and g.expires_at>pg_catalog.clock_timestamp()
    order by a.assignment_id,g.grant_id limit 1 for share of a,g;
  if not coalesce(delegated,false) then
    perform admin_private.record_staff_denial(uid,null,p_permission);
    return null;
  end if;
  if not admin_private.fresh_totp_session(uid,sid)
     or not admin_private.authorize_action('admin.enter','staging','global',null)
     then
    perform admin_private.record_staff_denial(uid,null,p_permission);
    return null;
  end if;
  -- All relevant policy, Auth, subject, assignment and grant locks have been
  -- acquired. Read the clock now, after any lock wait, then decide expiry.
  now_at := pg_catalog.clock_timestamp();
  if not exists(select 1 from admin_private.role_assignments a
       join admin_private.direct_grants g on g.user_id=a.user_id
       where a.user_id=uid and a.role_name='Administrator'
         and a.policy_version_id=pol and a.environment_scope='staging'
         and a.scope_kind='global' and a.status='active'
         and a.starts_at<=now_at and a.expires_at>now_at and a.review_due_at>now_at
         and g.permission_key=p_permission and g.policy_version_id=pol
         and g.environment_scope='staging' and g.scope_kind='global'
         and g.status='active' and g.starts_at<=now_at and g.expires_at>now_at)
     or not admin_private.fresh_totp_session(uid,sid)
     then
    perform admin_private.record_staff_denial(uid,null,p_permission);
    return null;
  end if;
  return uid;
exception when invalid_text_representation or invalid_parameter_value then return null;
end $actor$;
revoke all on function admin_private.staff_actor(text)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.staff_actor(text) to admin_executor;
grant create on schema admin_private to admin_executor;
grant admin_executor to current_user;
alter function admin_private.staff_actor(text) owner to admin_executor;
revoke admin_executor from current_user;
revoke create on schema admin_private from admin_executor;

create function admin_private.require_staff_fresh_commit(p_permission text,p_actor uuid)
returns void language plpgsql security invoker set search_path = ''
as $commit$
begin
  if admin_private.staff_actor(p_permission) is distinct from p_actor then
    raise exception 'staff authority expired during protected write';
  end if;
end $commit$;
revoke all on function admin_private.require_staff_fresh_commit(text,uuid)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.require_staff_fresh_commit(text,uuid)
  to admin_executor;

-- A role ceiling cannot be bypassed by direct INSERT as the migration owner.
-- Existing 0020 columns are reused; expiration is checked by the 0021 evaluator.
create function admin_private.role_lifetime_guard()
returns trigger language plpgsql set search_path = ''
as $guard$
begin
  if new.role_name in ('Moderator','Editor') and
      (new.expires_at is null or new.expires_at>new.starts_at+interval '30 days')
     or new.role_name='Administrator' and
      (new.expires_at is null or new.expires_at>new.starts_at+interval '90 days')
     or new.role_name='Owner' and new.expires_at is not null then
    raise exception 'staff role lifetime exceeds ceiling';
  end if;
  return new;
end $guard$;
create trigger role_lifetime_guard before insert or update of role_name,starts_at,expires_at
  on admin_private.role_assignments for each row execute function admin_private.role_lifetime_guard();
revoke all on function admin_private.role_lifetime_guard()
  from public,anon,authenticated,service_role,authenticator;

-- Only the NOLOGIN executor can mutate staff rows. The API roles retain no
-- schema usage and cannot inherit this role. Every wrapper holds one global
-- staff-mutation lock before obtaining policy/Auth/subject row locks.
grant insert on admin_private.staff_subjects,admin_private.role_assignments,
  admin_private.direct_grants to admin_executor;
grant update(status,epoch,changed_at) on admin_private.staff_subjects to admin_executor;
grant update(status,approved_by,revoked_at) on admin_private.role_assignments to admin_executor;
grant update(status,approved_by,revoked_at) on admin_private.direct_grants to admin_executor;
create policy staff_writer_subject_insert on admin_private.staff_subjects
  for insert to admin_executor with check(true);
create policy staff_writer_subject_update on admin_private.staff_subjects
  for update to admin_executor using(true) with check(true);
create policy staff_writer_role_insert on admin_private.role_assignments
  for insert to admin_executor with check(true);
create policy staff_writer_role_update on admin_private.role_assignments
  for update to admin_executor using(true) with check(true);
create policy staff_writer_grant_insert on admin_private.direct_grants
  for insert to admin_executor with check(true);
create policy staff_writer_grant_update on admin_private.direct_grants
  for update to admin_executor using(true) with check(true);

create function admin_private.staff_is_owner(p_uid uuid,p_policy bigint)
returns boolean language sql security definer set search_path = ''
as $$
  select exists(select 1 from admin_private.role_assignments a
    join admin_private.staff_subjects s on s.user_id=a.user_id
    where a.user_id=p_uid and s.status='active' and a.role_name='Owner'
      and a.policy_version_id=p_policy and a.environment_scope='staging'
      and a.scope_kind='global' and a.status='active'
      and a.starts_at<=pg_catalog.clock_timestamp()
      and a.review_due_at>pg_catalog.clock_timestamp())
$$;
revoke all on function admin_private.staff_is_owner(uuid,bigint)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.staff_is_owner(uuid,bigint) to admin_executor;
grant create on schema admin_private to admin_executor;
grant admin_executor to current_user;
alter function admin_private.staff_is_owner(uuid,bigint) owner to admin_executor;
revoke admin_executor from current_user;
revoke create on schema admin_private from admin_executor;

-- Return false on a failed ceiling. No wildcard, admin.enter, audit.staff.read,
-- Owner role or production grant is ever individually delegated.
create function admin_private.staff_grant_ceiling(
  p_uid uuid,p_permission text,p_kind text,p_scope text,p_policy bigint
) returns boolean language plpgsql security definer set search_path = ''
as $ceiling$
declare role text;
begin
  if p_kind not in ('global','collection','article')
     or (p_kind='global' and p_scope is not null)
     or (p_kind<>'global' and
       (p_scope is null or p_scope !~ '^[a-z0-9][a-z0-9_-]{0,63}$'))
     then return false; end if;
  for role in select a.role_name from admin_private.role_assignments a
    where a.user_id=p_uid and a.policy_version_id=p_policy
      and a.environment_scope='staging' and a.status='active'
      and a.starts_at<=pg_catalog.clock_timestamp()
      and (a.expires_at is null or a.expires_at>pg_catalog.clock_timestamp())
      and a.review_due_at>pg_catalog.clock_timestamp()
      and a.scope_kind='global'
    order by a.assignment_id for share of a
  loop
    if role='Editor' and
      ((p_permission in ('news.article.publish','news.article.unpublish',
        'news.article.approve_highlighted','audit.editorial.read')
        and p_kind in ('article','collection')))
       or role='Administrator' and
      ((p_permission='news.article.publish' and p_kind in ('article','collection'))
       or (p_permission in ('staff.role.approve','staff.grant.approve',
         'staff.access.revoke','ops.status.read') and p_kind='global'))
       or role='Owner' and p_permission='ops.status.read' and p_kind='global'
       then return true; end if;
  end loop;
  return false;
end $ceiling$;
revoke all on function admin_private.staff_grant_ceiling(uuid,text,text,text,bigint)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.staff_grant_ceiling(uuid,text,text,text,bigint)
  to admin_executor;
grant create on schema admin_private to admin_executor;
grant admin_executor to current_user;
alter function admin_private.staff_grant_ceiling(uuid,text,text,text,bigint)
  owner to admin_executor;
revoke admin_executor from current_user;
revoke create on schema admin_private from admin_executor;

-- Request id is generated server-side in each wrapper. These are narrow
-- authenticated-only PostgREST entry points; no SQL text or environment input.
create function public.fdb_admin_staff_prepare(p_target uuid,p_reason text)
returns boolean language plpgsql security definer set search_path = ''
as $prepare$
declare actor uuid; pol bigint; sid uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  actor := admin_private.staff_actor('staff.role.propose');
  if actor is null or p_target is null or p_target=actor
     or not admin_private.valid_staff_reason(p_reason)
     or not admin_private.eligible_staff_identity(p_target) then
    perform admin_private.record_staff_denial(actor,p_target,'staff.prepare');
    return false;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  sid := (pg_catalog.current_setting('request.jwt.claims',true)::jsonb->>'session_id')::uuid;
  insert into admin_private.staff_subjects(user_id,status) values(p_target,'active')
    on conflict do nothing;
  if not found then
    perform admin_private.record_staff_denial(actor,p_target,'staff.prepare');
    return false;
  end if;
  perform admin_private.append_staff_audit(actor,sid,p_target,'staff.prepare',
    'staff.subject',pol,'allow','success',pg_catalog.gen_random_uuid(),
    '{}'::jsonb,pg_catalog.jsonb_build_object('status','active'),p_reason);
  perform admin_private.require_staff_fresh_commit('staff.role.propose',actor);
  return true;
end $prepare$;

create function public.fdb_admin_role_propose(
  p_target uuid,p_role text,p_days integer,p_reason text
) returns uuid language plpgsql security definer set search_path = ''
as $propose$
declare actor uuid; pol bigint; now_at timestamptz; id uuid; sid uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  actor := admin_private.staff_actor('staff.role.propose');
  if actor is null or p_target is null or p_target=actor
     or p_role is null or p_role not in ('Moderator','Editor','Administrator')
     or p_days is null or p_days<1 or p_days>
       (case when p_role='Administrator' then 90 else 30 end)
     or not admin_private.valid_staff_reason(p_reason)
     or not admin_private.eligible_staff_identity(p_target)
     then
    perform admin_private.record_staff_denial(actor,p_target,'staff.role.propose');
    return null;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  if p_role='Administrator' and not admin_private.staff_is_owner(actor,pol)
     then
    perform admin_private.record_staff_denial(actor,p_target,'staff.role.propose');
    return null;
  end if;
  perform 1 from admin_private.staff_subjects
    where user_id=p_target and status='active' for update;
  if not found then
    perform admin_private.record_staff_denial(actor,p_target,'staff.role.propose');
    return null;
  end if;
  now_at := pg_catalog.clock_timestamp();
  sid := (pg_catalog.current_setting('request.jwt.claims',true)::jsonb->>'session_id')::uuid;
  insert into admin_private.role_assignments(user_id,role_name,policy_version_id,
    environment_scope,scope_kind,starts_at,expires_at,review_due_at,status,
    proposal_id,proposed_by,reason)
  values(p_target,p_role,pol,'staging','global',now_at,now_at+
    pg_catalog.make_interval(days=>p_days),now_at+interval '90 days',
    'proposed',pg_catalog.gen_random_uuid(),actor,p_reason)
  returning assignment_id into id;
  perform admin_private.append_staff_audit(actor,sid,p_target,'staff.role.propose',
    id::text,pol,'allow','success',pg_catalog.gen_random_uuid(),'{}'::jsonb,
    pg_catalog.jsonb_build_object('role',p_role,'days',p_days,'status','proposed'),p_reason);
  perform admin_private.require_staff_fresh_commit('staff.role.propose',actor);
  return id;
end $propose$;

create function public.fdb_admin_role_approve(p_assignment uuid)
returns boolean language plpgsql security definer set search_path = ''
as $approve$
declare actor uuid; pol bigint; sid uuid; r record; n integer; owner_ok boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  actor := admin_private.staff_actor('staff.role.approve');
  if actor is null or p_assignment is null then
    perform admin_private.record_staff_denial(actor,null,'staff.role.approve');
    return false;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  owner_ok := admin_private.staff_is_owner(actor,pol);
  select * into r from admin_private.role_assignments
    where assignment_id=p_assignment for update;
  if not found or r.status<>'proposed' or r.policy_version_id<>pol
     or r.environment_scope<>'staging' or r.role_name='Owner'
     or r.user_id in (actor,r.proposed_by)
     or actor=r.proposed_by or r.expires_at<=pg_catalog.clock_timestamp()
     or (r.role_name='Administrator' and not owner_ok)
     or not admin_private.eligible_staff_identity(r.user_id)
     or not exists(select 1 from admin_private.staff_subjects
       where user_id=r.user_id and status='active')
     then
    perform admin_private.record_staff_denial(actor,r.user_id,'staff.role.approve');
    return false;
  end if;
  sid := (pg_catalog.current_setting('request.jwt.claims',true)::jsonb->>'session_id')::uuid;
  insert into admin_private.staff_action_approvals
    (proposal_kind,proposal_id,approver_id,policy_version_id)
    values('role',p_assignment,actor,pol) on conflict do nothing;
  if not found then
    perform admin_private.record_staff_denial(actor,r.user_id,'staff.role.approve');
    return false;
  end if;
  select count(*) into n from admin_private.staff_action_approvals ap
    where ap.proposal_kind='role' and ap.proposal_id=p_assignment
      and ap.policy_version_id=pol
      and (r.role_name<>'Administrator' or
        admin_private.staff_is_owner(ap.approver_id,pol));
  if n >= (case when r.role_name='Administrator' then 2 else 1 end) then
    update admin_private.role_assignments set status='revoked',revoked_at=pg_catalog.clock_timestamp()
      where user_id=r.user_id and role_name=r.role_name and environment_scope='staging'
        and scope_kind=r.scope_kind and scope_id is not distinct from r.scope_id
        and status='active';
    -- Replacement cannot carry grants from the old eligibility forward.
    update admin_private.direct_grants set status='revoked',revoked_at=pg_catalog.clock_timestamp()
      where user_id=r.user_id and status in ('active','proposed');
    update admin_private.role_assignments set status='active',approved_by=actor
      where assignment_id=p_assignment;
  end if;
  perform admin_private.append_staff_audit(actor,sid,r.user_id,'staff.role.approve',
    p_assignment::text,pol,'allow','success',pg_catalog.gen_random_uuid(),
    pg_catalog.jsonb_build_object('status','proposed'),
    pg_catalog.jsonb_build_object('status',case when n>=
      (case when r.role_name='Administrator' then 2 else 1 end)
      then 'active' else 'pending_second_approval' end,'approvals',n),r.reason);
  perform admin_private.require_staff_fresh_commit('staff.role.approve',actor);
  return true;
end $approve$;

create function public.fdb_admin_grant_propose(
  p_target uuid,p_permission text,p_scope_kind text,p_scope_id text,
  p_days integer,p_reason text
) returns uuid language plpgsql security definer set search_path = ''
as $propose$
declare actor uuid; pol bigint; now_at timestamptz; id uuid; sid uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  actor := admin_private.staff_actor('staff.grant.propose');
  if actor is null or p_target is null or p_target=actor
     or p_days is null or p_days<1 or p_days>90
     or p_permission is null or p_scope_kind is null
     or not admin_private.valid_staff_reason(p_reason) then
    perform admin_private.record_staff_denial(actor,p_target,'staff.grant.propose');
    return null;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  perform 1 from admin_private.staff_subjects where user_id=p_target
    and status='active' for update;
  if not found or not admin_private.staff_grant_ceiling(p_target,p_permission,
    p_scope_kind,p_scope_id,pol) then
    perform admin_private.record_staff_denial(actor,p_target,'staff.grant.propose');
    return null;
  end if;
  now_at := pg_catalog.clock_timestamp();
  sid := (pg_catalog.current_setting('request.jwt.claims',true)::jsonb->>'session_id')::uuid;
  insert into admin_private.direct_grants(user_id,permission_key,policy_version_id,
    environment_scope,scope_kind,scope_id,starts_at,expires_at,status,
    proposal_id,proposed_by,reason)
  values(p_target,p_permission,pol,'staging',p_scope_kind,p_scope_id,now_at,
    now_at+pg_catalog.make_interval(days=>p_days),'proposed',
    pg_catalog.gen_random_uuid(),actor,p_reason)
  returning grant_id into id;
  perform admin_private.append_staff_audit(actor,sid,p_target,'staff.grant.propose',
    id::text,pol,'allow','success',pg_catalog.gen_random_uuid(),'{}'::jsonb,
    pg_catalog.jsonb_build_object('permission',p_permission,
      'scope_kind',p_scope_kind,'scope_id',p_scope_id,'days',p_days),p_reason);
  perform admin_private.require_staff_fresh_commit('staff.grant.propose',actor);
  return id;
end $propose$;

create function public.fdb_admin_grant_approve(p_grant uuid)
returns boolean language plpgsql security definer set search_path = ''
as $approve$
declare actor uuid; pol bigint; sid uuid; g record; owner_ok boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  actor := admin_private.staff_actor('staff.grant.approve');
  if actor is null or p_grant is null then
    perform admin_private.record_staff_denial(actor,null,'staff.grant.approve');
    return false;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  owner_ok := admin_private.staff_is_owner(actor,pol);
  select * into g from admin_private.direct_grants where grant_id=p_grant for update;
  if not found or g.status<>'proposed' or g.policy_version_id<>pol
     or g.environment_scope<>'staging' or g.user_id in (actor,g.proposed_by)
     or actor=g.proposed_by or g.expires_at<=pg_catalog.clock_timestamp()
     or not exists(select 1 from admin_private.staff_subjects s
       where s.user_id=g.user_id and s.status='active')
     or not admin_private.staff_grant_ceiling(g.user_id,g.permission_key,
       g.scope_kind,g.scope_id,pol)
     or (not owner_ok and (g.permission_key in ('news.article.publish',
       'news.article.unpublish','news.article.approve_highlighted',
       'staff.role.approve','staff.grant.approve','staff.access.revoke')
       or not exists(select 1 from admin_private.role_assignments a
         where a.user_id=g.user_id and a.role_name in ('Editor','Moderator')
           and a.policy_version_id=pol and a.environment_scope='staging'
           and a.status='active' and a.scope_kind='global'
           and a.starts_at<=pg_catalog.clock_timestamp()
           and a.expires_at>pg_catalog.clock_timestamp()
           and a.review_due_at>pg_catalog.clock_timestamp())))
     then
    perform admin_private.record_staff_denial(actor,g.user_id,'staff.grant.approve');
    return false;
  end if;
  sid := (pg_catalog.current_setting('request.jwt.claims',true)::jsonb->>'session_id')::uuid;
  update admin_private.direct_grants set status='revoked',revoked_at=pg_catalog.clock_timestamp()
    where user_id=g.user_id and permission_key=g.permission_key
      and environment_scope='staging' and scope_kind=g.scope_kind
      and scope_id is not distinct from g.scope_id and status='active';
  update admin_private.direct_grants set status='active',approved_by=actor
    where grant_id=p_grant;
  perform admin_private.append_staff_audit(actor,sid,g.user_id,'staff.grant.approve',
    p_grant::text,pol,'allow','success',pg_catalog.gen_random_uuid(),
    pg_catalog.jsonb_build_object('status','proposed'),
    pg_catalog.jsonb_build_object('status','active','permission',g.permission_key),g.reason);
  perform admin_private.require_staff_fresh_commit('staff.grant.approve',actor);
  return true;
end $approve$;

create function public.fdb_admin_staff_suspend(p_target uuid,p_reason text)
returns boolean language plpgsql security definer set search_path = ''
as $suspend$
declare actor uuid; pol bigint; sid uuid; event_id bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  actor := admin_private.staff_actor('staff.access.revoke');
  if actor is null or p_target is null or p_target=actor
     or not admin_private.valid_staff_reason(p_reason) then
    perform admin_private.record_staff_denial(actor,p_target,'staff.suspend');
    return false;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  -- Owner changes require a separate two-witness operator/recovery ceremony.
  if exists(select 1 from admin_private.role_assignments
    where user_id=p_target and role_name='Owner' and status='active')
    or (not admin_private.staff_is_owner(actor,pol) and exists(
      select 1 from admin_private.role_assignments where user_id=p_target
        and role_name='Administrator' and status='active')) then
    perform admin_private.record_staff_denial(actor,p_target,'staff.suspend');
    return false;
  end if;
  update admin_private.staff_subjects set status='suspended',epoch=epoch+1,
    changed_at=pg_catalog.clock_timestamp()
    where user_id=p_target and status='active';
  if not found then
    perform admin_private.record_staff_denial(actor,p_target,'staff.suspend');
    return false;
  end if;
  update admin_private.role_assignments set status='revoked',revoked_at=pg_catalog.clock_timestamp()
    where user_id=p_target and status in ('active','proposed');
  update admin_private.direct_grants set status='revoked',revoked_at=pg_catalog.clock_timestamp()
    where user_id=p_target and status in ('active','proposed');
  sid := (pg_catalog.current_setting('request.jwt.claims',true)::jsonb->>'session_id')::uuid;
  event_id := admin_private.append_staff_audit(actor,sid,p_target,'staff.suspend',
    'staff.subject',pol,'allow','success',pg_catalog.gen_random_uuid(),
    pg_catalog.jsonb_build_object('status','active'),
    pg_catalog.jsonb_build_object('status','suspended','authority','revoked'),p_reason);
  perform admin_private.schedule_emergency_review(event_id,actor,p_target);
  perform admin_private.require_staff_fresh_commit('staff.access.revoke',actor);
  return true;
end $suspend$;

create function public.fdb_admin_staff_reinstate(p_target uuid,p_reason text)
returns boolean language plpgsql security definer set search_path = ''
as $reinstate$
declare actor uuid; pol bigint; sid uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  actor := admin_private.staff_actor('staff.role.approve');
  if actor is null or p_target is null or p_target=actor
     or not admin_private.valid_staff_reason(p_reason)
     or not admin_private.eligible_staff_identity(p_target) then
    perform admin_private.record_staff_denial(actor,p_target,'staff.reinstate');
    return false;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  if exists(select 1 from admin_private.role_assignments
     where user_id=p_target and role_name='Owner')
     or (not admin_private.staff_is_owner(actor,pol) and exists(
       select 1 from admin_private.role_assignments
       where user_id=p_target and role_name='Administrator')) then
    perform admin_private.record_staff_denial(actor,p_target,'staff.reinstate');
    return false;
  end if;
  update admin_private.staff_subjects set status='active',epoch=epoch+1,
    changed_at=pg_catalog.clock_timestamp()
    where user_id=p_target and status='suspended';
  if not found then
    perform admin_private.record_staff_denial(actor,p_target,'staff.reinstate');
    return false;
  end if;
  sid := (pg_catalog.current_setting('request.jwt.claims',true)::jsonb->>'session_id')::uuid;
  perform admin_private.append_staff_audit(actor,sid,p_target,'staff.reinstate',
    'staff.subject',pol,'allow','success',pg_catalog.gen_random_uuid(),
    pg_catalog.jsonb_build_object('status','suspended'),
    pg_catalog.jsonb_build_object('status','active','authority','none'),p_reason);
  perform admin_private.require_staff_fresh_commit('staff.role.approve',actor);
  return true;
end $reinstate$;

create function public.fdb_admin_role_revoke(p_assignment uuid,p_reason text)
returns boolean language plpgsql security definer set search_path = ''
as $revoke$
declare actor uuid; pol bigint; sid uuid; r record; event_id bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  actor := admin_private.staff_actor('staff.access.revoke');
  if actor is null or p_assignment is null
     or not admin_private.valid_staff_reason(p_reason) then
    perform admin_private.record_staff_denial(actor,null,'staff.role.revoke');
    return false;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  select * into r from admin_private.role_assignments
    where assignment_id=p_assignment for update;
  if not found or r.status<>'active' or r.role_name='Owner'
     or r.user_id=actor or (r.role_name='Administrator'
       and not admin_private.staff_is_owner(actor,pol)) then
    perform admin_private.record_staff_denial(actor,r.user_id,'staff.role.revoke');
    return false;
  end if;
  update admin_private.role_assignments set status='revoked',
    revoked_at=pg_catalog.clock_timestamp() where assignment_id=p_assignment;
  -- Grants are not tied to one assignment id in 0020. Conservatively revoke
  -- every target grant, so a later role reassignment cannot resurrect one.
  update admin_private.direct_grants set status='revoked',
    revoked_at=pg_catalog.clock_timestamp()
    where user_id=r.user_id and status in ('active','proposed');
  sid := (pg_catalog.current_setting('request.jwt.claims',true)::jsonb->>'session_id')::uuid;
  event_id := admin_private.append_staff_audit(actor,sid,r.user_id,'staff.role.revoke',
    p_assignment::text,pol,'allow','success',pg_catalog.gen_random_uuid(),
    pg_catalog.jsonb_build_object('status','active','role',r.role_name),
    pg_catalog.jsonb_build_object('status','revoked'),p_reason);
  perform admin_private.schedule_emergency_review(event_id,actor,r.user_id);
  perform admin_private.require_staff_fresh_commit('staff.access.revoke',actor);
  return true;
end $revoke$;

create function public.fdb_admin_grant_revoke(p_grant uuid,p_reason text)
returns boolean language plpgsql security definer set search_path = ''
as $revoke$
declare actor uuid; pol bigint; sid uuid; g record; event_id bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  actor := admin_private.staff_actor('staff.access.revoke');
  if actor is null or p_grant is null
     or not admin_private.valid_staff_reason(p_reason) then
    perform admin_private.record_staff_denial(actor,null,'staff.grant.revoke');
    return false;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  select * into g from admin_private.direct_grants where grant_id=p_grant for update;
  if not found or g.status<>'active' or g.user_id=actor
     or (not admin_private.staff_is_owner(actor,pol) and
       g.permission_key in ('news.article.publish','news.article.unpublish',
         'news.article.approve_highlighted','staff.role.approve','staff.grant.approve',
         'staff.access.revoke')) then
    perform admin_private.record_staff_denial(actor,g.user_id,'staff.grant.revoke');
    return false;
  end if;
  update admin_private.direct_grants set status='revoked',
    revoked_at=pg_catalog.clock_timestamp() where grant_id=p_grant;
  sid := (pg_catalog.current_setting('request.jwt.claims',true)::jsonb->>'session_id')::uuid;
  event_id := admin_private.append_staff_audit(actor,sid,g.user_id,'staff.grant.revoke',
    p_grant::text,pol,'allow','success',pg_catalog.gen_random_uuid(),
    pg_catalog.jsonb_build_object('status','active','permission',g.permission_key),
    pg_catalog.jsonb_build_object('status','revoked'),p_reason);
  perform admin_private.schedule_emergency_review(event_id,actor,g.user_id);
  perform admin_private.require_staff_fresh_commit('staff.access.revoke',actor);
  return true;
end $revoke$;

create function public.fdb_admin_emergency_review(p_event bigint,p_accept boolean)
returns boolean language plpgsql security definer set search_path = ''
as $review$
declare actor uuid; pol bigint; sid uuid; r record;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  actor := admin_private.staff_actor('staff.role.approve');
  if actor is null or p_event is null or p_accept is null then
    perform admin_private.record_staff_denial(actor,null,'staff.emergency.review');
    return false;
  end if;
  select * into r from admin_private.staff_emergency_reviews
    where event_no=p_event for update;
  if not found or r.reviewer_id is not null or r.initiator_id=actor
     or r.target_id=actor
     or (exists(select 1 from admin_private.role_assignments a
       where a.user_id=r.target_id and a.role_name in ('Administrator','Owner'))
       and not admin_private.staff_is_owner(actor,
         (select version_id from admin_private.active_policy where singleton))) then
    perform admin_private.record_staff_denial(actor,r.target_id,'staff.emergency.review');
    return false;
  end if;
  pol := (select version_id from admin_private.active_policy where singleton);
  sid := (pg_catalog.current_setting('request.jwt.claims',true)::jsonb->>'session_id')::uuid;
  update admin_private.staff_emergency_reviews
    set reviewer_id=actor,reviewed_at=pg_catalog.clock_timestamp(),
      decision=case when p_accept then 'accepted' else 'rejected' end
    where event_no=p_event and reviewer_id is null;
  perform admin_private.append_staff_audit(actor,sid,r.target_id,
    'staff.emergency.review',p_event::text,pol,'allow','success',
    pg_catalog.gen_random_uuid(),pg_catalog.jsonb_build_object('status','pending'),
    pg_catalog.jsonb_build_object('decision',case when p_accept then 'accepted'
      else 'rejected' end,'late',pg_catalog.clock_timestamp()>r.review_due_at),
    'periodic_review');
  perform admin_private.require_staff_fresh_commit('staff.role.approve',actor);
  return true;
end $review$;

-- Explicit ACLs keep the public RPC allowlist closed and reviewable.
revoke all on function public.fdb_admin_staff_prepare(uuid,text)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function public.fdb_admin_role_propose(uuid,text,integer,text)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function public.fdb_admin_role_approve(uuid)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function public.fdb_admin_grant_propose(uuid,text,text,text,integer,text)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function public.fdb_admin_grant_approve(uuid)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function public.fdb_admin_staff_suspend(uuid,text)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function public.fdb_admin_staff_reinstate(uuid,text)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function public.fdb_admin_role_revoke(uuid,text)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function public.fdb_admin_grant_revoke(uuid,text)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function public.fdb_admin_emergency_review(bigint,boolean)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function public.fdb_admin_staff_prepare(uuid,text) to authenticated;
grant execute on function public.fdb_admin_role_propose(uuid,text,integer,text) to authenticated;
grant execute on function public.fdb_admin_role_approve(uuid) to authenticated;
grant execute on function public.fdb_admin_grant_propose(uuid,text,text,text,integer,text)
  to authenticated;
grant execute on function public.fdb_admin_grant_approve(uuid) to authenticated;
grant execute on function public.fdb_admin_staff_suspend(uuid,text) to authenticated;
grant execute on function public.fdb_admin_staff_reinstate(uuid,text) to authenticated;
grant execute on function public.fdb_admin_role_revoke(uuid,text) to authenticated;
grant execute on function public.fdb_admin_grant_revoke(uuid,text) to authenticated;
grant execute on function public.fdb_admin_emergency_review(bigint,boolean) to authenticated;
-- The executor never gains public/schema CREATE after ownership transfer.
grant create on schema public to admin_executor;
grant admin_executor to current_user;
alter function public.fdb_admin_staff_prepare(uuid,text) owner to admin_executor;
alter function public.fdb_admin_role_propose(uuid,text,integer,text) owner to admin_executor;
alter function public.fdb_admin_role_approve(uuid) owner to admin_executor;
alter function public.fdb_admin_grant_propose(uuid,text,text,text,integer,text) owner to admin_executor;
alter function public.fdb_admin_grant_approve(uuid) owner to admin_executor;
alter function public.fdb_admin_staff_suspend(uuid,text) owner to admin_executor;
alter function public.fdb_admin_staff_reinstate(uuid,text) owner to admin_executor;
alter function public.fdb_admin_role_revoke(uuid,text) owner to admin_executor;
alter function public.fdb_admin_grant_revoke(uuid,text) owner to admin_executor;
alter function public.fdb_admin_emergency_review(bigint,boolean) owner to admin_executor;
revoke admin_executor from current_user;
revoke create on schema public from admin_executor;

-- The exact target and ticket are armed by a reviewed operator ceremony.
-- This command is private, owned by the migration operator, and has no Data API grant.
create function admin_private.arm_initial_owner(
  p_uid uuid,p_approval_digest bytea,p_until timestamptz,
  p_operator_id uuid,p_delegate_id uuid
) returns boolean language plpgsql security definer set search_path = ''
as $arm$
begin
  if p_uid is null or octet_length(p_approval_digest)<>32
     or p_operator_id is null or p_delegate_id is null
     or p_uid in (p_operator_id,p_delegate_id) or p_operator_id=p_delegate_id
     or p_until<=pg_catalog.clock_timestamp()
     or p_until>pg_catalog.clock_timestamp()+interval '15 minutes'
     or not admin_private.eligible_staff_identity(p_uid) then return false; end if;
  perform 1 from admin_private.active_policy where singleton for share;
  if (select version_id from admin_private.active_policy where singleton)<>0 then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  update admin_private.bootstrap_control
    set target_uid=p_uid,approval_digest=p_approval_digest,armed_until=p_until,
      operator_id=p_operator_id,delegate_id=p_delegate_id
    where singleton and consumed_at is null
      and (target_uid is null or armed_until<=pg_catalog.clock_timestamp());
  if not found then return false; end if;
  perform admin_private.append_staff_audit(p_operator_id,null,p_uid,
    'owner.bootstrap.arm','owner.initial',0,'allow','success',
    pg_catalog.gen_random_uuid(),'{}'::jsonb,
    pg_catalog.jsonb_build_object('armed_until',p_until,'delegate',p_delegate_id,
      'operator_role',session_user,
      'approval_digest',pg_catalog.encode(p_approval_digest,'hex')),'bootstrap');
  return true;
end $arm$;
revoke all on function admin_private.arm_initial_owner(uuid,bytea,timestamptz,uuid,uuid)
  from public,anon,authenticated,service_role,authenticator,admin_executor;

create function admin_private.bootstrap_initial_owner(
  p_uid uuid,p_sid uuid,p_approval_digest bytea,p_delegate_id uuid,
  p_request_id uuid,p_reason text
) returns boolean language plpgsql security definer set search_path = ''
as $bootstrap$
declare b record; before_state jsonb;
begin
  if p_uid is null or p_sid is null or p_delegate_id is null or p_delegate_id=p_uid
     or p_request_id is null or p_reason is distinct from 'bootstrap'
     or octet_length(p_approval_digest)<>32 then return false; end if;
  perform 1 from admin_private.active_policy where singleton for share;
  if (select version_id from admin_private.active_policy where singleton)<>0 then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  select * into b from admin_private.bootstrap_control where singleton for update;
  if not found or b.consumed_at is not null or b.target_uid is distinct from p_uid
     or b.approval_digest is distinct from p_approval_digest
     or b.delegate_id is distinct from p_delegate_id
     or b.armed_until<=pg_catalog.clock_timestamp()
     or not admin_private.eligible_staff_identity(p_uid)
     or not admin_private.live_auth_session(p_uid,p_sid)
     or not admin_private.fresh_totp_session(p_uid,p_sid)
     or exists(select 1 from admin_private.role_assignments where role_name='Owner')
     then
    perform admin_private.append_staff_audit(
      case when found then b.operator_id else null end,p_sid,p_uid,
      'owner.bootstrap','owner.initial',0,'deny','denied',p_request_id,
      '{}'::jsonb,'{}'::jsonb,'denied');
    return false;
  end if;
  before_state := pg_catalog.jsonb_build_object('bootstrap','armed');
  insert into admin_private.staff_subjects(user_id,status) values(p_uid,'active');
  insert into admin_private.role_assignments(user_id,role_name,policy_version_id,
    environment_scope,scope_kind,starts_at,expires_at,review_due_at,status,
    proposed_by,approved_by,reason)
  values(p_uid,'Owner',1,'staging','global',pg_catalog.clock_timestamp(),null,
    'infinity'::timestamptz,'active',null,p_delegate_id,p_reason);
  perform admin_private.append_staff_audit(b.operator_id,p_sid,p_uid,'owner.bootstrap',
    'owner.initial',0,'allow','success',p_request_id,before_state,
    pg_catalog.jsonb_build_object('bootstrap','consumed','delegate',p_delegate_id,
      'operator_role',session_user,
      'approval_digest',pg_catalog.encode(p_approval_digest,'hex')),p_reason);
  -- The audit/head write can wait. Expiry after that wait must undo the whole
  -- assignment and audit transaction, never leave a partially bootstrapped Owner.
  if not admin_private.fresh_totp_session(p_uid,p_sid)
     or not admin_private.live_auth_session(p_uid,p_sid) then
    raise exception 'bootstrap freshness expired during protected write';
  end if;
  update admin_private.bootstrap_control set consumed_at=pg_catalog.clock_timestamp()
    where singleton and consumed_at is null;
  if not found then raise exception 'bootstrap concurrent consumption'; end if;
  return true;
end $bootstrap$;
revoke all on function admin_private.bootstrap_initial_owner(uuid,uuid,bytea,uuid,uuid,text)
  from public,anon,authenticated,service_role,authenticator,admin_executor;

-- Reviewed operator/scheduler command; no Data API grant or automatic hosted
-- job. The 0021 evaluator already denies at expiry; this records the durable
-- transition and prevents old grants returning after a later role change.
create function admin_private.expire_staff_authority()
returns integer language plpgsql security definer set search_path = ''
as $expire$
declare r record; n integer:=0; event_id bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(247001,1);
  perform 1 from admin_private.active_policy where singleton for share;
  for r in select * from admin_private.role_assignments
    where status='active' and role_name<>'Owner'
      and (expires_at<=pg_catalog.clock_timestamp()
        or review_due_at<=pg_catalog.clock_timestamp())
    order by assignment_id for update
  loop
    update admin_private.role_assignments set status='revoked',
      revoked_at=pg_catalog.clock_timestamp() where assignment_id=r.assignment_id;
    update admin_private.direct_grants set status='revoked',
      revoked_at=pg_catalog.clock_timestamp()
      where user_id=r.user_id and status in ('active','proposed');
    event_id := admin_private.append_staff_audit(null,null,r.user_id,
      'staff.role.expire',r.assignment_id::text,r.policy_version_id,
      'allow','success',pg_catalog.gen_random_uuid(),
      pg_catalog.jsonb_build_object('status','active','role',r.role_name),
      pg_catalog.jsonb_build_object('status','revoked','dependent_grants','revoked'),
      'periodic_review');
    n:=n+1;
  end loop;
  for r in select * from admin_private.direct_grants
    where status='active' and expires_at<=pg_catalog.clock_timestamp()
    order by grant_id for update
  loop
    update admin_private.direct_grants set status='revoked',
      revoked_at=pg_catalog.clock_timestamp() where grant_id=r.grant_id;
    event_id := admin_private.append_staff_audit(null,null,r.user_id,
      'staff.grant.expire',r.grant_id::text,r.policy_version_id,
      'allow','success',pg_catalog.gen_random_uuid(),
      pg_catalog.jsonb_build_object('status','active','permission',r.permission_key),
      pg_catalog.jsonb_build_object('status','revoked'),'periodic_review');
    n:=n+1;
  end loop;
  return n;
end $expire$;
revoke all on function admin_private.expire_staff_authority()
  from public,anon,authenticated,service_role,authenticator,admin_executor;

commit;
