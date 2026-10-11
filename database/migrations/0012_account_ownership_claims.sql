-- ForeverDB 0012: Account System V1 - installation ownership claims and the private Guildbook account API.
--
-- Moves public.installations.owner_user_id from an ANONYMOUS Supabase Auth owner to a REGISTERED, email-confirmed account
-- through a one-time, 128-bit, hash-only claim code, atomically and without touching a single observation, location, item,
-- source, session or Guildbook row. Specification (binding): docs/account-v1/ownership-claim-protocol.md and
-- docs/account-v1/pr-obligations.md. Deployment, rollback and incident recovery: docs/account-v1/0012-deployment-and-recovery.md.
--
-- SECURITY MODEL (summary)
--   * Every account function runs a LIVE-SESSION identity guard as its first statement (private.fdb_caller and the
--     anonymous/registered variants): the JWT's session_id must exist in auth.sessions for the same user, be unexpired, and
--     the user must be neither deleted nor banned. Signature validity and `exp` alone are never trusted.
--   * claim_start and claim_redeem take the SAME per-installation advisory lock as ingest, then re-verify the session row(s)
--     with FOR SHARE so a concurrent sign-out either waits for the transaction or makes it fail.
--   * Business failures are RESULTS ({ok:false}) so throttle counters persist; exceptions are reserved for authentication
--     (PT401), authorization (PT403) and budget exhaustion (PT429).
--   * No code, token, email or IP is stored or audited. Only sha256(code) is stored.
--
-- DATA PRESERVATION INVARIANT: this migration creates three private tables and nine functions. It does not ALTER, UPDATE or
-- DELETE any existing table or row, and it does not replace any existing function (asserted by prosrc hash below).
--
-- Forward-only and idempotent. Rollback / kill switch: database/rollback/0012_*.sql. Never applied to production by the
-- repository: apply only after explicit owner approval. Migration 0010 (public projection export) is reserved, unapplied and untouched.

begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Pre-flight (read-only): refuse to run against an unexpected database or a migration role that cannot do its job.
-- ---------------------------------------------------------------------------------------------------------------------
do $preflight$
declare
    v_col text;
    v_sig text;
    v_src text;
    v_ownerless bigint;
begin
    -- Production ledger (Supabase): 0011 must be recorded and 0012 must not be. Absent in disposable databases: skipped.
    if to_regclass('supabase_migrations.schema_migrations') is not null then
        if not exists (select 1 from supabase_migrations.schema_migrations where name = 'fix_observed_drop_rate_denominator') then
            raise exception '0012 pre-flight: ledger does not show 0011 (fix_observed_drop_rate_denominator)';
        end if;
        if exists (select 1 from supabase_migrations.schema_migrations where name = 'account_ownership_claims') then
            raise exception '0012 pre-flight: ledger already shows account_ownership_claims';
        end if;
    end if;

    if to_regnamespace('private') is null then
        raise exception '0012 pre-flight: schema private is missing (apply 0009 first)';
    end if;
    foreach v_sig in array array[
        'private.foreverdb_take_budget(text,integer,integer)',
        'private.foreverdb_api_gate(text)',
        'private.foreverdb_ingest_snapshot_impl_v1(jsonb)',
        'public.ingest_foreverdb_snapshot_auth(jsonb)',
        'extensions.gen_random_bytes(integer)',
        'extensions.digest(text,text)'
    ] loop
        if to_regprocedure(v_sig) is null then
            raise exception '0012 pre-flight: % is missing (0009 and pgcrypto in schema extensions are required)', v_sig;
        end if;
    end loop;

    -- The ingest implementation must still take the shared advisory lock and enforce the owner check this migration relies on.
    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)');
    if v_src not like '%pg_advisory_xact_lock%hashtextextended(installation, 0)%'
       or v_src not like '%Installation belongs to another authenticated client%' then
        raise exception '0012 pre-flight: ingest no longer takes the shared advisory lock / owner check';
    end if;

    foreach v_col in array array['id', 'is_anonymous', 'email_confirmed_at', 'deleted_at', 'banned_until'] loop
        if not exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = v_col) then
            raise exception '0012 pre-flight: auth.users.% is missing', v_col;
        end if;
    end loop;
    foreach v_col in array array['id', 'user_id', 'not_after'] loop
        if not exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'sessions' and column_name = v_col) then
            raise exception '0012 pre-flight: auth.sessions.% is missing', v_col;
        end if;
    end loop;

    if to_regclass('public.installations') is null or to_regclass('public.installation_guilds') is null
       or to_regclass('public.installation_guild_members') is null then
        raise exception '0012 pre-flight: installations / Guildbook tables are missing';
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'installations' and column_name = 'owner_user_id') then
        raise exception '0012 pre-flight: public.installations.owner_user_id is missing';
    end if;

    -- The migration role must be able to read AND row-lock auth.sessions (FOR SHARE needs UPDATE) and must not be subject to RLS.
    if not has_table_privilege(current_user, 'auth.sessions', 'SELECT')
       or not has_table_privilege(current_user, 'auth.sessions', 'UPDATE')
       or not has_table_privilege(current_user, 'auth.users', 'SELECT') then
        raise exception '0012 pre-flight: role % lacks SELECT/UPDATE on auth.sessions or SELECT on auth.users', current_user;
    end if;
    if (select c.relrowsecurity from pg_class c where c.oid = 'auth.sessions'::regclass)
       and not (select r.rolbypassrls or r.rolsuper from pg_roles r where r.rolname = current_user)
       and pg_get_userbyid((select c.relowner from pg_class c where c.oid = 'auth.sessions'::regclass)) <> current_user then
        raise exception '0012 pre-flight: row level security would hide auth.sessions from role % (every account call would fail closed)', current_user;
    end if;
    perform 1 from auth.sessions limit 1 for share;

    select count(*) into v_ownerless from public.installations where owner_user_id is null;
    if v_ownerless > 0 then
        raise notice '0012 pre-flight: % ownerless installation(s); they cannot be claimed (only an owner can issue a claim)', v_ownerless;
    end if;
end $preflight$;

-- Snapshot of every existing function the migration must NOT change (compared after the new objects exist).
create temporary table _fdb0012_before on commit drop as
select p.oid::regprocedure::text as sig, md5(p.prosrc) as src_md5, coalesce(p.proacl::text, '') as acl
from pg_proc p
where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
  and p.proname not in (
      'fdb_caller', 'fdb_anonymous_caller', 'fdb_registered_caller',
      'fdb_account_claim_start', 'fdb_account_claim_redeem', 'fdb_installation_link_status',
      'fdb_account_installations', 'fdb_account_guildbook_guilds', 'fdb_account_guildbook_members'
  );

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Private schema objects (RLS enabled with no policy; no privilege for any API role).
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists private.installation_claims (
    id uuid primary key default gen_random_uuid(),
    installation_id text not null references public.installations(id) on delete cascade,
    initiator_uid uuid not null,
    initiator_session_id uuid not null,
    code_hash bytea not null unique,
    status text not null check (status in ('pending', 'consumed', 'revoked')),
    attempts integer not null default 0,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    consumed_at timestamptz,
    consumed_by uuid
);

create unique index if not exists installation_claims_one_pending
    on private.installation_claims (installation_id) where status = 'pending';

create table if not exists private.account_installations (
    installation_id text primary key references public.installations(id) on delete restrict,
    account_uid uuid not null,
    linked_at timestamptz not null default now(),
    claim_id uuid not null references private.installation_claims(id),
    previous_owner_uid uuid not null
);

create index if not exists account_installations_account_idx on private.account_installations (account_uid);
create index if not exists account_installations_previous_owner_idx on private.account_installations (previous_owner_uid);

-- `ownership_restored` and `detail` extend the specified schema for the operator recovery runbook only (documented in
-- docs/account-v1/0012-deployment-and-recovery.md): an audited restore needs an event type and an approval reference.
-- The account functions never write `detail`; it never holds a code, token, email or address.
create table if not exists private.account_audit (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    event text not null check (event in ('claim_started', 'claim_redeemed', 'claim_revoked', 'redeem_rejected', 'ownership_restored')),
    account_uid uuid,
    installation_id text,
    claim_id uuid,
    detail text check (detail is null or length(detail) <= 200)
);

alter table private.installation_claims enable row level security;
alter table private.account_installations enable row level security;
alter table private.account_audit enable row level security;

revoke all on table private.installation_claims from public, anon, authenticated, service_role;
revoke all on table private.account_installations from public, anon, authenticated, service_role;
revoke all on table private.account_audit from public, anon, authenticated, service_role;
revoke all on sequence private.account_audit_id_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Live-session identity guards (private; never callable by clients). VOLATILE on purpose.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.fdb_caller()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_sid text := auth.jwt() ->> 'session_id';
begin
    if auth.role() is distinct from 'authenticated' or v_uid is null
       or v_sid is null
       or v_sid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
        raise sqlstate 'PT401' using message = 'ForeverDB authenticated session required';
    end if;

    if not exists (
        select 1
        from auth.sessions s
        join auth.users u on u.id = s.user_id
        where s.id = v_sid::uuid
          and s.user_id = v_uid
          and (s.not_after is null or s.not_after > now())
          and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= now())
    ) then
        raise sqlstate 'PT401' using message = 'ForeverDB authenticated session required';
    end if;

    return v_uid;
end;
$$;

create or replace function private.fdb_anonymous_caller()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
begin
    v_uid := private.fdb_caller();

    if not exists (
        select 1 from auth.users u where u.id = v_uid and u.is_anonymous
    ) then
        raise sqlstate 'PT403' using message = 'ForeverDB anonymous identity required';
    end if;

    return v_uid;
end;
$$;

create or replace function private.fdb_registered_caller()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
begin
    v_uid := private.fdb_caller();

    if not exists (
        select 1 from auth.users u
        where u.id = v_uid and not u.is_anonymous and u.email_confirmed_at is not null
    ) then
        raise sqlstate 'PT403' using message = 'ForeverDB confirmed registered account required';
    end if;

    return v_uid;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Account RPCs. Lock order (everything per installation is serialised by the SHARED advisory lock, the exact ingest key):
--      guard -> budgets (uid, global) -> advisory lock -> caller session FOR SHARE -> claim/installation rows FOR UPDATE.
--    Row-lock orders differ between start (installation, claim) and redeem (claim, installation); that is only safe because
--    the advisory lock serialises both. Any code locking these rows without that advisory lock would break the guarantee.
-- ---------------------------------------------------------------------------------------------------------------------

create or replace function public.fdb_account_claim_start(p_installation_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
    v_sid uuid;
    v_owner uuid;
    v_old uuid;
    v_claim uuid;
    v_code text;
    v_expires timestamptz;
begin
    v_uid := private.fdb_anonymous_caller();
    v_sid := (auth.jwt() ->> 'session_id')::uuid;

    if p_installation_id is null or length(p_installation_id) not between 1 and 128
       or p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
        return jsonb_build_object('ok', false, 'error', 'not_available');
    end if;

    perform private.foreverdb_take_budget('claim_start:uid:' || v_uid::text, 300, 3);
    perform private.foreverdb_take_budget('claim_start:global', 300, 60);

    perform pg_advisory_xact_lock(hashtextextended(p_installation_id, 0));

    -- Re-verify liveness under a row lock: a sign-out committing concurrently waits for this transaction or makes it fail.
    perform 1
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    where s.id = v_sid and s.user_id = v_uid
      and (s.not_after is null or s.not_after > now())
      and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
      and u.is_anonymous
    for share of s;
    if not found then
        raise sqlstate 'PT401' using message = 'ForeverDB authenticated session required';
    end if;

    select i.owner_user_id into v_owner
    from public.installations i
    where i.id = p_installation_id
    for update;

    if not found or v_owner is distinct from v_uid then
        return jsonb_build_object('ok', false, 'error', 'not_available');
    end if;

    -- Only now (the caller proved ownership) charge the per-installation budget: otherwise anyone knowing an id could
    -- exhaust the owner's budget. The key is hashed (installation ids can be 128 characters; the budget key limit is 140).
    perform private.foreverdb_take_budget(
        'claim_start:inst:' || substr(encode(extensions.digest(p_installation_id, 'sha256'), 'hex'), 1, 32), 300, 3);

    update private.installation_claims
    set status = 'revoked'
    where installation_id = p_installation_id and status = 'pending'
    returning id into v_old;
    if v_old is not null then
        insert into private.account_audit (event, account_uid, installation_id, claim_id)
        values ('claim_revoked', v_uid, p_installation_id, v_old);
    end if;

    v_code := upper(encode(extensions.gen_random_bytes(16), 'hex'));
    v_expires := clock_timestamp() + interval '10 minutes';

    insert into private.installation_claims (installation_id, initiator_uid, initiator_session_id, code_hash, status, expires_at)
    values (p_installation_id, v_uid, v_sid, extensions.digest(v_code, 'sha256'), 'pending', v_expires)
    returning id into v_claim;

    insert into private.account_audit (event, account_uid, installation_id, claim_id)
    values ('claim_started', v_uid, p_installation_id, v_claim);

    return jsonb_build_object('ok', true, 'code', v_code, 'expires_at', v_expires);
end;
$$;

create or replace function public.fdb_account_claim_redeem(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
    v_sid uuid;
    v_hash bytea;
    v_claim_id uuid;
    v_installation text;
    v_status text;
    v_expires timestamptz;
    v_initiator uuid;
    v_initiator_sid uuid;
    v_attempts integer;
    v_owner uuid;
    v_valid boolean;
    v_owned integer;
    v_linked timestamptz;
begin
    v_uid := private.fdb_registered_caller();
    v_sid := (auth.jwt() ->> 'session_id')::uuid;

    perform private.foreverdb_take_budget('claim_redeem:uid:' || v_uid::text, 300, 10);
    perform private.foreverdb_take_budget('claim_redeem:global', 300, 120);

    if p_code is null or p_code !~ '^[0-9A-F]{32}$' then
        insert into private.account_audit (event, account_uid) values ('redeem_rejected', v_uid);
        return jsonb_build_object('ok', false, 'error', 'invalid_claim');
    end if;
    v_hash := extensions.digest(p_code, 'sha256');

    -- Unlocked lookup only to learn WHICH installation to lock; everything is re-read under the locks below.
    select c.id, c.installation_id into v_claim_id, v_installation
    from private.installation_claims c
    where c.code_hash = v_hash;
    if not found then
        insert into private.account_audit (event, account_uid) values ('redeem_rejected', v_uid);
        return jsonb_build_object('ok', false, 'error', 'invalid_claim');
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_installation, 0));

    -- The redeemer's own session must still be live now that we hold the lock (row-locked against a concurrent sign-out).
    perform 1
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    where s.id = v_sid and s.user_id = v_uid
      and (s.not_after is null or s.not_after > now())
      and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
      and not u.is_anonymous and u.email_confirmed_at is not null
    for share of s;
    if not found then
        raise sqlstate 'PT401' using message = 'ForeverDB authenticated session required';
    end if;

    select c.status, c.expires_at, c.initiator_uid, c.initiator_session_id, c.attempts
    into v_status, v_expires, v_initiator, v_initiator_sid, v_attempts
    from private.installation_claims c
    where c.id = v_claim_id
    for update;
    if not found then
        insert into private.account_audit (event, account_uid) values ('redeem_rejected', v_uid);
        return jsonb_build_object('ok', false, 'error', 'invalid_claim');
    end if;

    select i.owner_user_id into v_owner
    from public.installations i
    where i.id = v_installation
    for update;
    v_valid := found and v_status = 'pending' and v_expires > clock_timestamp()
               and v_owner is not distinct from v_initiator and v_uid <> v_initiator;

    if v_valid then
        -- The initiator must still be an anonymous, active identity (an owner that upgraded itself to a permanent account
        -- between start and redeem must not be movable by a leaked code).
        perform 1
        from auth.users u
        where u.id = v_initiator and u.is_anonymous
          and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now());
        v_valid := found;
    end if;
    if v_valid then
        -- The EXACT session that issued the claim must still be alive (not merely any session of that user).
        perform 1
        from auth.sessions s
        where s.id = v_initiator_sid and s.user_id = v_initiator
          and (s.not_after is null or s.not_after > now())
        for share of s;
        v_valid := found;
    end if;

    if not v_valid then
        if v_status = 'pending' then
            update private.installation_claims
            set attempts = attempts + 1,
                status = case when attempts + 1 >= 5 then 'revoked' else status end
            where id = v_claim_id;
            if v_attempts + 1 >= 5 then
                insert into private.account_audit (event, account_uid, installation_id, claim_id)
                values ('claim_revoked', v_uid, v_installation, v_claim_id);
            end if;
        end if;
        insert into private.account_audit (event, account_uid, installation_id, claim_id)
        values ('redeem_rejected', v_uid, v_installation, v_claim_id);
        return jsonb_build_object('ok', false, 'error', 'invalid_claim');
    end if;

    -- A valid code is NOT consumed when the account is full (only a holder of a valid code learns this).
    select count(*) into v_owned from public.installations i where i.owner_user_id = v_uid;
    if v_owned >= 50 then
        return jsonb_build_object('ok', false, 'error', 'account_limit');
    end if;

    -- The only data change to an existing table: the ownership column. Nothing else about the installation is touched.
    update public.installations set owner_user_id = v_uid where id = v_installation;

    insert into private.account_installations (installation_id, account_uid, claim_id, previous_owner_uid)
    values (v_installation, v_uid, v_claim_id, v_initiator)
    returning linked_at into v_linked;

    update private.installation_claims
    set status = 'consumed', consumed_at = clock_timestamp(), consumed_by = v_uid
    where id = v_claim_id;

    insert into private.account_audit (event, account_uid, installation_id, claim_id)
    values ('claim_redeemed', v_uid, v_installation, v_claim_id);

    return jsonb_build_object('ok', true, 'installation_id', v_installation, 'linked_at', v_linked);
end;
$$;

create or replace function public.fdb_installation_link_status(p_installation_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
begin
    v_uid := private.fdb_caller();
    perform private.foreverdb_api_gate('detail');

    if p_installation_id is null or length(p_installation_id) not between 1 and 128
       or p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
        return jsonb_build_object('state', 'unknown');
    end if;

    if exists (select 1 from public.installations i where i.id = p_installation_id and i.owner_user_id = v_uid) then
        return jsonb_build_object('state', 'owned');
    end if;

    -- Only the PREVIOUS owner learns that its installation moved (derived from the never-pruned link row).
    if exists (select 1 from private.account_installations l where l.installation_id = p_installation_id and l.previous_owner_uid = v_uid) then
        return jsonb_build_object('state', 'transferred');
    end if;

    return jsonb_build_object('state', 'unknown');
end;
$$;

create or replace function public.fdb_account_installations()
returns table (installation_id text, linked_at timestamptz, last_seen_at timestamptz, guild_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_uid uuid;
begin
    v_uid := private.fdb_registered_caller();
    perform private.foreverdb_api_gate('detail');

    return query
    select i.id,
           coalesce(l.linked_at, i.first_seen_at),
           i.last_seen_at,
           (select count(*) from public.installation_guilds g where g.installation_id = i.id)::integer
    from public.installations i
    left join private.account_installations l on l.installation_id = i.id and l.account_uid = v_uid
    where i.owner_user_id = v_uid
    order by i.last_seen_at desc nulls last, i.id
    limit 50;
end;
$$;

create or replace function public.fdb_account_guildbook_guilds(p_installation_id text)
returns table (guild_key text, guild_name text, realm_name text, captured_at bigint, member_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_uid uuid;
begin
    v_uid := private.fdb_registered_caller();
    perform private.foreverdb_api_gate('detail');

    if p_installation_id is null or length(p_installation_id) not between 1 and 128
       or p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
        raise sqlstate 'PT400' using message = 'Invalid installation identifier';
    end if;

    -- Ownership is re-derived here from the guard's UID; a client-supplied installation id proves nothing. Not owned and
    -- owned-but-empty are indistinguishable (empty set). member_guid never leaves the database.
    return query
    select g.guild_key, g.guild_name, g.realm_name, g.captured_at,
           (select count(*) from public.installation_guild_members m
             where m.installation_id = g.installation_id and m.guild_key = g.guild_key)::integer
    from public.installation_guilds g
    join public.installations i on i.id = g.installation_id
    where g.installation_id = p_installation_id
      and i.owner_user_id = v_uid
    order by g.guild_name, g.guild_key
    limit 100;
end;
$$;

create or replace function public.fdb_account_guildbook_members(
    p_installation_id text,
    p_guild_key text,
    p_limit integer default 100,
    p_offset integer default 0
)
returns table (
    member_name text, class_name text, class_file text, level integer, rank_name text,
    rank_index integer, online boolean, zone_name text, last_online_hours integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
    v_uid uuid;
    v_limit integer;
    v_offset integer;
begin
    v_uid := private.fdb_registered_caller();
    perform private.foreverdb_api_gate('detail');

    if p_installation_id is null or length(p_installation_id) not between 1 and 128
       or p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
       or p_guild_key is null or length(p_guild_key) not between 1 and 200 then
        raise sqlstate 'PT400' using message = 'Invalid Guildbook parameters';
    end if;
    v_limit := greatest(1, least(coalesce(p_limit, 100), 200));
    v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));

    return query
    select m.member_name, m.class_name, m.class_file, m.level, m.rank_name, m.rank_index, m.online, m.zone_name,
           least(m.last_online_hours, 2147483647)::integer
    from public.installation_guild_members m
    join public.installations i on i.id = m.installation_id
    where m.installation_id = p_installation_id
      and m.guild_key = p_guild_key
      and i.owner_user_id = v_uid
    order by m.rank_index, m.member_name, m.member_guid
    limit v_limit offset v_offset;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Timeouts and privileges. Supabase default privileges can re-grant EXECUTE on new functions, so every function is
--    revoked explicitly and then granted to `authenticated` only (guards: nobody).
-- ---------------------------------------------------------------------------------------------------------------------
alter function public.fdb_account_claim_start(text) set lock_timeout = '5s';
alter function public.fdb_account_claim_start(text) set statement_timeout = '10s';
alter function public.fdb_account_claim_redeem(text) set lock_timeout = '5s';
alter function public.fdb_account_claim_redeem(text) set statement_timeout = '10s';
alter function public.fdb_installation_link_status(text) set lock_timeout = '5s';
alter function public.fdb_installation_link_status(text) set statement_timeout = '5s';
alter function public.fdb_account_installations() set lock_timeout = '5s';
alter function public.fdb_account_installations() set statement_timeout = '5s';
alter function public.fdb_account_guildbook_guilds(text) set lock_timeout = '5s';
alter function public.fdb_account_guildbook_guilds(text) set statement_timeout = '5s';
alter function public.fdb_account_guildbook_members(text, text, integer, integer) set lock_timeout = '5s';
alter function public.fdb_account_guildbook_members(text, text, integer, integer) set statement_timeout = '5s';

revoke all on function private.fdb_caller() from public, anon, authenticated, service_role;
revoke all on function private.fdb_anonymous_caller() from public, anon, authenticated, service_role;
revoke all on function private.fdb_registered_caller() from public, anon, authenticated, service_role;

revoke all on function public.fdb_account_claim_start(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_claim_redeem(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_installation_link_status(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_installations() from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_guildbook_guilds(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_guildbook_members(text, text, integer, integer) from public, anon, authenticated, service_role;

grant execute on function public.fdb_account_claim_start(text) to authenticated;
grant execute on function public.fdb_account_claim_redeem(text) to authenticated;
grant execute on function public.fdb_installation_link_status(text) to authenticated;
grant execute on function public.fdb_account_installations() to authenticated;
grant execute on function public.fdb_account_guildbook_guilds(text) to authenticated;
grant execute on function public.fdb_account_guildbook_members(text, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Post-apply assertions: the transaction aborts (nothing is applied) if any of them fails.
-- ---------------------------------------------------------------------------------------------------------------------
do $verify$
declare
    v_sig text;
    r record;
    v_after record;
    v_count integer;
begin
    -- Six public functions: SECURITY DEFINER, owner = migration role, search_path pinned, timeouts set, exact ACL.
    foreach v_sig in array array[
        'public.fdb_account_claim_start(text)',
        'public.fdb_account_claim_redeem(text)',
        'public.fdb_installation_link_status(text)',
        'public.fdb_account_installations()',
        'public.fdb_account_guildbook_guilds(text)',
        'public.fdb_account_guildbook_members(text,text,integer,integer)',
        'private.fdb_caller()',
        'private.fdb_anonymous_caller()',
        'private.fdb_registered_caller()'
    ] loop
        select p.prosecdef, pg_get_userbyid(p.proowner) as owner, coalesce(p.proconfig, '{}') as config, p.provolatile
        into v_after
        from pg_proc p where p.oid = to_regprocedure(v_sig);
        if not found then raise exception '0012 post-condition: % is missing', v_sig; end if;
        if not v_after.prosecdef then raise exception '0012 post-condition: % is not SECURITY DEFINER', v_sig; end if;
        if v_after.owner <> current_user then raise exception '0012 post-condition: % is not owned by the migration role', v_sig; end if;
        if v_after.provolatile <> 'v' then raise exception '0012 post-condition: % is not VOLATILE', v_sig; end if;
        if not ('search_path=""' = any (v_after.config)) then raise exception '0012 post-condition: % lacks search_path = empty', v_sig; end if;
        if has_function_privilege('public', v_sig, 'execute') or has_function_privilege('anon', v_sig, 'execute')
           or has_function_privilege('service_role', v_sig, 'execute') then
            raise exception '0012 post-condition: % is executable by public, anon or service_role', v_sig;
        end if;
        if v_sig like 'private.%' then
            if has_function_privilege('authenticated', v_sig, 'execute') then
                raise exception '0012 post-condition: guard % is executable by authenticated', v_sig;
            end if;
        elsif not has_function_privilege('authenticated', v_sig, 'execute') then
            raise exception '0012 post-condition: authenticated cannot execute %', v_sig;
        elsif not exists (select 1 from unnest(v_after.config) c where c like 'lock_timeout=%')
           or not exists (select 1 from unnest(v_after.config) c where c like 'statement_timeout=%') then
            raise exception '0012 post-condition: % lacks lock_timeout / statement_timeout', v_sig;
        end if;
    end loop;

    -- No client role holds any privilege on the private tables or the audit sequence; RLS is on.
    foreach v_sig in array array['private.installation_claims', 'private.account_installations', 'private.account_audit'] loop
        if not (select c.relrowsecurity from pg_class c where c.oid = v_sig::regclass) then
            raise exception '0012 post-condition: RLS is not enabled on %', v_sig;
        end if;
        if has_table_privilege('public', v_sig, 'select,insert,update,delete,truncate,references,trigger')
           or has_table_privilege('anon', v_sig, 'select,insert,update,delete,truncate,references,trigger')
           or has_table_privilege('authenticated', v_sig, 'select,insert,update,delete,truncate,references,trigger')
           or has_table_privilege('service_role', v_sig, 'select,insert,update,delete,truncate,references,trigger') then
            raise exception '0012 post-condition: a client role has a privilege on %', v_sig;
        end if;
    end loop;
    if has_sequence_privilege('authenticated', 'private.account_audit_id_seq', 'usage,select,update')
       or has_sequence_privilege('anon', 'private.account_audit_id_seq', 'usage,select,update') then
        raise exception '0012 post-condition: a client role can use the audit sequence';
    end if;
    if has_schema_privilege('anon', 'private', 'usage') or has_schema_privilege('authenticated', 'private', 'usage') then
        raise exception '0012 post-condition: private schema is reachable by a client role';
    end if;

    -- Every pre-existing function in public/private is byte-identical (prosrc) with the same ACL.
    for r in select * from _fdb0012_before loop
        select md5(p.prosrc) as src_md5, coalesce(p.proacl::text, '') as acl
        into v_after
        from pg_proc p where p.oid = to_regprocedure(r.sig);
        if not found or v_after.src_md5 is distinct from r.src_md5 or v_after.acl is distinct from r.acl then
            raise exception '0012 post-condition: existing function % changed', r.sig;
        end if;
    end loop;

    -- Existing quota gates and ingest contract are unchanged for the roles that use them.
    if not has_function_privilege('authenticated', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'execute')
       or has_function_privilege('anon', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'execute') then
        raise exception '0012 post-condition: ingest privileges changed';
    end if;

    -- Raw Guildbook tables remain closed to API roles.
    if has_table_privilege('authenticated', 'public.installation_guilds', 'select')
       or has_table_privilege('authenticated', 'public.installation_guild_members', 'select')
       or has_table_privilege('authenticated', 'public.installation_guild_professions', 'select')
       or has_table_privilege('authenticated', 'public.installations', 'select')
       or has_table_privilege('anon', 'public.installation_guild_members', 'select') then
        raise exception '0012 post-condition: raw installation/Guildbook tables are readable by an API role';
    end if;

    -- Only the three new private tables and nine functions are new in these schemas.
    select count(*) into v_count
    from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and p.proname in ('fdb_caller', 'fdb_anonymous_caller', 'fdb_registered_caller', 'fdb_account_claim_start',
                        'fdb_account_claim_redeem', 'fdb_installation_link_status', 'fdb_account_installations',
                        'fdb_account_guildbook_guilds', 'fdb_account_guildbook_members');
    if v_count <> 9 then
        raise exception '0012 post-condition: expected exactly 9 account functions, found % (overloads?)', v_count;
    end if;
end $verify$;

notify pgrst, 'reload schema';

commit;
