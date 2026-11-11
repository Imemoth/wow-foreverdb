-- ADM-01B-3: inactive, staging-only Admin entry and single-use handoff.
-- Never apply to hosted environments without the separate target review.
-- No role is assigned, policy 0 remains deny-all, and no protected mutation exists.
begin;

do $preflight$
begin
    if to_regprocedure('admin_private.authorize_action(text,text,text,text)') is null
       or to_regclass('admin_private.handoff_tokens') is not null
       or to_regclass('admin_private.session_revocations') is not null
       or (select version_id from admin_private.active_policy where singleton) <> 0
       or exists (select 1 from admin_private.staff_subjects) then
        raise exception '0022 pre-flight: inert 0020/0021 foundation required';
    end if;
    if not (select rolbypassrls or rolsuper from pg_roles where rolname=current_user)
       or not has_table_privilege(current_user,'auth.sessions','SELECT')
       or not has_table_privilege(current_user,'auth.sessions','UPDATE')
       or not has_table_privilege(current_user,'auth.mfa_factors','SELECT')
       or not has_table_privilege(current_user,'auth.mfa_factors','UPDATE')
       or not has_table_privilege(current_user,'auth.mfa_amr_claims','SELECT')
       or not has_table_privilege(current_user,'auth.mfa_amr_claims','UPDATE') then
        raise exception '0022 pre-flight: migration role lacks MFA read/lock privileges';
    end if;
    if not exists (select 1 from information_schema.columns where table_schema='auth' and table_name='sessions' and column_name='factor_id')
       or not exists (select 1 from information_schema.columns where table_schema='auth' and table_name='sessions' and column_name='aal')
       or not exists (select 1 from information_schema.columns where table_schema='auth' and table_name='mfa_factors' and column_name='factor_type')
       or not exists (select 1 from information_schema.columns where table_schema='auth' and table_name='mfa_factors' and column_name='status')
       or not exists (select 1 from information_schema.columns where table_schema='auth' and table_name='mfa_amr_claims' and column_name='updated_at') then
        raise exception '0022 pre-flight: pinned GoTrue MFA schema missing';
    end if;
end $preflight$;

create table admin_private.handoff_tokens (
    token_hash bytea primary key,
    user_id uuid not null,
    session_id uuid not null,
    created_at timestamptz not null default clock_timestamp(),
    expires_at timestamptz not null,
    consumed_at timestamptz,
    constraint handoff_token_hash_sha256 check (octet_length(token_hash)=32),
    constraint handoff_token_short_life check (expires_at <= created_at + interval '60 seconds')
);
create index handoff_tokens_expiry on admin_private.handoff_tokens (expires_at);
create table admin_private.session_revocations (
    session_id uuid primary key,
    user_id uuid not null,
    revoked_at timestamptz not null default clock_timestamp()
);
alter table admin_private.handoff_tokens enable row level security;
alter table admin_private.handoff_tokens force row level security;
alter table admin_private.session_revocations enable row level security;
alter table admin_private.session_revocations force row level security;
revoke all on admin_private.handoff_tokens, admin_private.session_revocations from public, anon, authenticated, service_role, authenticator;
grant select, insert, update on admin_private.handoff_tokens to admin_executor;
grant select, insert on admin_private.session_revocations to admin_executor;
create policy admin_executor_handoff on admin_private.handoff_tokens for all to admin_executor using (true) with check (true);
create policy admin_executor_revocation_read on admin_private.session_revocations for select to admin_executor using (true);
create policy admin_executor_revocation_insert on admin_private.session_revocations for insert to admin_executor with check (true);

-- The migration role has reviewed, existing BYPASSRLS access to managed Auth.
-- Keep that access in a fixed-query helper; admin_executor gets no Auth grants.
create function admin_private.fresh_totp_session(p_uid uuid, p_sid uuid)
returns boolean language plpgsql security definer set search_path = ''
as $mfa$
declare
    v_now timestamptz;
    v_amr_at timestamptz;
    v_aal text;
    v_factor_type text;
    v_factor_status text;
begin
    select amr.updated_at, s.aal::text, f.factor_type::text, f.status::text
      into v_amr_at, v_aal, v_factor_type, v_factor_status
    from auth.sessions s join auth.mfa_factors f on f.id=s.factor_id and f.user_id=s.user_id
      join auth.mfa_amr_claims amr on amr.session_id=s.id and amr.authentication_method='totp'
    where s.id=p_sid and s.user_id=p_uid
    for share of s,f,amr;
    if not found then return false; end if;
    -- A lock wait can cross the 15-minute boundary. Compare the locked row
    -- against a new database clock reading at the final decision point.
    v_now := pg_catalog.clock_timestamp();
    return v_aal='aal2' and v_factor_type='totp' and v_factor_status='verified'
       and v_amr_at > v_now - interval '15 minutes'
       and v_amr_at <= v_now + interval '30 seconds';
end $mfa$;
revoke all on function admin_private.fresh_totp_session(uuid,uuid) from public, anon, authenticated, service_role, authenticator;
grant execute on function admin_private.fresh_totp_session(uuid,uuid) to admin_executor;

-- PostgREST verifies the JWT before setting request.jwt.claims. These narrow
-- wrappers take no uid, sid, role, environment or permission from the caller.
-- The only environment this isolated slice can evaluate is staging.
create function public.fdb_admin_entry_ready()
returns boolean language plpgsql security definer set search_path = ''
as $entry$
declare v_claims jsonb; v_uid uuid; v_sid uuid;
begin
    if not admin_private.authorize_action('admin.enter','staging','global',null) then return false; end if;
    v_claims := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
    v_uid := (v_claims->>'sub')::uuid;
    v_sid := (v_claims->>'session_id')::uuid;
    if exists (select 1 from admin_private.session_revocations where session_id=v_sid and user_id=v_uid) then return false; end if;
    if not admin_private.fresh_totp_session(v_uid,v_sid) then return false; end if;
    -- The MFA row lock can wait past an assignment review/expiry deadline.
    -- Re-evaluate with the current clock after that wait, still holding the
    -- policy, subject, assignment and Auth locks from the first evaluation.
    return admin_private.authorize_action('admin.enter','staging','global',null);
exception when invalid_text_representation or invalid_parameter_value then return false;
end $entry$;

create function public.fdb_admin_handoff_start(p_token text)
returns boolean language plpgsql security definer set search_path = ''
as $start$
declare v_claims jsonb; v_uid uuid; v_sid uuid; v_now timestamptz;
begin
    if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$'
       or not public.fdb_admin_entry_ready() then return false; end if;
    v_claims := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
    v_uid := (v_claims->>'sub')::uuid;
    v_sid := (v_claims->>'session_id')::uuid;
    v_now := pg_catalog.clock_timestamp();
    insert into admin_private.handoff_tokens (token_hash,user_id,session_id,created_at,expires_at)
    values (pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8')),v_uid,v_sid,v_now,v_now+interval '60 seconds');
    return public.fdb_admin_entry_ready();
exception when unique_violation then return false;
end $start$;

create function public.fdb_admin_handoff_redeem(p_token text)
returns boolean language plpgsql security definer set search_path = ''
as $redeem$
declare v_claims jsonb; v_uid uuid; v_sid uuid;
begin
    if p_token is null or p_token !~ '^[A-Za-z0-9_-]{43}$'
       or not public.fdb_admin_entry_ready() then return false; end if;
    v_claims := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
    v_uid := (v_claims->>'sub')::uuid;
    v_sid := (v_claims->>'session_id')::uuid;
    update admin_private.handoff_tokens h set consumed_at=pg_catalog.clock_timestamp()
    where h.token_hash=pg_catalog.sha256(pg_catalog.convert_to(p_token,'UTF8'))
      and h.user_id=v_uid and h.session_id=v_sid
      and h.consumed_at is null and h.expires_at>pg_catalog.clock_timestamp();
    if not found then return false; end if;
    return public.fdb_admin_entry_ready();
end $redeem$;

-- Local Account logout records a paired Admin denial before GoTrue local
-- logout. This never revokes the independent Companion session.
create function public.fdb_admin_session_revoke()
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

revoke all on function public.fdb_admin_entry_ready() from public, anon, authenticated, service_role, authenticator;
revoke all on function public.fdb_admin_handoff_start(text) from public, anon, authenticated, service_role, authenticator;
revoke all on function public.fdb_admin_handoff_redeem(text) from public, anon, authenticated, service_role, authenticator;
revoke all on function public.fdb_admin_session_revoke() from public, anon, authenticated, service_role, authenticator;
grant execute on function public.fdb_admin_entry_ready() to authenticated;
grant execute on function public.fdb_admin_handoff_start(text) to authenticated;
grant execute on function public.fdb_admin_handoff_redeem(text) to authenticated;
grant execute on function public.fdb_admin_session_revoke() to authenticated;
grant create on schema public to admin_executor;
grant admin_executor to current_user;
alter function public.fdb_admin_entry_ready() owner to admin_executor;
alter function public.fdb_admin_handoff_start(text) owner to admin_executor;
alter function public.fdb_admin_handoff_redeem(text) owner to admin_executor;
alter function public.fdb_admin_session_revoke() owner to admin_executor;
revoke admin_executor from current_user;
revoke create on schema public from admin_executor;
commit;
