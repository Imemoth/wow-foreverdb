-- ForeverDB 0019: retire user-managed installation ownership from public observation ingestion.
--
-- The authenticated JWT is still required and is the technical caller identity. This migration adds an installation-scoped,
-- server-owned mapping from that identity to the legacy row identity used by the unchanged observation writer. The Companion never
-- supplies an owner UID. Existing owner/claim/device rows and all observations are retained. Guildbook stays local-only through 0018.
-- New IDs can be bound only by an active anonymous GoTrue session and only while the ID has no installation row; the ID alone is
-- therefore never proof for an existing installation. Global and per-auth-UID ingest budgets, payload bounds, advisory locking,
-- idempotent snapshot timestamps, and the observation-only 0018 projection remain in force.

begin;

do $preflight$
begin
    if to_regprocedure('private.fdb_caller()') is null
       or to_regprocedure('private.fdb_anonymous_caller()') is null
       or to_regprocedure('private.foreverdb_api_gate(text)') is null
       or to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)') is null
       or to_regprocedure('private.fdb_public_snapshot(jsonb)') is null
       or to_regclass('public.installations') is null then
        raise exception '0019 pre-flight: required authenticated observation-only ingest dependencies are missing';
    end if;
    if to_regclass('private.guildbook_cloud_sync_guard') is null
       or not exists (select 1 from private.guildbook_cloud_sync_guard where guard_name = 'disabled') then
        raise exception '0019 pre-flight: Guildbook local-only guard 0018 is missing';
    end if;
    if to_regclass('supabase_migrations.schema_migrations') is not null
       and exists (select 1 from supabase_migrations.schema_migrations where name = 'technical_installation_ingest') then
        raise exception '0019 pre-flight: ledger already shows technical_installation_ingest';
    end if;
end;
$preflight$;

create table if not exists private.installation_upload_identities (
    installation_id text not null references public.installations(id) on delete cascade deferrable initially deferred,
    auth_uid uuid not null,
    legacy_owner_uid uuid not null,
    created_at timestamptz not null default clock_timestamp(),
    primary key (installation_id, auth_uid)
);
create index if not exists installation_upload_identities_auth_uid_idx
    on private.installation_upload_identities(auth_uid);
revoke all on table private.installation_upload_identities from public, anon, authenticated, service_role;

-- Carry forward only server-proven credentials. The current identity preserves compatibility for existing sessions. A completed claim
-- also preserves the original anonymous technical credential. Device identities are included so the existing device RPC remains valid.
insert into private.installation_upload_identities (installation_id, auth_uid, legacy_owner_uid)
select i.id, i.owner_user_id, i.owner_user_id
from public.installations i
where i.owner_user_id is not null
on conflict (installation_id, auth_uid) do nothing;

do $claim_map$
begin
    if to_regclass('private.account_installations') is not null then
        insert into private.installation_upload_identities (installation_id, auth_uid, legacy_owner_uid)
        select l.installation_id, l.previous_owner_uid, i.owner_user_id
        from private.account_installations l
        join public.installations i on i.id = l.installation_id
        where i.owner_user_id is not null
        on conflict (installation_id, auth_uid) do nothing;
    end if;
    if to_regclass('private.devices') is not null then
        insert into private.installation_upload_identities (installation_id, auth_uid, legacy_owner_uid)
        select d.installation_id, d.auth_uid, i.owner_user_id
        from private.devices d
        join public.installations i on i.id = d.installation_id
        where i.owner_user_id is not null and d.revoked_at is null
        on conflict (installation_id, auth_uid) do nothing;
    end if;
end;
$claim_map$;

create or replace function public.ingest_foreverdb_snapshot_auth(p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
    v_installation text;
    v_legacy_owner uuid;
    v_is_anonymous boolean;
    v_claims text;
    v_sub text;
    v_result jsonb;
begin
    -- Auth.uid is verified by Supabase/PostgREST; additionally require a live GoTrue session so stale/forged identity metadata cannot
    -- enroll a binding. The API budget uses this technical UID and does not charge a human account or trust a client installation ID.
    v_uid := private.fdb_caller();
    perform private.foreverdb_api_gate('ingest');

    if jsonb_typeof(p_snapshot) is distinct from 'object'
       or octet_length(p_snapshot::text) > 8388608
       or (p_snapshot ? 'sources' and jsonb_typeof(p_snapshot->'sources') <> 'array')
       or (p_snapshot ? 'guilds' and jsonb_typeof(p_snapshot->'guilds') <> 'array')
       or jsonb_array_length(coalesce(p_snapshot->'sources','[]'::jsonb)) > 2500
       or jsonb_array_length(coalesce(p_snapshot->'guilds','[]'::jsonb)) > 100 then
        raise sqlstate 'PT413' using message = 'ForeverDB sync payload exceeds allowed bounds';
    end if;

    v_installation := p_snapshot->>'installationId';
    if length(coalesce(v_installation,'')) not between 1 and 128
       or p_snapshot->>'schemaVersion' is null
       or p_snapshot->>'updatedAt' is null then
        raise sqlstate 'PT400' using message = 'Invalid ForeverDB sync snapshot identity';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_installation, 0));
    select m.legacy_owner_uid into v_legacy_owner
      from private.installation_upload_identities m
     where m.installation_id = v_installation and m.auth_uid = v_uid;

    if v_legacy_owner is null then
        -- Only a fresh, unknown installation may be created by an anonymous Companion. An existing or historical installation with
        -- no migrated technical credential fails closed and needs operator-led credential recovery; it is never first-claimer-owned.
        if exists (select 1 from public.installations i where i.id = v_installation) then
            raise sqlstate 'PT403' using message = 'Installation technical credential is not registered';
        end if;
        select u.is_anonymous into v_is_anonymous from auth.users u where u.id = v_uid and u.deleted_at is null;
        if coalesce(v_is_anonymous, false) is not true then
            raise sqlstate 'PT403' using message = 'Fresh Companion installation requires an anonymous technical session';
        end if;
        insert into private.installation_upload_identities (installation_id, auth_uid, legacy_owner_uid)
        values (v_installation, v_uid, v_uid);
        v_legacy_owner := v_uid;
    end if;

    -- The legacy writer is preserved byte-for-byte to keep snapshot validation, deduplication, provenance and history semantics.
    -- Only after the live technical identity has matched this installation's server-side mapping do we present the historical row UID
    -- to that internal writer. That UID is never accepted from a request body and cannot be used to authorize another installation.
    v_claims := current_setting('request.jwt.claims', true);
    v_sub := current_setting('request.jwt.claim.sub', true);
    perform set_config('request.jwt.claims',
        (coalesce(nullif(v_claims, ''), '{}')::jsonb || jsonb_build_object('sub', v_legacy_owner::text))::text, true);
    perform set_config('request.jwt.claim.sub', v_legacy_owner::text, true);
    v_result := private.foreverdb_ingest_snapshot_impl_v1(private.fdb_public_snapshot(p_snapshot));
    perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);
    perform set_config('request.jwt.claim.sub', coalesce(v_sub, ''), true);
    return v_result;
end;
$$;

alter function public.ingest_foreverdb_snapshot_auth(jsonb) set statement_timeout = '15s';
revoke all on function public.ingest_foreverdb_snapshot_auth(jsonb) from public, anon, service_role;
grant execute on function public.ingest_foreverdb_snapshot_auth(jsonb) to authenticated;
notify pgrst, 'reload schema';

-- Legacy account-claim RPCs remain available to old clients during the compatibility window. If one moves a historical row, update
-- only the private internal writer key for already-proven technical credentials; do not add or transfer any auth_uid mapping.
create or replace function private.fdb_sync_legacy_upload_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if new.owner_user_id is not null and new.owner_user_id is distinct from old.owner_user_id then
        update private.installation_upload_identities
           set legacy_owner_uid = new.owner_user_id
         where installation_id = new.id;
    end if;
    return new;
end;
$$;
alter function private.fdb_sync_legacy_upload_owner() set statement_timeout = '10s';
drop trigger if exists installations_sync_legacy_upload_owner on public.installations;
create trigger installations_sync_legacy_upload_owner
after update of owner_user_id on public.installations
for each row execute function private.fdb_sync_legacy_upload_owner();
revoke all on function private.fdb_sync_legacy_upload_owner() from public, anon, authenticated, service_role;

-- Existing account tickets can still create revocable device credentials, but only after the target installation has already
-- authenticated a public sync with its technical identity. This removes the old owner_user_id equality check without allowing an
-- installation ID alone (or an unrelated anonymous identity) to enroll a device.
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
    v_found boolean;
    v_dev record;
    v_live integer;
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

    -- Possession of an installation ID is not enrollment proof. The same live anonymous Auth identity must already have a
    -- server-created upload mapping for this installation (created by authenticated public sync, or carried forward by 0019).
    select exists (
        select 1 from private.installation_upload_identities m
         where m.installation_id = p_installation_id and m.auth_uid = v_d
    ) into v_found;
    if not v_found then
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

    select count(*) into v_live from private.devices d where d.account_uid = v_account and d.status <> 'revoked';
    if v_live >= 10 then
        insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
        values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'device_limit');
        return jsonb_build_object('ok', false, 'error', 'device_limit');
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

-- The enrolled-device verifier keeps account revocation and secret rotation, but it no longer compares the device's account to the
-- installation row's historical owner column. The validated device credential is the authorization; the row UID below is only passed
-- to the byte-preserved observation writer as an internal compatibility key.
create or replace function private.fdb_device_authorize(p_secret text, p_uid uuid, out o_device private.devices, out o_reason text)
returns record
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_id uuid := private.fdb_device_id_from_secret(p_secret);
    v_match text;
    v_legacy_uid uuid;
begin
    o_reason := 'unknown';
    if v_id is null then return; end if;
    select * into o_device from private.devices d where d.id = v_id for update;
    if not found or o_device.auth_uid is distinct from p_uid then o_device := null; return; end if;
    v_match := private.fdb_device_match(p_secret, o_device);
    if v_match is null then o_device := null; return; end if;
    if v_match = 'retired' then
        if o_device.status <> 'revoked' and o_device.retired_at > clock_timestamp() - interval '120 seconds' then
            o_reason := 'stale_credential'; return;
        end if;
        if o_device.status <> 'revoked' then
            update private.devices set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'credential_reuse' where id = o_device.id;
            insert into private.device_audit (event, account_uid, actor_uid, device_id, installation_id, detail)
            values ('credential_reuse', o_device.account_uid, p_uid, o_device.id, o_device.installation_id, 'retired_credential');
        end if;
        o_reason := 'revoked'; return;
    end if;
    if o_device.status <> 'active' then o_reason := 'revoked'; return; end if;
    if v_match = 'next' then
        update private.devices
           set retired_hash = credential_hash, retired_at = clock_timestamp(), credential_hash = next_credential_hash,
               next_credential_hash = null, credential_issued_at = clock_timestamp()
         where id = o_device.id returning * into o_device;
    end if;
    if not private.fdb_account_usable(o_device.account_uid) then o_reason := 'account_unavailable'; return; end if;
    select i.owner_user_id into v_legacy_uid from public.installations i where i.id = o_device.installation_id;
    if v_legacy_uid is null then o_reason := 'ownership_conflict'; return; end if;
    -- fdb_device_ingest uses this returned value only for the legacy writer's internal row key; authorization already came from the
    -- authenticated device UID, installation match, live session and server-side secret hash above.
    o_device.account_uid := v_legacy_uid;
    o_reason := null;
end;
$$;
revoke all on function public.fdb_device_enroll(text,text,text) from public, anon, service_role;
grant execute on function public.fdb_device_enroll(text,text,text) to authenticated;
alter function private.fdb_device_authorize(text,uuid) set statement_timeout = '10s';
revoke all on function private.fdb_device_authorize(text,uuid) from public, anon, authenticated, service_role;

do $verify$
declare
    v_proc record;
begin
    if has_function_privilege('anon', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'execute')
       or not has_function_privilege('authenticated', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'execute') then
        raise exception '0019 post-condition: public ingestion RPC grants are invalid';
    end if;
    if has_function_privilege('anon', 'public.fdb_device_enroll(text,text,text)', 'execute')
       or not has_function_privilege('authenticated', 'public.fdb_device_enroll(text,text,text)', 'execute') then
        raise exception '0019 post-condition: device enrollment RPC grants are invalid';
    end if;
    if has_table_privilege('public', 'private.installation_upload_identities', 'select,insert,update,delete,truncate,references,trigger')
       or has_table_privilege('anon', 'private.installation_upload_identities', 'select,insert,update,delete,truncate,references,trigger')
       or has_table_privilege('authenticated', 'private.installation_upload_identities', 'select,insert,update,delete,truncate,references,trigger')
       or has_table_privilege('service_role', 'private.installation_upload_identities', 'select,insert,update,delete,truncate,references,trigger') then
        raise exception '0019 post-condition: private technical identity table is exposed';
    end if;
    for v_proc in select p.oid::regprocedure as signature, p.prosecdef, p.proconfig
      from pg_catalog.pg_proc p
     where p.oid in (
       'public.ingest_foreverdb_snapshot_auth(jsonb)'::regprocedure,
       'public.fdb_device_enroll(text,text,text)'::regprocedure,
       'private.fdb_device_authorize(text,uuid)'::regprocedure,
       'private.fdb_sync_legacy_upload_owner()'::regprocedure
     )
    loop
        if not v_proc.prosecdef or not ('search_path=""' = any(coalesce(v_proc.proconfig, '{}'::text[]))) then
            raise exception '0019 post-condition: % must remain SECURITY DEFINER with an empty search path', v_proc.signature;
        end if;
    end loop;
    if (select count(*) from pg_catalog.pg_proc p where p.oid in (
       'public.ingest_foreverdb_snapshot_auth(jsonb)'::regprocedure,
       'public.fdb_device_enroll(text,text,text)'::regprocedure,
       'private.fdb_device_authorize(text,uuid)'::regprocedure,
       'private.fdb_sync_legacy_upload_owner()'::regprocedure
    )) <> 4 then
        raise exception '0019 post-condition: expected all four guarded functions';
    end if;
end;
$verify$;

commit;
