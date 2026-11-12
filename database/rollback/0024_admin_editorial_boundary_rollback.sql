-- Rehearse only on a disposable database. There is no persistent 0024 state.
begin;
-- Never discard an editorial event. Restore the 0023 reason contract only
-- when this slice has no committed audit use.
do $guard$
begin
  if exists(select 1 from admin_private.staff_audit_events
      where reason='editorial_action') then
    raise exception '0024 rollback: editorial audit exists; preserve and escalate';
  end if;
end $guard$;
drop function admin_private.append_editorial_audit(text,text,uuid,uuid,jsonb,jsonb);
drop function admin_private.editorial_actor(text,text);
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
  insert into admin_private.session_revocations (session_id,user_id) values (v_sid,v_uid)
    on conflict (session_id) do nothing;
  return true;
exception when invalid_text_representation then return false;
end $revoke$;
reset role;
revoke create on schema public from admin_executor;
revoke admin_executor from current_user;
create or replace function admin_private.valid_staff_reason(p_reason text)
returns boolean language sql immutable set search_path = ''
as $$
  select coalesce(p_reason in ('bootstrap','staff_onboarding',
    'role_change','grant_change','periodic_review','emergency_revoke',
    'recovery','denied'),false)
$$;
commit;
