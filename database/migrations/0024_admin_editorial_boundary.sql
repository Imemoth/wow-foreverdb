-- ADM-01B-5: inactive private editorial authorization boundary.
-- No CMS article or revision source is present yet. This migration exposes no
-- public RPC and grants no content write. ADM-03 must supply authoritative
-- immutable revisions before any publication action can be implemented.
begin;

do $preflight$
begin
  if to_regprocedure('admin_private.authorize_action(text,text,text,text)') is null
     or to_regprocedure('admin_private.fresh_totp_session(uuid,uuid)') is null
     or to_regprocedure('admin_private.append_staff_audit(uuid,uuid,uuid,text,text,bigint,text,text,uuid,jsonb,jsonb,text)') is null
     or to_regprocedure('admin_private.editorial_actor(text,text)') is not null
     or (select version_id from admin_private.active_policy where singleton) <> 0
     or exists(select 1 from admin_private.staff_subjects) then
    raise exception '0024 pre-flight: inactive Admin foundation required';
  end if;
end $preflight$;

-- This function is callable only by the no-login executor. A future narrow,
-- reviewed PostgREST wrapper must take its identity from a verified JWT and
-- call this, its protected write and audit append in one database transaction.
-- No caller-supplied identity, environment, role or permission is accepted by
-- that wrapper. The function is intentionally fixed to staging and article
-- scope. It does not validate CMS state, revisions or publication approvals.
create function admin_private.editorial_actor(p_permission text,p_article_id text)
returns uuid language plpgsql security definer set search_path = ''
as $actor$
declare c jsonb; uid uuid; sid uuid;
begin
  if p_permission is null or p_permission not in
       ('news.draft.write','news.article.submit',
        'news.article.approve_highlighted','news.article.publish',
        'news.article.unpublish')
     or p_article_id is null
     or p_article_id !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    return null;
  end if;
  -- Evaluator validates verified PostgREST claims, live Auth session, active
  -- policy/version, staff, role/grant and resource scope under row locks.
  if not admin_private.authorize_action('admin.enter','staging','global',null)
     or not admin_private.authorize_action(p_permission,'staging','article',p_article_id) then
    return null;
  end if;
  c := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
  uid := (c->>'sub')::uuid;
  sid := (c->>'session_id')::uuid;
  -- A checked absence cannot be row-locked. Serialize it with the paired
  -- Admin logout RPC using the same session-keyed transaction advisory lock.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('admin-session:'||sid::text,0));
  if exists(select 1 from admin_private.session_revocations r
       where r.user_id=uid and r.session_id=sid)
     or not admin_private.fresh_totp_session(uid,sid) then
    return null;
  end if;
  -- Re-evaluate after any MFA lock wait, including database-clock expiries.
  if not admin_private.authorize_action(p_permission,'staging','article',p_article_id)
     or not admin_private.fresh_totp_session(uid,sid) then
    return null;
  end if;
  return uid;
exception when invalid_text_representation or invalid_parameter_value then
  return null;
end $actor$;
revoke all on function admin_private.editorial_actor(text,text)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.editorial_actor(text,text) to admin_executor;
grant create on schema admin_private to admin_executor;
grant admin_executor to current_user;
alter function admin_private.editorial_actor(text,text) owner to admin_executor;
revoke admin_executor from current_user;
revoke create on schema admin_private from admin_executor;

-- The paired logout writer takes an exclusive lock before inserting the
-- revocation. A logout committed first is seen by the next editorial check;
-- an editorial transaction holding the shared lock commits before logout.
grant admin_executor to current_user;
grant create on schema public to admin_executor;
set local role admin_executor;
create or replace function public.fdb_admin_session_revoke()
returns boolean language plpgsql security definer set search_path = ''
as $revoke$
declare v_claims jsonb; v_uid uuid; v_sid uuid;
begin
  v_claims := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
  if v_claims is null or v_claims->>'role' is distinct from 'authenticated'
     or coalesce(v_claims->>'sub','') !~* '^[0-9a-f-]{36}$'
     or coalesce(v_claims->>'session_id','') !~* '^[0-9a-f-]{36}$' then return false; end if;
  v_uid := (v_claims->>'sub')::uuid;
  v_sid := (v_claims->>'session_id')::uuid;
  if not admin_private.live_auth_session(v_uid,v_sid) then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('admin-session:'||v_sid::text,0));
  insert into admin_private.session_revocations (session_id,user_id) values (v_sid,v_uid)
    on conflict (session_id) do nothing;
  return true;
exception when invalid_text_representation then return false;
end $revoke$;
reset role;
revoke create on schema public from admin_executor;
revoke admin_executor from current_user;

-- Reuse the serialized Admin audit chain. Editorial evidence is kept as
-- metadata only by the eventual action wrapper, never draft body or media.
create or replace function admin_private.valid_staff_reason(p_reason text)
returns boolean language sql immutable set search_path = ''
as $$
  select coalesce(p_reason in ('bootstrap','staff_onboarding',
    'role_change','grant_change','periodic_review','emergency_revoke',
    'recovery','denied','editorial_action'),false)
$$;

create function admin_private.append_editorial_audit(
  p_permission text,p_article_id text,p_actor uuid,p_request uuid,
  p_before jsonb,p_after jsonb
) returns bigint language plpgsql security definer set search_path = ''
as $audit$
declare c jsonb; sid uuid; pol bigint;
begin
  if p_actor is null or p_request is null or p_before is null or p_after is null
     or admin_private.editorial_actor(p_permission,p_article_id) is distinct from p_actor
     then raise exception 'editorial authority expired before audit append'; end if;
  c := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
  sid := (c->>'session_id')::uuid;
  select version_id into pol from admin_private.active_policy where singleton for share;
  return admin_private.append_staff_audit(p_actor,sid,null,p_permission,
    'article:'||p_article_id,pol,'allow','success',p_request,
    p_before,p_after,'editorial_action');
end $audit$;
revoke all on function admin_private.append_editorial_audit(text,text,uuid,uuid,jsonb,jsonb)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function admin_private.append_editorial_audit(text,text,uuid,uuid,jsonb,jsonb)
  to admin_executor;
grant create on schema admin_private to admin_executor;
grant admin_executor to current_user;
alter function admin_private.append_editorial_audit(text,text,uuid,uuid,jsonb,jsonb)
  owner to admin_executor;
revoke admin_executor from current_user;
revoke create on schema admin_private from admin_executor;

commit;
