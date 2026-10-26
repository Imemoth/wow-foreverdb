-- ForeverDB 0014: Account System V1 - zero-touch device enrollment and registered device synchronization.
--
-- A registered web account issues a 7-day (168 h), single-use, hash-only activation ticket; a Windows Companion redeems it with its OWN
-- anonymous Auth identity and receives a separate, revocable, rotating DEVICE credential for exactly one installation. Registered
-- snapshot ingest for that installation is then authorized by the device registry, not by a human login on the Companion.
-- Decision record: docs/account-v1/adr-017-zero-touch-enrollment.md. Product contract: docs/account-v1/zero-touch-enrollment-registered-sync.md.
--
-- SECURITY MODEL (summary; the ADR is normative)
--   * Account functions (ticket issue/list/revoke, device list/revoke) run the 0012 REGISTERED live-session guard; device functions
--     (enroll, status, ingest, rotate) run the 0012 ANONYMOUS live-session guard. The device's Auth uid is a principal key of the
--     registry; it is never granted account privileges and never equals the account uid.
--   * Raw tickets and raw device secrets are returned once and never stored: only sha256 is stored. Nothing secret is audited.
--   * Redemption is one transaction under the SAME per-installation advisory lock that ingest and claims use, then ticket and device
--     rows FOR UPDATE: exactly one concurrent redeemer wins.
--   * An installation is never taken from another owner: unknown ids are reserved for the ticket's account, account-owned ids without an
--     active device are re-bound, everything else is refused.
--   * fdb_device_ingest re-checks device status, credential, account standing and CURRENT ownership under the lock, then runs the
--     unchanged ingest implementation with the account identity set for that statement only. Anonymous ingest is not modified.
--   * Business failures are RESULTS (so throttle counters persist); exceptions are reserved for authentication (PT401), authorization
--     (PT403), payload bounds (PT400/PT413) and budget exhaustion (PT429).
--
-- DATA PRESERVATION INVARIANT: three private tables and fifteen functions are created. No existing table is ALTERed and no existing
-- function is replaced (asserted by a prosrc+ACL fingerprint below). The only write to an existing table is INSERT of a reserved
-- public.installations row for an id that does not exist yet.
--
-- Forward-only. Kill switch / rollback: database/rollback/0014_*.sql. Never applied to production by the repository.

begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Pre-flight (read-only)
-- ---------------------------------------------------------------------------------------------------------------------
do $preflight$
declare
    v_sig text;
begin
    if to_regclass('supabase_migrations.schema_migrations') is not null then
        if exists (select 1 from supabase_migrations.schema_migrations where name = 'zero_touch_enrollment') then
            raise exception '0014 pre-flight: ledger already shows zero_touch_enrollment';
        end if;
    end if;

    foreach v_sig in array array[
        'private.foreverdb_take_budget(text,integer,integer)',
        'private.foreverdb_api_gate(text)',
        'private.foreverdb_ingest_snapshot_impl_v1(jsonb)',
        'public.ingest_foreverdb_snapshot_auth(jsonb)',
        'private.fdb_caller()',
        'private.fdb_anonymous_caller()',
        'private.fdb_registered_caller()',
        'public.fdb_account_claim_redeem(text)',
        'extensions.gen_random_bytes(integer)',
        'extensions.digest(text,text)'
    ] loop
        if to_regprocedure(v_sig) is null then
            raise exception '0014 pre-flight: % is missing (apply 0009 and 0012 first)', v_sig;
        end if;
    end loop;

    if to_regclass('private.account_installations') is null or to_regclass('private.installation_claims') is null then
        raise exception '0014 pre-flight: 0012 tables are missing';
    end if;

    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'installations' and column_name = 'snapshot_updated_at') then
        raise exception '0014 pre-flight: public.installations.snapshot_updated_at is missing';
    end if;

    if not has_table_privilege(current_user, 'auth.sessions', 'SELECT')
       or not has_table_privilege(current_user, 'auth.sessions', 'UPDATE')
       or not has_table_privilege(current_user, 'auth.users', 'SELECT') then
        raise exception '0014 pre-flight: role % lacks SELECT/UPDATE on auth.sessions or SELECT on auth.users', current_user;
    end if;
end $preflight$;

create temporary table _fdb0014_before on commit drop as
select p.oid::regprocedure::text as sig, md5(p.prosrc) as src_md5, coalesce(p.proacl::text, '') as acl
from pg_proc p
where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
  and p.proname not in (
      'fdb_account_enrollment_ticket_issue', 'fdb_account_enrollment_tickets', 'fdb_account_enrollment_ticket_revoke',
      'fdb_account_devices', 'fdb_account_device_revoke',
      'fdb_device_enroll', 'fdb_device_status', 'fdb_device_ingest', 'fdb_device_rotate_credential',
      'fdb_device_id_from_secret', 'fdb_device_match', 'fdb_device_authorize', 'fdb_account_usable',
      'fdb_lock_live_session', 'fdb_prune_enrollment'
  );

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Private tables (RLS enabled, no policy, no privilege for any API role)
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists private.enrollment_tickets (
    id uuid primary key default gen_random_uuid(),
    account_uid uuid not null,
    ticket_hash bytea not null unique,
    label text check (label is null or length(label) <= 60),
    status text not null check (status in ('pending', 'consumed', 'revoked')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    consumed_at timestamptz,
    consumed_device_id uuid,
    revoked_at timestamptz,
    check (expires_at <= created_at + interval '168 hours')
);
create index if not exists enrollment_tickets_account_idx on private.enrollment_tickets (account_uid, created_at desc);

create table if not exists private.devices (
    id uuid primary key default gen_random_uuid(),
    account_uid uuid not null,
    installation_id text not null references public.installations(id) on delete restrict,
    auth_uid uuid not null,
    label text check (label is null or length(label) <= 60),
    status text not null check (status in ('active', 'revoked', 'pending_approval')),
    revoked_reason text check (revoked_reason is null or length(revoked_reason) <= 60),
    ticket_id uuid not null references private.enrollment_tickets(id),
    credential_hash bytea not null,
    credential_issued_at timestamptz not null default now(),
    next_credential_hash bytea,
    retired_hash bytea,
    retired_at timestamptz,
    created_at timestamptz not null default now(),
    revoked_at timestamptz,
    last_seen_at timestamptz
);
-- At most one non-revoked device per installation and per Auth identity: a cloned SavedVariables or a reused identity cannot bind twice.
create unique index if not exists devices_one_live_per_installation on private.devices (installation_id) where status <> 'revoked';
create unique index if not exists devices_one_live_per_identity on private.devices (auth_uid) where status <> 'revoked';
create index if not exists devices_account_idx on private.devices (account_uid, created_at desc);

create table if not exists private.device_audit (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    event text not null check (event in ('ticket_issued', 'ticket_revoked', 'enroll_succeeded', 'enroll_refused', 'device_replaced',
                                         'device_revoked', 'credential_rotated', 'credential_reuse', 'ingest_refused')),
    account_uid uuid,
    actor_uid uuid,
    device_id uuid,
    ticket_id uuid,
    installation_id text,
    detail text check (detail is null or length(detail) <= 60)
);
create index if not exists device_audit_account_idx on private.device_audit (account_uid, id desc);

alter table private.enrollment_tickets enable row level security;
alter table private.devices enable row level security;
alter table private.device_audit enable row level security;

revoke all on table private.enrollment_tickets from public, anon, authenticated, service_role;
revoke all on table private.devices from public, anon, authenticated, service_role;
revoke all on table private.device_audit from public, anon, authenticated, service_role;
revoke all on sequence private.device_audit_id_seq from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Private helpers (never callable by clients)
-- ---------------------------------------------------------------------------------------------------------------------

-- The caller's own session must still be live now that locks are held; FOR SHARE makes a concurrent sign-out wait or fail.
create or replace function private.fdb_lock_live_session(p_uid uuid, p_sid uuid, p_anonymous boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform 1
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    where s.id = p_sid and s.user_id = p_uid
      and (s.not_after is null or s.not_after > now())
      and exists (select 1 from auth.refresh_tokens r where r.session_id = s.id and not r.revoked)
      and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
      and u.is_anonymous = p_anonymous
      and (p_anonymous or u.email_confirmed_at is not null)
    for share of s;
    if not found then
        raise sqlstate 'PT401' using message = 'ForeverDB authenticated session required';
    end if;
end;
$$;

-- A registered, confirmed, active account (the ONLY kind that can own devices).
create or replace function private.fdb_account_usable(p_uid uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
    select exists (
        select 1 from auth.users u
        where u.id = p_uid and not u.is_anonymous and u.email_confirmed_at is not null
          and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
    );
$$;

-- fdbd1_<32 hex device id>_<43 base64url chars>  ->  device id, or null when malformed.
create or replace function private.fdb_device_id_from_secret(p_secret text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
declare
    h text;
begin
    if p_secret is null or p_secret !~ '^fdbd1_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$' then
        return null;
    end if;
    h := substr(p_secret, 7, 32);
    return (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-' || substr(h, 13, 4) || '-' || substr(h, 17, 4) || '-' || substr(h, 21, 12))::uuid;
end;
$$;

create or replace function private.fdb_device_match(p_secret text, p_dev private.devices)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    h bytea := extensions.digest(p_secret, 'sha256');
begin
    if p_dev.credential_hash = h then return 'current'; end if;
    if p_dev.next_credential_hash is not null and p_dev.next_credential_hash = h then return 'next'; end if;
    if p_dev.retired_hash is not null and p_dev.retired_hash = h then return 'retired'; end if;
    return null;
end;
$$;

-- Authorizes a device call. The CALLER must already hold the per-installation advisory lock (lock order: installation -> device row).
-- o_reason is null on success; otherwise one of: unknown, revoked, stale_credential, account_unavailable, ownership_conflict.
-- 'unknown' deliberately covers missing device, wrong principal and wrong secret (no oracle for a caller without the secret).
create or replace function private.fdb_device_authorize(p_secret text, p_uid uuid, out o_device private.devices, out o_reason text)
returns record
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_id uuid := private.fdb_device_id_from_secret(p_secret);
    v_match text;
    v_owner uuid;
begin
    o_reason := 'unknown';
    if v_id is null then
        return;
    end if;

    select * into o_device from private.devices d where d.id = v_id for update;
    if not found or o_device.auth_uid is distinct from p_uid then
        o_device := null;
        return;
    end if;

    v_match := private.fdb_device_match(p_secret, o_device);
    if v_match is null then
        o_device := null;
        return;
    end if;

    if v_match = 'retired' then
        if o_device.status <> 'revoked' and o_device.retired_at > clock_timestamp() - interval '120 seconds' then
            o_reason := 'stale_credential';
            return;
        end if;
        if o_device.status <> 'revoked' then
            -- A superseded credential used after the grace window: a copy is running in parallel. Revoke and tell nobody why.
            update private.devices set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'credential_reuse' where id = o_device.id;
            insert into private.device_audit (event, account_uid, actor_uid, device_id, installation_id, detail)
            values ('credential_reuse', o_device.account_uid, p_uid, o_device.id, o_device.installation_id, 'retired_credential');
        end if;
        o_reason := 'revoked';
        return;
    end if;

    if o_device.status <> 'active' then
        o_reason := 'revoked';
        return;
    end if;

    if v_match = 'next' then
        update private.devices
        set retired_hash = credential_hash, retired_at = clock_timestamp(),
            credential_hash = next_credential_hash, next_credential_hash = null, credential_issued_at = clock_timestamp()
        where id = o_device.id
        returning * into o_device;
    end if;

    if not private.fdb_account_usable(o_device.account_uid) then
        o_reason := 'account_unavailable';
        return;
    end if;

    -- Stale ownership: the installation is not (or no longer) owned by the account this device was bound to.
    select i.owner_user_id into v_owner from public.installations i where i.id = o_device.installation_id;
    if v_owner is distinct from o_device.account_uid then
        o_reason := 'ownership_conflict';
        return;
    end if;

    o_reason := null;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Account (website) functions: registered, confirmed, live session
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.fdb_account_enrollment_ticket_issue(p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
    v_label text;
    v_ticket text;
    v_id uuid;
    v_expires timestamptz;
begin
    v_uid := private.fdb_registered_caller();
    perform private.foreverdb_take_budget('ticket_issue:uid:' || v_uid::text, 300, 10);

    v_label := nullif(btrim(left(regexp_replace(coalesce(p_label, ''), '[[:cntrl:]]', '', 'g'), 60)), '');

    perform pg_advisory_xact_lock(hashtextextended('fdb-account:' || v_uid::text, 0));

    if (select count(*) from private.enrollment_tickets t
         where t.account_uid = v_uid and t.status = 'pending' and t.expires_at > clock_timestamp()) >= 5
       or (select count(*) from private.enrollment_tickets t
            where t.account_uid = v_uid and t.created_at > clock_timestamp() - interval '1 hour') >= 10 then
        return jsonb_build_object('ok', false, 'error', 'ticket_limit');
    end if;

    v_ticket := 'fdba1_' || translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
    v_expires := clock_timestamp() + interval '168 hours';

    insert into private.enrollment_tickets (account_uid, ticket_hash, label, status, created_at, expires_at)
    values (v_uid, extensions.digest(v_ticket, 'sha256'), v_label, 'pending', clock_timestamp(), v_expires)
    returning id into v_id;

    insert into private.device_audit (event, account_uid, actor_uid, ticket_id) values ('ticket_issued', v_uid, v_uid, v_id);

    return jsonb_build_object('ok', true, 'ticket_id', v_id, 'ticket', v_ticket, 'expires_at', v_expires);
end;
$$;

create or replace function public.fdb_account_enrollment_tickets()
returns table (ticket_id uuid, label text, status text, created_at timestamptz, expires_at timestamptz, consumed_at timestamptz, device_id uuid)
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
    select t.id, t.label,
           case when t.status = 'pending' and t.expires_at <= clock_timestamp() then 'expired' else t.status end,
           t.created_at, t.expires_at, t.consumed_at, t.consumed_device_id
    from private.enrollment_tickets t
    where t.account_uid = v_uid
    order by t.created_at desc
    limit 20;
end;
$$;

create or replace function public.fdb_account_enrollment_ticket_revoke(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
    v_status text;
begin
    v_uid := private.fdb_registered_caller();
    perform private.foreverdb_take_budget('ticket_revoke:uid:' || v_uid::text, 300, 20);

    if p_ticket_id is null then
        return jsonb_build_object('ok', false, 'error', 'not_available');
    end if;

    select t.status into v_status
    from private.enrollment_tickets t
    where t.id = p_ticket_id and t.account_uid = v_uid
    for update;
    if not found or v_status <> 'pending' then
        -- unknown, someone else's, already used or already revoked: one answer
        return jsonb_build_object('ok', false, 'error', 'not_available');
    end if;

    update private.enrollment_tickets set status = 'revoked', revoked_at = clock_timestamp() where id = p_ticket_id;
    insert into private.device_audit (event, account_uid, actor_uid, ticket_id) values ('ticket_revoked', v_uid, v_uid, p_ticket_id);
    return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.fdb_account_devices()
returns table (device_id uuid, installation_id text, label text, status text, created_at timestamptz, last_seen_at timestamptz,
               revoked_at timestamptz, revoked_reason text)
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
    select d.id, d.installation_id, d.label, d.status, d.created_at, d.last_seen_at, d.revoked_at, d.revoked_reason
    from private.devices d
    where d.account_uid = v_uid
    order by (d.status = 'revoked'), d.created_at desc
    limit 50;
end;
$$;

create or replace function public.fdb_account_device_revoke(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
    v_sid uuid;
    v_installation text;
    v_status text;
begin
    v_uid := private.fdb_registered_caller();
    v_sid := (auth.jwt() ->> 'session_id')::uuid;
    perform private.foreverdb_take_budget('device_revoke:uid:' || v_uid::text, 300, 20);

    if p_device_id is null then
        return jsonb_build_object('ok', false, 'error', 'not_available');
    end if;

    select d.installation_id into v_installation from private.devices d where d.id = p_device_id and d.account_uid = v_uid;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'not_available');
    end if;

    -- Same lock as ingest: an in-flight ingest finishes first, every later ingest sees the revocation.
    perform pg_advisory_xact_lock(hashtextextended(v_installation, 0));
    perform private.fdb_lock_live_session(v_uid, v_sid, false);

    select d.status into v_status from private.devices d where d.id = p_device_id and d.account_uid = v_uid for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'not_available');
    end if;

    if v_status <> 'revoked' then
        update private.devices set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'owner_revoked' where id = p_device_id;
        insert into private.device_audit (event, account_uid, actor_uid, device_id, installation_id)
        values ('device_revoked', v_uid, v_uid, p_device_id, v_installation);
    end if;
    return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Device functions: anonymous (device identity), live session
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.fdb_device_enroll(p_ticket text, p_installation_id text, p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_d uuid;
    v_sid uuid;
    v_label text;
    v_hash bytea;
    v_ticket_id uuid;
    v_account uuid;
    v_status text;
    v_expires timestamptz;
    v_owner uuid;
    v_found boolean;
    v_dev record;
    v_live integer;
    v_owned integer;
    v_device_id uuid := gen_random_uuid();
    v_secret text;
begin
    v_d := private.fdb_anonymous_caller();
    v_sid := (auth.jwt() ->> 'session_id')::uuid;

    perform private.foreverdb_take_budget('enroll:uid:' || v_d::text, 300, 5);

    if p_ticket is null or p_ticket !~ '^fdba1_[A-Za-z0-9_-]{43}$' then
        perform private.foreverdb_take_budget('enroll:global', 300, 120);
        insert into private.device_audit (event, actor_uid, detail) values ('enroll_refused', v_d, 'ticket_format');
        return jsonb_build_object('ok', false, 'error', 'invalid_ticket');
    end if;
    if p_installation_id is null or length(p_installation_id) not between 16 and 128
       or p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
        perform private.foreverdb_take_budget('enroll:global', 300, 120);
        insert into private.device_audit (event, actor_uid, detail) values ('enroll_refused', v_d, 'installation_format');
        return jsonb_build_object('ok', false, 'error', 'invalid_installation');
    end if;
    v_label := nullif(btrim(left(regexp_replace(coalesce(p_label, ''), '[[:cntrl:]]', '', 'g'), 60)), '');
    v_hash := extensions.digest(p_ticket, 'sha256');

    -- Unlocked lookup only to learn that the ticket exists; everything is re-read under the locks below.
    select t.id into v_ticket_id from private.enrollment_tickets t where t.ticket_hash = v_hash;
    if not found then
        perform private.foreverdb_take_budget('enroll:global', 300, 120);
        insert into private.device_audit (event, actor_uid, installation_id, detail) values ('enroll_refused', v_d, p_installation_id, 'unknown_ticket');
        return jsonb_build_object('ok', false, 'error', 'invalid_ticket');
    end if;

    -- Lock order: installation (shared with ingest and claims) -> caller session -> ticket row -> account -> identity.
    perform pg_advisory_xact_lock(hashtextextended(p_installation_id, 0));
    perform private.foreverdb_take_budget('enroll:global', 300, 120);
    perform private.fdb_lock_live_session(v_d, v_sid, true);

    select t.account_uid, t.status, t.expires_at into v_account, v_status, v_expires
    from private.enrollment_tickets t where t.id = v_ticket_id for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'invalid_ticket');
    end if;

    if v_status = 'consumed' or v_status = 'revoked' or v_expires <= clock_timestamp() then
        insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
        values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id,
                case when v_status = 'consumed' then 'ticket_consumed' when v_status = 'revoked' then 'ticket_revoked' else 'ticket_expired' end);
        return jsonb_build_object('ok', false, 'error',
                case when v_status = 'consumed' then 'ticket_consumed' when v_status = 'revoked' then 'ticket_revoked' else 'ticket_expired' end);
    end if;

    if not private.fdb_account_usable(v_account) then
        insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
        values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'account_unavailable');
        return jsonb_build_object('ok', false, 'error', 'account_unavailable');
    end if;

    perform pg_advisory_xact_lock(hashtextextended('fdb-account:' || v_account::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('fdb-device-identity:' || v_d::text, 0));

    -- This Auth identity may be the live device of one installation only (the same installation: credential replacement).
    select d.id, d.installation_id, d.account_uid into v_dev from private.devices d where d.auth_uid = v_d and d.status <> 'revoked' for update;
    if found and (v_dev.installation_id <> p_installation_id or v_dev.account_uid <> v_account) then
        insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
        values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'identity_in_use');
        return jsonb_build_object('ok', false, 'error', 'identity_in_use');
    end if;

    select i.owner_user_id into v_owner from public.installations i where i.id = p_installation_id for update;
    v_found := found;

    if v_found then
        if v_owner is distinct from v_account then
            -- Another account, an anonymous owner or a legacy ownerless row: NEVER transferred here (the claim protocol is the only path).
            insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
            values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'installation_conflict');
            return jsonb_build_object('ok', false, 'error', 'installation_conflict');
        end if;

        select d.id, d.auth_uid into v_dev from private.devices d where d.installation_id = p_installation_id and d.status <> 'revoked' for update;
        if found then
            if v_dev.auth_uid <> v_d then
                insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
                values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'installation_bound');
                return jsonb_build_object('ok', false, 'error', 'installation_bound');
            end if;
            update private.devices set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'replaced' where id = v_dev.id;
            insert into private.device_audit (event, account_uid, actor_uid, device_id, installation_id, detail)
            values ('device_replaced', v_account, v_d, v_dev.id, p_installation_id, 'same_identity');
        end if;
    else
        select count(*) into v_owned from public.installations i where i.owner_user_id = v_account;
        if v_owned >= 50 then
            insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
            values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'account_limit');
            return jsonb_build_object('ok', false, 'error', 'account_limit');
        end if;
    end if;

    select count(*) into v_live from private.devices d where d.account_uid = v_account and d.status <> 'revoked';
    if v_live >= 10 then
        insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
        values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'device_limit');
        return jsonb_build_object('ok', false, 'error', 'device_limit');
    end if;

    if not v_found then
        -- Reserve the id for the account (no snapshot yet; schema_version 0 can never collide with a real snapshot, which needs >= 7).
        insert into public.installations (id, owner_user_id, schema_version, addon_version, first_seen_at, last_seen_at)
        values (p_installation_id, v_account, 0, 'enrolled', now(), now());
    end if;

    v_secret := 'fdbd1_' || replace(v_device_id::text, '-', '') || '_' || translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');

    insert into private.devices (id, account_uid, installation_id, auth_uid, label, status, ticket_id, credential_hash, credential_issued_at, last_seen_at)
    values (v_device_id, v_account, p_installation_id, v_d, v_label, 'active', v_ticket_id, extensions.digest(v_secret, 'sha256'), clock_timestamp(), clock_timestamp());

    update private.enrollment_tickets
    set status = 'consumed', consumed_at = clock_timestamp(), consumed_device_id = v_device_id
    where id = v_ticket_id;

    insert into private.device_audit (event, account_uid, actor_uid, device_id, ticket_id, installation_id)
    values ('enroll_succeeded', v_account, v_d, v_device_id, v_ticket_id, p_installation_id);

    return jsonb_build_object('ok', true, 'device_id', v_device_id, 'device_secret', v_secret, 'installation_id', p_installation_id);
end;
$$;

create or replace function public.fdb_device_status(p_device_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_d uuid;
    v_inst text;
    v_dev private.devices;
    v_reason text;
    v_auth record;
    v_id uuid := private.fdb_device_id_from_secret(p_device_secret);
begin
    v_d := private.fdb_anonymous_caller();
    perform private.foreverdb_take_budget('device:uid:' || v_d::text, 60, 60);

    if v_id is not null then
        select d.installation_id into v_inst from private.devices d where d.id = v_id and d.auth_uid = v_d;
    end if;
    if v_inst is null then
        return jsonb_build_object('state', 'unknown', 'installation_id', null, 'needs_rotation', false, 'reason', null);
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_inst, 0));
    select * into v_auth from private.fdb_device_authorize(p_device_secret, v_d);
    v_dev := v_auth.o_device;
    v_reason := v_auth.o_reason;

    if v_reason = 'unknown' or v_reason = 'stale_credential' then
        return jsonb_build_object('state', 'unknown', 'installation_id', null, 'needs_rotation', false, 'reason', null);
    end if;

    -- The caller proved the secret: it may learn the precise state of its OWN device.
    select d.* into v_dev from private.devices d where d.id = v_id;
    return jsonb_build_object(
        'state', case v_reason when 'revoked' then 'revoked' when 'ownership_conflict' then 'ownership_conflict'
                               when 'account_unavailable' then 'account_unavailable' else 'active' end,
        'installation_id', v_dev.installation_id,
        'needs_rotation', v_reason is null and v_dev.credential_issued_at < clock_timestamp() - interval '30 days',
        'reason', case when v_reason = 'revoked' then v_dev.revoked_reason else null end);
end;
$$;

create or replace function public.fdb_device_ingest(p_device_secret text, p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_d uuid;
    v_sid uuid;
    v_installation text;
    v_dev_installation text;
    v_dev private.devices;
    v_reason text;
    v_result jsonb;
    v_auth record;
    v_old_claims text;
    v_old_sub text;
    v_id uuid := private.fdb_device_id_from_secret(p_device_secret);
begin
    v_d := private.fdb_anonymous_caller();
    v_sid := (auth.jwt() ->> 'session_id')::uuid;

    -- Quotas are charged to the DEVICE identity (never to the account), exactly like anonymous ingest.
    perform private.foreverdb_api_gate('ingest');

    if jsonb_typeof(p_snapshot) is distinct from 'object'
        or octet_length(p_snapshot::text) > 8388608
        or (p_snapshot ? 'sources' and jsonb_typeof(p_snapshot->'sources') <> 'array')
        or (p_snapshot ? 'guilds' and jsonb_typeof(p_snapshot->'guilds') <> 'array')
        or jsonb_array_length(coalesce(p_snapshot->'sources', '[]'::jsonb)) > 2500
        or jsonb_array_length(coalesce(p_snapshot->'guilds', '[]'::jsonb)) > 100
    then
        raise sqlstate 'PT413' using message = 'ForeverDB sync payload exceeds allowed bounds';
    end if;

    v_installation := p_snapshot->>'installationId';
    if length(coalesce(v_installation, '')) not between 1 and 128
       or p_snapshot->>'schemaVersion' is null
       or p_snapshot->>'updatedAt' is null then
        raise sqlstate 'PT400' using message = 'Invalid ForeverDB sync snapshot identity';
    end if;

    if v_id is not null then
        select d.installation_id into v_dev_installation from private.devices d where d.id = v_id and d.auth_uid = v_d;
    end if;
    if v_dev_installation is null then
        return jsonb_build_object('ok', false, 'error', 'device_unauthorized');
    end if;

    -- A device can only ever write its OWN installation: the id in the payload is checked against the registry, not trusted.
    if v_dev_installation <> v_installation then
        insert into private.device_audit (event, actor_uid, device_id, installation_id, detail)
        values ('ingest_refused', v_d, v_id, v_dev_installation, 'wrong_installation');
        return jsonb_build_object('ok', false, 'error', 'wrong_installation');
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_installation, 0));
    perform private.fdb_lock_live_session(v_d, v_sid, true);

    select * into v_auth from private.fdb_device_authorize(p_device_secret, v_d);
    v_dev := v_auth.o_device;
    v_reason := v_auth.o_reason;
    if v_reason is not null then
        if v_reason not in ('unknown', 'stale_credential') then
            insert into private.device_audit (event, account_uid, actor_uid, device_id, installation_id, detail)
            values ('ingest_refused', v_dev.account_uid, v_d, v_id, v_installation, v_reason);
        end if;
        return jsonb_build_object('ok', false, 'error', case v_reason
            when 'unknown' then 'device_unauthorized' when 'stale_credential' then 'device_credential_stale'
            when 'revoked' then 'device_revoked' when 'account_unavailable' then 'account_unavailable'
            else 'ownership_conflict' end);
    end if;

    -- Run the UNCHANGED ingest implementation as the owning account, for this statement only. The implementation takes the
    -- same advisory lock (re-entrant in this transaction) and applies its own owner check against the account uid.
    v_old_claims := current_setting('request.jwt.claims', true);
    v_old_sub := current_setting('request.jwt.claim.sub', true);
    perform set_config('request.jwt.claims',
        jsonb_build_object('sub', v_dev.account_uid, 'role', 'authenticated', 'aud', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_dev.account_uid::text, true);
    v_result := private.foreverdb_ingest_snapshot_impl_v1(p_snapshot);
    perform set_config('request.jwt.claims', coalesce(v_old_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(v_old_sub, ''), true);

    update private.devices set last_seen_at = clock_timestamp() where id = v_dev.id;

    return jsonb_build_object('ok', true) || coalesce(v_result, '{}'::jsonb);
end;
$$;

create or replace function public.fdb_device_rotate_credential(p_device_secret text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_d uuid;
    v_sid uuid;
    v_inst text;
    v_dev private.devices;
    v_reason text;
    v_auth record;
    v_secret text;
    v_id uuid := private.fdb_device_id_from_secret(p_device_secret);
begin
    v_d := private.fdb_anonymous_caller();
    v_sid := (auth.jwt() ->> 'session_id')::uuid;
    perform private.foreverdb_take_budget('device:uid:' || v_d::text, 60, 60);

    if v_id is not null then
        select d.installation_id into v_inst from private.devices d where d.id = v_id and d.auth_uid = v_d;
    end if;
    if v_inst is null then
        return jsonb_build_object('ok', false, 'error', 'device_unauthorized');
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_inst, 0));
    perform private.fdb_lock_live_session(v_d, v_sid, true);

    select * into v_auth from private.fdb_device_authorize(p_device_secret, v_d);
    v_dev := v_auth.o_device;
    v_reason := v_auth.o_reason;
    if v_reason is not null then
        return jsonb_build_object('ok', false, 'error', case v_reason
            when 'unknown' then 'device_unauthorized' when 'stale_credential' then 'device_credential_stale'
            when 'revoked' then 'device_revoked' when 'account_unavailable' then 'account_unavailable'
            else 'ownership_conflict' end);
    end if;

    v_secret := 'fdbd1_' || replace(v_dev.id::text, '-', '') || '_' || translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');
    update private.devices set next_credential_hash = extensions.digest(v_secret, 'sha256') where id = v_dev.id;
    insert into private.device_audit (event, account_uid, actor_uid, device_id, installation_id)
    values ('credential_rotated', v_dev.account_uid, v_d, v_dev.id, v_dev.installation_id);

    return jsonb_build_object('ok', true, 'device_secret', v_secret);
end;
$$;

-- Operator maintenance (never granted to a client role): drops old terminal tickets; audit rows are kept.
create or replace function private.fdb_prune_enrollment()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_deleted integer;
begin
    delete from private.enrollment_tickets t
    where t.created_at < clock_timestamp() - interval '90 days'
      and (t.status <> 'pending' or t.expires_at < clock_timestamp())
      and not exists (select 1 from private.devices d where d.ticket_id = t.id);
    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Lock timeouts and privileges (explicit revoke, then grant to `authenticated` only; helpers: nobody)
-- ---------------------------------------------------------------------------------------------------------------------
alter function public.fdb_account_enrollment_ticket_issue(text) set lock_timeout = '5s';
alter function public.fdb_account_enrollment_tickets() set lock_timeout = '5s';
alter function public.fdb_account_enrollment_ticket_revoke(uuid) set lock_timeout = '5s';
alter function public.fdb_account_devices() set lock_timeout = '5s';
alter function public.fdb_account_device_revoke(uuid) set lock_timeout = '5s';
alter function public.fdb_device_enroll(text, text, text) set lock_timeout = '5s';
alter function public.fdb_device_status(text) set lock_timeout = '5s';
alter function public.fdb_device_ingest(text, jsonb) set lock_timeout = '10s';
alter function public.fdb_device_ingest(text, jsonb) set statement_timeout = '15s';
alter function public.fdb_device_rotate_credential(text) set lock_timeout = '5s';

revoke all on function private.fdb_lock_live_session(uuid, uuid, boolean) from public, anon, authenticated, service_role;
revoke all on function private.fdb_account_usable(uuid) from public, anon, authenticated, service_role;
revoke all on function private.fdb_device_id_from_secret(text) from public, anon, authenticated, service_role;
revoke all on function private.fdb_device_match(text, private.devices) from public, anon, authenticated, service_role;
revoke all on function private.fdb_device_authorize(text, uuid) from public, anon, authenticated, service_role;
revoke all on function private.fdb_prune_enrollment() from public, anon, authenticated, service_role;

revoke all on function public.fdb_account_enrollment_ticket_issue(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_enrollment_tickets() from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_enrollment_ticket_revoke(uuid) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_devices() from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_device_revoke(uuid) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_enroll(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_status(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_ingest(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_rotate_credential(text) from public, anon, authenticated, service_role;

grant execute on function public.fdb_account_enrollment_ticket_issue(text) to authenticated;
grant execute on function public.fdb_account_enrollment_tickets() to authenticated;
grant execute on function public.fdb_account_enrollment_ticket_revoke(uuid) to authenticated;
grant execute on function public.fdb_account_devices() to authenticated;
grant execute on function public.fdb_account_device_revoke(uuid) to authenticated;
grant execute on function public.fdb_device_enroll(text, text, text) to authenticated;
grant execute on function public.fdb_device_status(text) to authenticated;
grant execute on function public.fdb_device_ingest(text, jsonb) to authenticated;
grant execute on function public.fdb_device_rotate_credential(text) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Post-apply assertions: the transaction aborts (nothing is applied) if any of them fails.
-- ---------------------------------------------------------------------------------------------------------------------
do $verify$
declare
    v_sig text;
    r record;
    v_after record;
    v_count integer;
begin
    foreach v_sig in array array[
        'public.fdb_account_enrollment_ticket_issue(text)', 'public.fdb_account_enrollment_tickets()',
        'public.fdb_account_enrollment_ticket_revoke(uuid)', 'public.fdb_account_devices()', 'public.fdb_account_device_revoke(uuid)',
        'public.fdb_device_enroll(text,text,text)', 'public.fdb_device_status(text)', 'public.fdb_device_ingest(text,jsonb)',
        'public.fdb_device_rotate_credential(text)',
        'private.fdb_lock_live_session(uuid,uuid,boolean)', 'private.fdb_account_usable(uuid)', 'private.fdb_device_authorize(text,uuid)',
        'private.fdb_device_match(text,private.devices)', 'private.fdb_prune_enrollment()'
    ] loop
        select p.prosecdef, pg_get_userbyid(p.proowner) as owner, coalesce(p.proconfig, '{}') as config
        into v_after from pg_proc p where p.oid = to_regprocedure(v_sig);
        if not found then raise exception '0014 post-condition: % is missing', v_sig; end if;
        if not v_after.prosecdef then raise exception '0014 post-condition: % is not SECURITY DEFINER', v_sig; end if;
        if v_after.owner <> current_user then raise exception '0014 post-condition: % is not owned by the migration role', v_sig; end if;
        if not ('search_path=""' = any (v_after.config)) then raise exception '0014 post-condition: % lacks search_path = empty', v_sig; end if;
        if has_function_privilege('public', v_sig, 'execute') or has_function_privilege('anon', v_sig, 'execute')
           or has_function_privilege('service_role', v_sig, 'execute') then
            raise exception '0014 post-condition: % is executable by public, anon or service_role', v_sig;
        end if;
        if v_sig like 'private.%' then
            if has_function_privilege('authenticated', v_sig, 'execute') then
                raise exception '0014 post-condition: helper % is executable by authenticated', v_sig;
            end if;
        else
            if not has_function_privilege('authenticated', v_sig, 'execute') then
                raise exception '0014 post-condition: authenticated cannot execute %', v_sig;
            end if;
            if not exists (select 1 from unnest(v_after.config) c where c like 'lock_timeout=%') then
                raise exception '0014 post-condition: % lacks lock_timeout', v_sig;
            end if;
        end if;
    end loop;

    foreach v_sig in array array['private.enrollment_tickets', 'private.devices', 'private.device_audit'] loop
        if not (select c.relrowsecurity from pg_class c where c.oid = v_sig::regclass) then
            raise exception '0014 post-condition: RLS is not enabled on %', v_sig;
        end if;
        if has_table_privilege('public', v_sig, 'select,insert,update,delete,truncate,references,trigger')
           or has_table_privilege('anon', v_sig, 'select,insert,update,delete,truncate,references,trigger')
           or has_table_privilege('authenticated', v_sig, 'select,insert,update,delete,truncate,references,trigger')
           or has_table_privilege('service_role', v_sig, 'select,insert,update,delete,truncate,references,trigger') then
            raise exception '0014 post-condition: a client role has a privilege on %', v_sig;
        end if;
    end loop;
    if has_sequence_privilege('authenticated', 'private.device_audit_id_seq', 'usage,select,update')
       or has_sequence_privilege('anon', 'private.device_audit_id_seq', 'usage,select,update') then
        raise exception '0014 post-condition: a client role can use the audit sequence';
    end if;
    if has_schema_privilege('anon', 'private', 'usage') or has_schema_privilege('authenticated', 'private', 'usage') then
        raise exception '0014 post-condition: private schema is reachable by a client role';
    end if;

    for r in select * from _fdb0014_before loop
        select md5(p.prosrc) as src_md5, coalesce(p.proacl::text, '') as acl
        into v_after from pg_proc p where p.oid = to_regprocedure(r.sig);
        if not found or v_after.src_md5 is distinct from r.src_md5 or v_after.acl is distinct from r.acl then
            raise exception '0014 post-condition: existing function % changed', r.sig;
        end if;
    end loop;

    if not has_function_privilege('authenticated', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'execute')
       or has_function_privilege('anon', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'execute') then
        raise exception '0014 post-condition: anonymous-path ingest privileges changed';
    end if;

    select count(*) into v_count
    from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
      and p.proname in ('fdb_account_enrollment_ticket_issue', 'fdb_account_enrollment_tickets', 'fdb_account_enrollment_ticket_revoke',
                        'fdb_account_devices', 'fdb_account_device_revoke', 'fdb_device_enroll', 'fdb_device_status', 'fdb_device_ingest',
                        'fdb_device_rotate_credential', 'fdb_device_id_from_secret', 'fdb_device_match', 'fdb_device_authorize',
                        'fdb_account_usable', 'fdb_lock_live_session', 'fdb_prune_enrollment');
    if v_count <> 15 then
        raise exception '0014 post-condition: expected exactly 15 new functions, found % (overloads?)', v_count;
    end if;
end $verify$;

notify pgrst, 'reload schema';

commit;
