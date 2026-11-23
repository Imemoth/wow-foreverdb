-- ADM-03C private dispatch control. The 0025 outbox/intent remains immutable;
-- this additive state ledger records delivery transitions. Inert by default.
begin;
do $preflight$
begin
  if to_regclass('editorial_private.delivery_outbox') is null
     or to_regclass('editorial_private.delivery_state') is not null
     or to_regrole('admin_executor') is null
     or (select version_id from admin_private.active_policy where singleton)<>0
     or exists(select 1 from admin_private.staff_subjects)
     or to_regrole('azerdex_cms_dispatch') is not null then
    raise exception '0026 requires an inactive and empty 0025 foundation';
  end if;
end $preflight$;

create role azerdex_cms_dispatch nologin noinherit nosuperuser nocreatedb
  nocreaterole noreplication nobypassrls;
alter role azerdex_cms_dispatch connection limit 2;
alter role azerdex_cms_dispatch set statement_timeout = '15s';
alter role azerdex_cms_dispatch set idle_in_transaction_session_timeout = '10s';
grant usage on schema editorial_private to azerdex_cms_dispatch;

create table editorial_private.delivery_control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  reviewed_config_id uuid,
  check (not enabled or reviewed_config_id is not null)
);
insert into editorial_private.delivery_control(singleton) values(true);
-- Provision the same random 32-byte key into both isolated databases only in
-- a separately approved ceremony. Empty by default: no signed dispatch.
create table editorial_private.delivery_mac_key (
  singleton boolean primary key default true check(singleton),
  secret bytea not null check(pg_catalog.octet_length(secret)=32)
);
revoke all on editorial_private.delivery_mac_key from public,anon,authenticated,
  service_role,authenticator,azerdex_cms_dispatch;
alter table editorial_private.delivery_mac_key enable row level security;
alter table editorial_private.delivery_mac_key force row level security;
create policy executor_mac_read on editorial_private.delivery_mac_key
  for select to admin_executor using(true);
grant select on editorial_private.delivery_mac_key to admin_executor;
create table editorial_private.delivery_state (
  intent_id uuid primary key references editorial_private.publication_intents(intent_id) on delete restrict,
  article_id uuid not null references editorial_private.articles(article_id) on delete restrict,
  generation bigint not null check (generation>0),
  state text not null default 'blocked' check (state in
    ('blocked','eligible','claimed','delivered','retryable','cancelled','superseded')),
  attempt integer not null default 0 check (attempt>=0),
  claim_token uuid,
  lease_until timestamptz,
  public_receipt jsonb,
  public_applied_at timestamptz,
  is_compensation boolean not null default false,
  last_error_code text,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique(article_id,generation),
  check ((state='claimed')=(claim_token is not null and lease_until is not null)),
  check ((state='delivered')=(public_receipt is not null and public_applied_at is not null))
);
create index cms_delivery_work_idx on editorial_private.delivery_state(state,updated_at);
revoke all on editorial_private.delivery_control,editorial_private.delivery_state
  from public,anon,authenticated,service_role,authenticator,azerdex_cms_dispatch;
alter table editorial_private.delivery_control enable row level security;
alter table editorial_private.delivery_control force row level security;
alter table editorial_private.delivery_state enable row level security;
alter table editorial_private.delivery_state force row level security;
create policy executor_control_read on editorial_private.delivery_control
  for select to admin_executor using (true);
create policy executor_state_read on editorial_private.delivery_state
  for select to admin_executor using (true);
create policy executor_state_insert on editorial_private.delivery_state
  for insert to admin_executor with check (true);
create policy executor_state_update on editorial_private.delivery_state
  for update to admin_executor using (true) with check (true);
grant select on editorial_private.delivery_control,editorial_private.delivery_state to admin_executor;
grant insert,update on editorial_private.delivery_state to admin_executor;
grant update(published_revision_id) on editorial_private.articles to admin_executor;

-- The worker has no JWT and must never invent one. Re-evaluate the recorded
-- original actor under live database locks, not a caller-provided identity.
grant create on schema editorial_private to admin_executor;
grant admin_executor to current_user;
set role admin_executor;
create function editorial_private.cms_mac(p_message text)
returns text language plpgsql security invoker set search_path = '' as $mac$
declare k bytea; inner_pad bytea:=pg_catalog.decode(pg_catalog.repeat('36',64),'hex');
  outer_pad bytea:=pg_catalog.decode(pg_catalog.repeat('5c',64),'hex'); n integer;
begin
  select secret into k from editorial_private.delivery_mac_key where singleton;
  if k is null then raise exception 'CMS delivery MAC key is unprovisioned' using errcode='42501'; end if;
  for n in 0..31 loop
    inner_pad:=pg_catalog.set_byte(inner_pad,n,pg_catalog.get_byte(inner_pad,n)#pg_catalog.get_byte(k,n));
    outer_pad:=pg_catalog.set_byte(outer_pad,n,pg_catalog.get_byte(outer_pad,n)#pg_catalog.get_byte(k,n));
  end loop;
  return pg_catalog.encode(pg_catalog.sha256(outer_pad ||
    pg_catalog.sha256(inner_pad || pg_catalog.convert_to(p_message,'UTF8'))),'hex');
end $mac$;
create function editorial_private.delivery_eligible(p_intent uuid)
returns boolean language plpgsql security definer set search_path = '' as $eligible$
declare i editorial_private.publication_intents%rowtype;
  a editorial_private.articles%rowtype; ev admin_private.staff_audit_events%rowtype;
  pol bigint; at_time timestamptz; permission text; role_ok boolean:=false;
  default_ok boolean:=false; grant_ok boolean:=false; enter_ok boolean:=false;
  has_editor boolean:=false; has_administrator boolean:=false; has_owner boolean:=false;
  required_grant uuid; role_deadline timestamptz; grant_deadline timestamptz;
  r record; g record; ap editorial_private.approvals%rowtype;
  is_system boolean;
begin
  select * into i from editorial_private.publication_intents where intent_id=p_intent;
  if not found then return false; end if;
  select * into a from editorial_private.articles where article_id=i.article_id;
  if not found or a.generation<>i.generation then return false; end if;
  select is_compensation into is_system from editorial_private.delivery_state
    where intent_id=p_intent;
  if coalesce(is_system,false) then return i.kind='unpublish'; end if;
  select enabled into role_ok from editorial_private.delivery_control where singleton;
  if not coalesce(role_ok,false) then return false; end if;
  select version_id into pol from admin_private.active_policy where singleton for share;
  if pol=0 or not exists(select 1 from admin_private.policy_versions
       where version_id=pol and approval_state='approved' and activated_at is not null)
     then return false; end if;
  select * into ev from admin_private.staff_audit_events where event_no=i.audit_event_no;
  if not found or ev.actor_id is distinct from i.requested_by
     or ev.request_id is distinct from i.request_id
     or ev.policy_version_id<>pol
     or ev.resource_key is distinct from 'article:'||i.article_id::text
     or ev.action_key is distinct from (case i.kind when 'publish' then 'news.article.publish'
       else 'news.article.unpublish' end)
     or ev.session_id is null then return false; end if;
  permission:=ev.action_key;
  if ev.after_state ? 'action_grant' and ev.after_state->>'action_grant' is not null then
    required_grant:=(ev.after_state->>'action_grant')::uuid;
  end if;
  perform 1 from admin_private.staff_subjects
    where user_id=i.requested_by and status='active' for share;
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('admin-session:'||ev.session_id::text,0));
  if exists(select 1 from admin_private.session_revocations
       where user_id=i.requested_by and session_id=ev.session_id)
     or not admin_private.live_auth_session(i.requested_by,ev.session_id)
     or not admin_private.fresh_totp_session(i.requested_by,ev.session_id)
     then return false; end if;
  at_time:=pg_catalog.clock_timestamp();
  for r in select role_name,scope_kind,scope_id,expires_at,review_due_at
    from admin_private.role_assignments
    where user_id=i.requested_by and policy_version_id=pol
      and environment_scope='staging' and status='active'
      and starts_at<=at_time and (expires_at is null or expires_at>at_time)
      and review_due_at>at_time
      and (scope_kind='global' or (scope_kind='article' and scope_id=i.article_id::text)
        or (scope_kind='collection' and scope_id=a.collection_key))
    order by assignment_id for share loop
    if r.expires_at is not null and (role_deadline is null or r.expires_at<role_deadline)
      then role_deadline:=r.expires_at; end if;
    if r.review_due_at is not null and (role_deadline is null or r.review_due_at<role_deadline)
      then role_deadline:=r.review_due_at; end if;
    if r.role_name='Editor' then has_editor:=true; end if;
    if r.role_name='Administrator' then has_administrator:=true; end if;
    if r.role_name='Owner' then has_owner:=true; end if;
    if r.scope_kind='global' and exists(select 1 from admin_private.role_permissions
        where version_id=pol and role_name=r.role_name and permission_key='admin.enter')
      then enter_ok:=true; end if;
    if r.role_name in ('Owner','Administrator','Editor') then role_ok:=true; end if;
    if exists(select 1 from admin_private.role_permissions
        where version_id=pol and role_name=r.role_name and permission_key=permission)
       then default_ok:=true; end if;
  end loop;
  if not enter_ok or not role_ok then return false; end if;
  for g in select grant_id,expires_at from admin_private.direct_grants
    where user_id=i.requested_by and policy_version_id=pol
      and environment_scope='staging' and status='active'
      and permission_key=permission and starts_at<=at_time and expires_at>at_time
      and (required_grant is null or grant_id=required_grant)
      and ((scope_kind='article' and scope_id=i.article_id::text)
        or (scope_kind='collection' and scope_id=a.collection_key))
    order by grant_id for share loop
    grant_ok:=true; grant_deadline:=g.expires_at;
  end loop;
  at_time:=pg_catalog.clock_timestamp();
  if (role_deadline is not null and role_deadline<=at_time)
     or (grant_deadline is not null and grant_deadline<=at_time)
     or (required_grant is not null and not grant_ok)
     or not (default_ok or grant_ok)
     or (permission='news.article.publish' and not
       (has_owner or (has_editor and grant_ok) or (has_administrator and grant_ok)))
     or (permission='news.article.unpublish' and not
       (has_owner or has_administrator or (has_editor and grant_ok)))
     or not admin_private.live_auth_session(i.requested_by,ev.session_id)
     or not admin_private.fresh_totp_session(i.requested_by,ev.session_id)
     or exists(select 1 from admin_private.session_revocations
       where user_id=i.requested_by and session_id=ev.session_id)
     or (select version_id from admin_private.active_policy where singleton)<>pol
     or not exists(select 1 from admin_private.staff_subjects
       where user_id=i.requested_by and status='active') then return false; end if;
  if i.kind='publish' then
    if a.current_revision_id<>i.revision_id or a.classification_floor>
       (select effective_classification from editorial_private.revisions
         where revision_id=i.revision_id) then return false; end if;
    if exists(select 1 from editorial_private.revisions
         where revision_id=i.revision_id and effective_classification=1) then
      select ap.* into ap from editorial_private.approvals ap
        join editorial_private.approval_uses u on u.approval_id=ap.approval_id
        where u.intent_id=i.intent_id and ap.article_id=i.article_id
          and ap.revision_id=i.revision_id and ap.policy_version_id=pol;
      if not found or ap.approver_id=i.requested_by or not
         editorial_private.eligible_approver(ap.approver_id,i.article_id,pol,ap.grant_id)
         then return false; end if;
    end if;
  end if;
  return true;
end $eligible$;

-- A committed public write can race a later private revoke. A new, ordered
-- unpublish generation is the only safe compensation; never rewrite history.
create function editorial_private.cms_queue_compensation(p_source uuid)
returns uuid language plpgsql security definer set search_path = '' as $comp$
declare src editorial_private.publication_intents%rowtype;
  a editorial_private.articles%rowtype; next_intent uuid; next_request uuid;
  payload jsonb; digest bytea; audit_no bigint;
begin
  select * into src from editorial_private.publication_intents where intent_id=p_source;
  if not found then return null; end if;
  select * into a from editorial_private.articles where article_id=src.article_id for update;
  if a.generation<>src.generation then return null; end if;
  if not exists(select 1 from editorial_private.delivery_state
      where intent_id=p_source and state='cancelled') and
     (src.kind<>'publish' or not exists(select 1 from editorial_private.delivery_state
      where intent_id=p_source and state='delivered')) then return null; end if;
  next_intent:=pg_catalog.gen_random_uuid(); next_request:=pg_catalog.gen_random_uuid();
  payload:=pg_catalog.jsonb_build_object('kind','unpublish','article_id',a.article_id,
    'slug',a.slug,'generation',a.generation+1);
  digest:=pg_catalog.sha256(pg_catalog.convert_to(payload::text,'UTF8'));
  audit_no:=admin_private.append_staff_audit(null,null,null,'news.delivery.compensate',
    'article:'||a.article_id::text,(select version_id from admin_private.active_policy where singleton),
    'allow','success',next_request,'{}'::jsonb,
    pg_catalog.jsonb_build_object('source_intent',p_source,'new_intent',next_intent,
      'generation',a.generation+1),'editorial_action');
  update editorial_private.articles set generation=generation+1,
    review_state='unpublish_pending' where article_id=a.article_id;
  insert into editorial_private.publication_intents(intent_id,article_id,revision_id,
    generation,kind,requested_by,request_id,audit_event_no,payload_hash)
    values(next_intent,a.article_id,null,a.generation+1,'unpublish',src.requested_by,
      next_request,audit_no,digest);
  insert into editorial_private.delivery_outbox(intent_id,article_id,generation,payload,payload_hash)
    values(next_intent,a.article_id,a.generation+1,payload,digest);
  insert into editorial_private.delivery_state(intent_id,article_id,generation,is_compensation)
    values(next_intent,a.article_id,a.generation+1,true);
  return next_intent;
end $comp$;

-- Explicit state edges. Callers cannot choose a status or overwrite history.
create function editorial_private.cms_dispatch_qualify(p_intent uuid)
returns boolean language plpgsql security definer set search_path = '' as $qualify$
declare s editorial_private.delivery_state%rowtype; i editorial_private.publication_intents%rowtype;
begin
  if not editorial_private.delivery_eligible(p_intent) then return false; end if;
  select * into i from editorial_private.publication_intents where intent_id=p_intent;
  perform 1 from editorial_private.articles where article_id=i.article_id for update;
  insert into editorial_private.delivery_state(intent_id,article_id,generation,state)
    values(p_intent,i.article_id,i.generation,'blocked') on conflict(intent_id) do nothing;
  select * into s from editorial_private.delivery_state where intent_id=p_intent for update;
  if not (s.state in ('blocked','retryable') or
       (s.state='claimed' and s.lease_until<=pg_catalog.clock_timestamp()))
     or not editorial_private.delivery_eligible(p_intent)
     then return false; end if;
  update editorial_private.delivery_state set state='eligible',claim_token=null,
    lease_until=null,last_error_code=null,
    updated_at=pg_catalog.clock_timestamp() where intent_id=p_intent;
  return true;
end $qualify$;

create function editorial_private.cms_dispatch_claim(p_intent uuid)
returns jsonb language plpgsql security definer set search_path = '' as $claim$
declare i editorial_private.publication_intents%rowtype; s editorial_private.delivery_state%rowtype;
  o editorial_private.delivery_outbox%rowtype; a editorial_private.articles%rowtype;
  r editorial_private.revisions%rowtype; token uuid;
  lease_end timestamptz; expire_epoch bigint;
begin
  if not editorial_private.delivery_eligible(p_intent) then return null; end if;
  select * into i from editorial_private.publication_intents where intent_id=p_intent;
  select * into a from editorial_private.articles where article_id=i.article_id for update;
  select * into s from editorial_private.delivery_state where intent_id=p_intent for update;
  if not found or not (s.state='eligible' or
       (s.state='claimed' and s.lease_until<=pg_catalog.clock_timestamp()))
     or a.generation<>i.generation
     or not editorial_private.delivery_eligible(p_intent) then return null; end if;
  select * into o from editorial_private.delivery_outbox where intent_id=p_intent;
  if not found or o.payload_hash<>i.payload_hash or o.generation<>i.generation
     then raise exception 'outbox and intent disagree' using errcode='42501'; end if;
  if i.kind='publish' then
    select * into r from editorial_private.revisions where revision_id=i.revision_id;
    if not found or r.article_id<>i.article_id
       or pg_catalog.sha256(pg_catalog.convert_to(r.snapshot::text,'UTF8'))<>r.snapshot_hash
       or o.payload->>'revision_hash'<>pg_catalog.encode(r.snapshot_hash,'hex')
       then raise exception 'immutable revision integrity failure' using errcode='42501'; end if;
  end if;
  token:=pg_catalog.gen_random_uuid();
  lease_end:=pg_catalog.clock_timestamp()+interval '2 minutes';
  expire_epoch:=pg_catalog.floor(pg_catalog.date_part('epoch',lease_end))::bigint;
  update editorial_private.delivery_state set state='claimed',claim_token=token,
    lease_until=lease_end,attempt=attempt+1,
    updated_at=pg_catalog.clock_timestamp() where intent_id=p_intent;
  return o.payload||pg_catalog.jsonb_build_object('intent_id',p_intent,
    'payload_hash',pg_catalog.encode(o.payload_hash,'hex'),'claim_token',token,
    'is_compensation',s.is_compensation,'intent_created_at',i.created_at,
    'auth_expires_epoch',expire_epoch,
    'auth_mac',editorial_private.cms_mac(p_intent::text||':'||
      pg_catalog.encode(o.payload_hash,'hex')||':'||expire_epoch::text),
    'snapshot',case when i.kind='publish' then r.snapshot end);
end $claim$;

create function editorial_private.cms_dispatch_recheck(p_intent uuid,p_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $recheck$
declare s editorial_private.delivery_state%rowtype;
begin
  if p_token is null or not editorial_private.delivery_eligible(p_intent) then return false; end if;
  select * into s from editorial_private.delivery_state where intent_id=p_intent for share;
  return found and s.state='claimed' and s.claim_token=p_token
    and s.lease_until>pg_catalog.clock_timestamp()
    and editorial_private.delivery_eligible(p_intent);
end $recheck$;

-- A public receipt is recorded only after the worker reads it back from the
-- committed public projection. The worker credential remains a review gate.
create function editorial_private.cms_dispatch_ack(p_intent uuid,p_token uuid,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $ack$
declare i editorial_private.publication_intents%rowtype;
  s editorial_private.delivery_state%rowtype; a editorial_private.articles%rowtype;
  receipt_time timestamptz; comp uuid; still_ok boolean;
begin
  if p_token is null or p_receipt is null or pg_catalog.jsonb_typeof(p_receipt)<>'object'
     then return null; end if;
  select * into i from editorial_private.publication_intents where intent_id=p_intent;
  if not found then return null; end if;
  still_ok:=editorial_private.delivery_eligible(p_intent);
  select * into a from editorial_private.articles where article_id=i.article_id for update;
  select * into s from editorial_private.delivery_state where intent_id=p_intent for update;
  -- Re-evaluate after waiting for both protected rows. A revoke can commit
  -- between the first check and these locks; that requires compensation.
  still_ok:=still_ok and editorial_private.delivery_eligible(p_intent);
  if not found or s.state<>'claimed' or s.claim_token<>p_token
     or s.lease_until<=pg_catalog.clock_timestamp()
     or a.generation<>i.generation
     or p_receipt->>'intent_id' is distinct from i.intent_id::text
     or p_receipt->>'article_id' is distinct from i.article_id::text
     or (p_receipt->>'generation')::bigint is distinct from i.generation
     or p_receipt->>'kind' is distinct from i.kind
     or p_receipt->>'payload_hash' is distinct from pg_catalog.encode(i.payload_hash,'hex')
     or p_receipt->>'receipt_mac' is distinct from
       editorial_private.cms_mac((p_receipt-'receipt_mac')::text)
     then return null; end if;
  receipt_time:=(p_receipt->>'applied_at')::timestamptz;
  if receipt_time is null or receipt_time>pg_catalog.clock_timestamp()+interval '1 minute'
     then return null; end if;
  update editorial_private.delivery_state set state='delivered',claim_token=null,
    lease_until=null,public_receipt=p_receipt,public_applied_at=receipt_time,
    updated_at=pg_catalog.clock_timestamp() where intent_id=p_intent;
  update editorial_private.articles set published_revision_id=case when i.kind='publish'
      then i.revision_id else null end,
    review_state=case when i.kind='publish' then 'published' else 'unpublished' end
    where article_id=i.article_id;
  perform admin_private.append_staff_audit(null,null,null,'news.delivery.ack',
    'article:'||i.article_id::text,(select version_id from admin_private.active_policy where singleton),
    'allow','success',pg_catalog.gen_random_uuid(),'{}'::jsonb,
    pg_catalog.jsonb_build_object('intent',p_intent,'generation',i.generation,
      'receipt',p_receipt),'editorial_action');
  if i.kind='publish' and not still_ok then
    comp:=editorial_private.cms_queue_compensation(p_intent);
    if comp is null then raise exception 'revoked delivery needs compensation' using errcode='42501'; end if;
  end if;
  return pg_catalog.jsonb_build_object('acknowledged',true,'compensation_intent',comp);
exception when invalid_text_representation or invalid_parameter_value then return null;
end $ack$;

create function editorial_private.cms_dispatch_reconcile(p_article uuid)
returns boolean language plpgsql security definer set search_path = '' as $reconcile$
declare a editorial_private.articles%rowtype;
  src editorial_private.publication_intents%rowtype;
  s editorial_private.delivery_state%rowtype;
  signed_prior boolean;
  compensation uuid;
begin
  if not (select enabled from editorial_private.delivery_control where singleton)
    then return false; end if;
  select * into a from editorial_private.articles where article_id=p_article;
  if not found then return false; end if;
  select * into src from editorial_private.publication_intents
    where article_id=p_article and generation=a.generation;
  if not found or editorial_private.delivery_eligible(src.intent_id)
    then return false; end if;
  select * into a from editorial_private.articles where article_id=p_article for update;
  if a.generation<>src.generation then return false; end if;
  insert into editorial_private.delivery_state(intent_id,article_id,generation,state)
    values(src.intent_id,p_article,src.generation,'blocked') on conflict(intent_id) do nothing;
  select * into s from editorial_private.delivery_state
    where intent_id=src.intent_id for update;
  if not (s.state in ('blocked','eligible','retryable') or
       (s.state='claimed' and s.lease_until<=pg_catalog.clock_timestamp()))
     or editorial_private.delivery_eligible(src.intent_id) then return false; end if;
  signed_prior:=s.state='claimed' or exists(
    select 1 from editorial_private.delivery_state prior
    where prior.article_id=p_article and prior.generation<src.generation
      and prior.state='superseded' and prior.attempt>0);
  update editorial_private.delivery_state set state='cancelled',
    claim_token=null,lease_until=null,last_error_code='authorization_revoked',
    updated_at=pg_catalog.clock_timestamp()
    where intent_id=src.intent_id;
  update editorial_private.articles set review_state=case when src.kind='publish'
    then 'in_review' else 'delivery_failed' end
    where article_id=p_article;
  perform admin_private.append_staff_audit(null,null,null,'news.delivery.cancel',
    'article:'||p_article::text,
    (select version_id from admin_private.active_policy where singleton),
    'deny','denied',pg_catalog.gen_random_uuid(),'{}'::jsonb,
    pg_catalog.jsonb_build_object('intent',src.intent_id,'generation',src.generation,
      'code','authorization_revoked'),'editorial_action');
  if signed_prior then
    compensation:=editorial_private.cms_queue_compensation(src.intent_id);
    if compensation is null then
      raise exception 'signed delivery needs tombstone' using errcode='42501'; end if;
  end if;
  return true;
end $reconcile$;

create function editorial_private.cms_dispatch_fail(p_intent uuid,p_token uuid,p_code text)
returns boolean language plpgsql security definer set search_path = '' as $fail$
declare s editorial_private.delivery_state%rowtype;
begin
  if p_token is null or p_code is null or p_code !~ '^[a-z_]{3,40}$' then return false; end if;
  select * into s from editorial_private.delivery_state where intent_id=p_intent for update;
  if not found or s.state<>'claimed' or s.claim_token<>p_token then return false; end if;
  update editorial_private.delivery_state set state='retryable',claim_token=null,
    lease_until=null,last_error_code=p_code,updated_at=pg_catalog.clock_timestamp()
    where intent_id=p_intent;
  perform admin_private.append_staff_audit(null,null,null,'news.delivery.failure',
    'article:'||s.article_id::text,(select version_id from admin_private.active_policy where singleton),
    'deny','denied',pg_catalog.gen_random_uuid(),'{}'::jsonb,
    pg_catalog.jsonb_build_object('intent',p_intent,'code',p_code),'editorial_action');
  return true;
end $fail$;

create function editorial_private.cms_dispatch_cancel(p_intent uuid,p_token uuid,p_code text)
returns boolean language plpgsql security definer set search_path = '' as $cancel$
declare s editorial_private.delivery_state%rowtype; i editorial_private.publication_intents%rowtype;
  compensation uuid;
begin
  if p_token is null or p_code is null or p_code !~ '^[a-z_]{3,40}$' then return false; end if;
  select * into i from editorial_private.publication_intents where intent_id=p_intent;
  if not found then return false; end if;
  perform 1 from editorial_private.articles where article_id=i.article_id for update;
  select * into s from editorial_private.delivery_state where intent_id=p_intent for update;
  if not found or s.state<>'claimed' or s.claim_token<>p_token then return false; end if;
  update editorial_private.delivery_state set state='cancelled',claim_token=null,
    lease_until=null,last_error_code=p_code,updated_at=pg_catalog.clock_timestamp()
    where intent_id=p_intent;
  perform admin_private.append_staff_audit(null,null,null,'news.delivery.cancel',
    'article:'||s.article_id::text,(select version_id from admin_private.active_policy where singleton),
    'deny','denied',pg_catalog.gen_random_uuid(),'{}'::jsonb,
    pg_catalog.jsonb_build_object('intent',p_intent,'code',p_code),'editorial_action');
  if i.kind in ('publish','unpublish') then
    compensation:=editorial_private.cms_queue_compensation(p_intent);
    if compensation is null then raise exception 'cancelled claim needs tombstone' using errcode='42501'; end if;
  end if;
  return true;
end $cancel$;

create function editorial_private.cms_dispatch_recover(p_intent uuid,p_receipt jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $recover$
declare s editorial_private.delivery_state%rowtype;
begin
  perform editorial_private.delivery_eligible(p_intent);
  perform 1 from editorial_private.articles where article_id=(
    select article_id from editorial_private.publication_intents where intent_id=p_intent)
    for update;
  select * into s from editorial_private.delivery_state where intent_id=p_intent for update;
  if not found or s.state<>'claimed' or s.lease_until>pg_catalog.clock_timestamp()
     or s.claim_token is null then return null; end if;
  update editorial_private.delivery_state set lease_until=pg_catalog.clock_timestamp()+interval '1 minute'
    where intent_id=p_intent;
  return editorial_private.cms_dispatch_ack(p_intent,s.claim_token,p_receipt);
end $recover$;

create function editorial_private.cms_dispatch_candidates(p_limit integer)
returns setof uuid language sql security definer set search_path = '' as $$
  select o.intent_id from editorial_private.delivery_outbox o
    join editorial_private.articles a on a.article_id=o.article_id
      and a.generation=o.generation
    left join editorial_private.delivery_state s on s.intent_id=o.intent_id
  where ((select enabled from editorial_private.delivery_control where singleton)
    or coalesce(s.is_compensation,false))
    and (s.state is null or s.state in ('blocked','eligible','retryable')
      or (s.state='claimed' and s.lease_until<=pg_catalog.clock_timestamp()))
  order by coalesce(s.is_compensation,false) desc,o.created_at,o.intent_id
    limit least(greatest(coalesce(p_limit,0),0),20)
$$;

create function editorial_private.cms_dispatch_reconcile_candidates(p_limit integer)
returns setof uuid language sql security definer set search_path = '' as $$
  select a.article_id from editorial_private.articles a
    join editorial_private.publication_intents i on i.article_id=a.article_id
      and i.generation=a.generation
    left join editorial_private.delivery_state s on s.intent_id=i.intent_id
  where (select enabled from editorial_private.delivery_control where singleton)
    and (s.state is null or s.state in ('blocked','eligible','retryable') or
      (s.state='claimed' and s.lease_until<=pg_catalog.clock_timestamp()))
    and not editorial_private.delivery_eligible(i.intent_id)
  order by a.article_id limit least(greatest(coalesce(p_limit,0),0),20)
$$;

-- A newer protected intent fences all unfinished older deliveries. The old
-- signed envelope can still race across databases until expiry, so the
-- public projection also requires strictly increasing generations.
create function editorial_private.supersede_pending_delivery()
returns trigger language plpgsql security definer set search_path = '' as $supersede$
declare prior record;
begin
  if new.generation<=old.generation then return new; end if;
  for prior in update editorial_private.delivery_state
    set state='superseded',claim_token=null,lease_until=null,
      last_error_code='newer_generation',updated_at=pg_catalog.clock_timestamp()
    where article_id=new.article_id and generation<new.generation
      and state in ('blocked','eligible','claimed','retryable')
    returning intent_id,generation loop
    perform admin_private.append_staff_audit(null,null,null,'news.delivery.supersede',
      'article:'||new.article_id::text,
      (select version_id from admin_private.active_policy where singleton),
      'deny','denied',pg_catalog.gen_random_uuid(),'{}'::jsonb,
      pg_catalog.jsonb_build_object('old_intent',prior.intent_id,
        'old_generation',prior.generation,'new_generation',new.generation),
      'editorial_action');
  end loop;
  return new;
end $supersede$;

revoke all on function
  editorial_private.cms_mac(text),
  editorial_private.delivery_eligible(uuid),
  editorial_private.cms_queue_compensation(uuid),
  editorial_private.cms_dispatch_qualify(uuid),
  editorial_private.cms_dispatch_claim(uuid),
  editorial_private.cms_dispatch_recheck(uuid,uuid),
  editorial_private.cms_dispatch_ack(uuid,uuid,jsonb),
  editorial_private.cms_dispatch_reconcile(uuid),
  editorial_private.cms_dispatch_fail(uuid,uuid,text),
  editorial_private.cms_dispatch_cancel(uuid,uuid,text),
  editorial_private.cms_dispatch_recover(uuid,jsonb),
  editorial_private.cms_dispatch_candidates(integer),
  editorial_private.cms_dispatch_reconcile_candidates(integer),
  editorial_private.supersede_pending_delivery()
  from public,anon,authenticated,service_role,authenticator;
grant execute on function
  editorial_private.cms_dispatch_qualify(uuid),
  editorial_private.cms_dispatch_claim(uuid),
  editorial_private.cms_dispatch_recheck(uuid,uuid),
  editorial_private.cms_dispatch_ack(uuid,uuid,jsonb),
  editorial_private.cms_dispatch_reconcile(uuid),
  editorial_private.cms_dispatch_fail(uuid,uuid,text),
  editorial_private.cms_dispatch_cancel(uuid,uuid,text),
  editorial_private.cms_dispatch_recover(uuid,jsonb),
  editorial_private.cms_dispatch_candidates(integer),
  editorial_private.cms_dispatch_reconcile_candidates(integer)
  to azerdex_cms_dispatch;
reset role;
grant execute on function editorial_private.supersede_pending_delivery() to current_user;
create trigger cms_supersede_pending after update of generation on editorial_private.articles
  for each row execute function editorial_private.supersede_pending_delivery();
revoke execute on function editorial_private.supersede_pending_delivery() from current_user;
revoke admin_executor from current_user;
revoke create on schema editorial_private from admin_executor;

-- The 0025 guard remains authoritative; only a delivered receipt may move
-- the public pointer. No caller receives an UPDATE grant on articles.
alter table editorial_private.articles drop constraint articles_review_state_check;
alter table editorial_private.articles add constraint articles_review_state_check
  check (review_state in ('draft','in_review','approved','rejected',
    'publish_pending','unpublish_pending','published','unpublished','delivery_failed'));
create or replace function editorial_private.guard_article_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='DELETE' then raise exception 'CMS article deletion forbidden' using errcode='42501'; end if;
  if new.article_id is distinct from old.article_id or new.slug is distinct from old.slug
     or new.collection_key is distinct from old.collection_key or new.origin is distinct from old.origin
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     or new.create_request_id is distinct from old.create_request_id
     or new.classification_floor < old.classification_floor or new.generation < old.generation
     or (new.published_revision_id is distinct from old.published_revision_id and
       (current_user<>'admin_executor' or not exists(
         select 1 from editorial_private.delivery_state s
         where s.article_id=new.article_id and s.generation=new.generation
           and s.state='delivered' and s.public_receipt is not null))) then
    raise exception 'immutable CMS identity, floor or unacknowledged public pointer' using errcode='42501';
  end if;
  return new;
end $$;
commit;
