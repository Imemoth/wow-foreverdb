-- ForeverDB 0018: Guildbook is Companion-local only.
--
-- This migration is deployable against both the current production shape
-- (legacy Guildbook reads and legacy ingest) and the pending 0016/0017 shape
-- (scoped Guildbook RPCs and collector wrappers).
--
-- It retains tables, rows and function definitions. It removes client
-- EXECUTE grants from every account Guildbook RPC that exists, and puts an
-- observation-only projection in front of the legacy ingest implementation.
-- The projection is important: revoking only the new Companion RPCs would
-- leave old clients able to mutate installation_guild* through public ingest.
--
-- 0018 does not require 0016 or 0017. It requires the legacy private ingest
-- implementation from the 0009+ schema. The normal migration runner records
-- the ledger entry; this file intentionally does not write the ledger.
-- The grants can be restored only by the explicit operator script in
-- database/rollback/0018_restore.sql.

begin;

do $preflight$
begin
    if to_regclass('supabase_migrations.schema_migrations') is not null
       and exists (select 1 from supabase_migrations.schema_migrations where name = 'disable_guildbook_cloud_sync') then
        raise exception '0018 pre-flight: ledger already shows disable_guildbook_cloud_sync';
    end if;

    if to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)') is null
       and to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is null then
        raise exception '0018 pre-flight: legacy private ingest implementation is missing';
    end if;
end $preflight$;

-- 0016 already moved the old implementation to *_legacy. On a current
-- production database that rename has not happened yet, so preserve the
-- existing body under the compatibility name before installing the common
-- projection wrapper.
do $prepare$
begin
    if to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is null then
        execute 'alter function private.foreverdb_ingest_snapshot_impl_v1(jsonb) rename to foreverdb_ingest_snapshot_impl_v1_legacy';
    end if;
end $prepare$;

create or replace function private.fdb_public_snapshot(p_snapshot jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
    select coalesce(p_snapshot, '{}'::jsonb)
        - 'guilds'
        - 'guildbook'
        - 'guildbookCapture'
        - 'guildbookCaptureId'
        - 'guildbookCapturedAt'
        - 'guildbookSourceCharacter';
$$;

-- Both public ingest entrypoints already call this private implementation.
-- Keeping the projection here gives anonymous registered-session and enrolled
-- device paths identical behavior without weakening their existing checks.
-- The legacy implementation also deletes and rebuilds Guildbook rows on every
-- snapshot. Preserve those rows around the call so a Guildbook-free public
-- upload cannot erase a previous local/private capture.
create or replace function private.foreverdb_ingest_snapshot_impl_v1(p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_installation text := p_snapshot->>'installationId';
    v_result jsonb;
begin
    drop table if exists pg_temp._fdb0018_guilds;
    drop table if exists pg_temp._fdb0018_guild_members;
    drop table if exists pg_temp._fdb0018_guild_professions;

    create temp table _fdb0018_guilds on commit drop as
        select * from public.installation_guilds where installation_id = v_installation;
    create temp table _fdb0018_guild_members on commit drop as
        select * from public.installation_guild_members where installation_id = v_installation;
    create temp table _fdb0018_guild_professions on commit drop as
        select * from public.installation_guild_professions where installation_id = v_installation;

    v_result := private.foreverdb_ingest_snapshot_impl_v1_legacy(
        private.fdb_public_snapshot(p_snapshot)
    );

    insert into public.installation_guilds select * from pg_temp._fdb0018_guilds;
    insert into public.installation_guild_members select * from pg_temp._fdb0018_guild_members;
    insert into public.installation_guild_professions select * from pg_temp._fdb0018_guild_professions;
    return v_result;
end;
$$;

revoke all on function private.fdb_public_snapshot(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.foreverdb_ingest_snapshot_impl_v1(jsonb) from public, anon, authenticated, service_role;

-- Account Guildbook RPC signatures changed between 0012 and 0016. Discover
-- actual catalog signatures rather than failing when an optional RPC is absent,
-- and revoke every matching overload found.
do $revoke$
declare
    r record;
begin
    for r in
        select p.oid::regprocedure::text as sig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname like 'fdb_account_guildbook_%'
    loop
        execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
    end loop;
end $revoke$;

do $verify$
declare
    r record;
begin
    if to_regprocedure('private.fdb_public_snapshot(jsonb)') is null
       or to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)') is null
       or to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is null then
        raise exception '0018 post-condition: legacy ingest projection is incomplete';
    end if;

    for r in
        select p.oid::regprocedure::text as sig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname like 'fdb_account_guildbook_%'
    loop
        if has_function_privilege('public', r.sig, 'execute')
           or has_function_privilege('anon', r.sig, 'execute')
           or has_function_privilege('authenticated', r.sig, 'execute')
           or has_function_privilege('service_role', r.sig, 'execute') then
            raise exception '0018 post-condition: % remains callable by an API role', r.sig;
        end if;
    end loop;
end $verify$;

notify pgrst, 'reload schema';
commit;
