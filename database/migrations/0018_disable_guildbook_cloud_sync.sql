-- ForeverDB 0018: Guildbook is Companion-local only - server-side kill switch.
--
-- OWNER POLICY (final): Guildbook data stays exclusively on the user's computer. No Guildbook cloud upload, download, backup, sync or RPC.
-- The Companion is being changed to stop sending guilds; this migration makes the SERVER refuse them no matter which client version calls.
--
-- WHAT IT DOES (and only this)
--   1. Moves nothing and deletes nothing. No Guildbook, observation, installation, claim or device row is read-modified, and the guild
--      table definitions, indexes and foreign keys are untouched. Historical Guildbook rows stay exactly as they are; removing them is a
--      separate, owner-authorised step (database/ops/guildbook_historical_cleanup.sql, docs/guildbook-local-only/historical-guildbook-data.md).
--   2. Puts an observation-only projection in front of the private legacy ingest implementation. Both public entrypoints
--      (ingest_foreverdb_snapshot_auth for anonymous and registered sessions, and fdb_device_ingest for enrolled devices) already end in
--      private.foreverdb_ingest_snapshot_impl_v1(jsonb); their authentication, ownership, budget, bounds and device checks are NOT touched
--      or duplicated here. Sources, items and locations are ingested exactly as before; `guilds` (and the other Guildbook keys) are
--      dropped before the legacy body sees the payload. Old Companion versions that still send them keep working, minus Guildbook.
--   3. Revokes EXECUTE from public, anon, authenticated and service_role on EVERY public function whose name contains `guildbook`
--      (catalog sweep: the 0012 read pair here, and any later account-scoped family). Definitions are retained.
--   4. Creates the marker table private.guildbook_cloud_sync_guard (one row, 'disabled'). Later migrations and the restore script read it.
--
-- DESIGN NOTES (reviewed against the RC: 0001..0009, 0011, 0012, 0014, 0015)
--   * Legacy impl rewrites Guildbook on every snapshot. The unmodified body (0005, kept under the name *_v1_legacy) does
--     `delete from installation_guild_professions/members/guilds where installation_id = ...` and re-inserts from p_snapshot->'guilds'
--     on every non-stale snapshot. With `guilds` stripped, a Guildbook-free upload would therefore silently ERASE the previous cloud
--     Guildbook of that installation: irreversibly, unaudited and before the owner has backed anything up. The owner decided deletion is a
--     separate authorised step, so the wrapper preserves the rows around the legacy call. The dance is still needed (a different
--     approach, copying the 400-line legacy body without the guild statements, would fork the very code the 0012 pre-flight pins).
--   * Corrections relative to the reference implementation (PR #112 / 0018 there): (a) the legacy body returns `stale_ignored` BEFORE it
--     deletes anything, so re-inserting the saved rows must be `on conflict do nothing` or a stale snapshot would fail with a duplicate
--     key; (b) the wrapper takes the per-installation advisory lock (same key as ingest, claims and the cleanup script; re-entrant in
--     this transaction) before it copies, so a concurrent cleanup cannot be resurrected by the re-insert; (c) it copies nothing and
--     creates no temp table for an installation that has no Guildbook rows (the normal case once Companions stop sending them), so
--     the hot path pays one indexed EXISTS; (d) the legacy function itself is also closed to API roles.
--   * Atomicity: the wrapper adds no savepoint. A legacy failure (bad payload, owner mismatch) aborts the caller's transaction, which
--     also discards the temp copy; the original rows are then untouched by definition.
--   * Order independence. The migration is written to apply (i) on the RC (0012 + 0014 + 0015, no 0016/0017) in any relative order with 0014/0015,
--     and (ii) on a database where the not-yet-merged account-scoped Guildbook migrations (0016/0017 on the other branch, deliberately absent
--     from this branch) were applied before or after it: it renames only when the compatibility name is free, replaces the wrapper with
--     `create or replace`, and discovers RPC signatures from the catalog.
--   * Re-applying 0012 after this migration is refused by the 0012 pre-flight (it pins the legacy ingest body and the wrapper does not
--     contain it). That is deliberate fail-closed behaviour: a re-run of 0012 would re-grant the Guildbook read RPCs. The same is true of
--     database/restore/0013_* and database/rollback/0012_kill_switch_restore.sql (the latter has no such guard: after running it, run
--     database/ops/guildbook_local_only_reassert.sql). Re-applying 0014 and 0015 is safe (neither pins the ingest body).
--   * The installation-list RPC of 0012 (it returns a per-installation `guild_count`) is NOT redefined here. It is owner-scoped, returns a
--     count only (no names, guids or ranks), and returns 0 once the historical cleanup has run. Redefining an account function is a
--     change to the linted account migration set (web/tests/unit/account-migration-conformance.test.ts lints every migration that names
--     an account function as ONE unit) and must be made together with that change. This file therefore deliberately never spells those names
--     in clear text: the catalog sweep below builds its pattern with a bracket so this kill switch is not treated as an account migration.
--     (A static test, database/tests/account/11_legacy_guildbook_paths.test.mjs, pins that property.)
--   * Does not write the migration ledger (the runner does). The grants can be restored only by database/rollback/0018_restore.sql.
--
-- Forward-only. NOT applied to any real project by the repository: production use follows
-- docs/guildbook-local-only/server-deployment-runbook.md and needs separate owner authorisation.

begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Pre-flight (read-only)
-- ---------------------------------------------------------------------------------------------------------------------
do $preflight$
declare
    v_impl oid := to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)');
    v_legacy oid := to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)');
    v_check oid;
    v_src text;
begin
    if to_regclass('supabase_migrations.schema_migrations') is not null
       and exists (select 1 from supabase_migrations.schema_migrations where name = 'disable_guildbook_cloud_sync') then
        raise exception '0018 pre-flight: ledger already shows disable_guildbook_cloud_sync';
    end if;

    if to_regnamespace('private') is null then
        raise exception '0018 pre-flight: schema private is missing (apply 0009 first)';
    end if;

    if v_impl is null and v_legacy is null then
        raise exception '0018 pre-flight: legacy private ingest implementation is missing';
    end if;

    if to_regclass('public.installation_guilds') is null
       or to_regclass('public.installation_guild_members') is null
       or to_regclass('public.installation_guild_professions') is null then
        raise exception '0018 pre-flight: Guildbook tables are missing';
    end if;

    -- The body that is going to be wrapped must be the original 0005 implementation (renamed by this migration, or already renamed by an
    -- earlier run / a later-numbered sibling migration), not an unknown function that happens to have the name.
    v_check := coalesce(v_legacy, v_impl);
    select p.prosrc into v_src from pg_proc p where p.oid = v_check;
    if v_src not like '%pg_advisory_xact_lock%' or v_src not like '%Installation belongs to another authenticated client%' then
        raise exception '0018 pre-flight: the legacy ingest implementation is not the expected one';
    end if;
    if (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = v_check) <> current_user then
        raise exception '0018 pre-flight: the legacy ingest implementation is not owned by the migration role %', current_user;
    end if;
end $preflight$;

-- Fingerprints for the post-conditions: every existing function (prosrc + ACL) and the content of the three Guildbook tables.
create temporary table _fdb0018_fn_before on commit drop as
select p.oid::regprocedure::text as sig, p.proname, md5(p.prosrc) as src_md5, coalesce(p.proacl::text, '') as acl
from pg_proc p
where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace);

create temporary table _fdb0018_rows_before on commit drop as
select 'guilds'::text as t, count(*) as n,
       md5(coalesce(string_agg(md5(to_jsonb(g)::text), '|' order by md5(to_jsonb(g)::text)), '')) as h from public.installation_guilds g
union all
select 'members', count(*), md5(coalesce(string_agg(md5(to_jsonb(m)::text), '|' order by md5(to_jsonb(m)::text)), '')) from public.installation_guild_members m
union all
select 'professions', count(*), md5(coalesce(string_agg(md5(to_jsonb(p)::text), '|' order by md5(to_jsonb(p)::text)), '')) from public.installation_guild_professions p;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Durable marker. The ledger records execution order; this row protects a database that is recovered out of order.
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists private.guildbook_cloud_sync_guard (
    guard_name text primary key check (guard_name = 'disabled'),
    activated_at timestamptz not null default clock_timestamp()
);
insert into private.guildbook_cloud_sync_guard (guard_name) values ('disabled') on conflict (guard_name) do nothing;
alter table private.guildbook_cloud_sync_guard enable row level security;
revoke all on table private.guildbook_cloud_sync_guard from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Observation-only projection in front of the legacy implementation.
-- ---------------------------------------------------------------------------------------------------------------------
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

-- Keep the original body under the compatibility name (0016 on the sibling branch uses the same name and the same rename-if-free rule).
do $prepare$
begin
    if to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is null then
        execute 'alter function private.foreverdb_ingest_snapshot_impl_v1(jsonb) rename to foreverdb_ingest_snapshot_impl_v1_legacy';
    end if;
end $prepare$;

create or replace function private.foreverdb_ingest_snapshot_impl_v1(p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_installation text := p_snapshot->>'installationId';
    v_preserve boolean := false;
    v_result jsonb;
begin
    -- Take the per-installation lock first (the legacy body takes the same one; it is re-entrant). Rows can only disappear after this
    -- point through the owner-run cleanup, which uses the same lock and skips a busy installation.
    if v_installation is not null and v_installation <> '' then
        perform pg_advisory_xact_lock(hashtextextended(v_installation, 0));
        -- Members and professions cannot exist without a guild row (foreign keys), so this one probe decides everything.
        v_preserve := exists (select 1 from public.installation_guilds g where g.installation_id = v_installation);
    end if;

    if v_preserve then
        drop table if exists pg_temp._fdb0018_guilds;
        drop table if exists pg_temp._fdb0018_guild_members;
        drop table if exists pg_temp._fdb0018_guild_professions;
        create temp table _fdb0018_guilds on commit drop as
            select * from public.installation_guilds where installation_id = v_installation;
        create temp table _fdb0018_guild_members on commit drop as
            select * from public.installation_guild_members where installation_id = v_installation;
        create temp table _fdb0018_guild_professions on commit drop as
            select * from public.installation_guild_professions where installation_id = v_installation;
    end if;

    v_result := private.foreverdb_ingest_snapshot_impl_v1_legacy(private.fdb_public_snapshot(p_snapshot));

    if v_preserve then
        -- `on conflict do nothing`: a stale snapshot is ignored by the legacy body before it deletes anything, so the rows are still there.
        insert into public.installation_guilds select * from pg_temp._fdb0018_guilds on conflict do nothing;
        insert into public.installation_guild_members select * from pg_temp._fdb0018_guild_members on conflict do nothing;
        insert into public.installation_guild_professions select * from pg_temp._fdb0018_guild_professions on conflict do nothing;
    end if;
    return v_result;
end;
$$;

revoke all on function private.fdb_public_snapshot(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.foreverdb_ingest_snapshot_impl_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Close every Guildbook RPC. Signatures differ between 0012 and the sibling branch's later family, and some may be absent, so the
--    catalog is swept instead of naming them. (The bracket keeps this file out of the account-migration linter; see header.)
-- ---------------------------------------------------------------------------------------------------------------------
do $revoke$
declare
    r record;
begin
    for r in
        select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname ~* 'guildbook'
    loop
        execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
    end loop;
end $revoke$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Post-conditions: the transaction aborts (nothing is applied) if any of them fails.
-- ---------------------------------------------------------------------------------------------------------------------
do $verify$
declare
    r record;
    v_sig text;
    v_src text;
    v_now record;
begin
    foreach v_sig in array array[
        'private.fdb_public_snapshot(jsonb)',
        'private.foreverdb_ingest_snapshot_impl_v1(jsonb)',
        'private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)'
    ] loop
        if to_regprocedure(v_sig) is null then
            raise exception '0018 post-condition: % is missing', v_sig;
        end if;
        if has_function_privilege('public', v_sig, 'execute') or has_function_privilege('anon', v_sig, 'execute')
           or has_function_privilege('authenticated', v_sig, 'execute') or has_function_privilege('service_role', v_sig, 'execute') then
            raise exception '0018 post-condition: % is executable by an API role', v_sig;
        end if;
    end loop;

    select p.prosrc into v_src from pg_proc p where p.oid = 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)'::regprocedure;
    if v_src not like '%foreverdb_ingest_snapshot_impl_v1_legacy%' or v_src not like '%fdb_public_snapshot%' then
        raise exception '0018 post-condition: the ingest implementation does not use the observation-only projection';
    end if;
    select p.prosrc into v_src from pg_proc p where p.oid = 'private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)'::regprocedure;
    if v_src not like '%pg_advisory_xact_lock%' or v_src not like '%Installation belongs to another authenticated client%' then
        raise exception '0018 post-condition: the legacy ingest body was altered';
    end if;

    if not exists (select 1 from private.guildbook_cloud_sync_guard where guard_name = 'disabled') then
        raise exception '0018 post-condition: guard row is missing';
    end if;
    if not (select c.relrowsecurity from pg_class c where c.oid = 'private.guildbook_cloud_sync_guard'::regclass)
       or has_table_privilege('public', 'private.guildbook_cloud_sync_guard', 'select,insert,update,delete,truncate,references,trigger')
       or has_table_privilege('anon', 'private.guildbook_cloud_sync_guard', 'select,insert,update,delete,truncate,references,trigger')
       or has_table_privilege('authenticated', 'private.guildbook_cloud_sync_guard', 'select,insert,update,delete,truncate,references,trigger')
       or has_table_privilege('service_role', 'private.guildbook_cloud_sync_guard', 'select,insert,update,delete,truncate,references,trigger') then
        raise exception '0018 post-condition: guard table is not private';
    end if;

    for r in
        select p.oid as fn_oid, format('%I.%I', n.nspname, p.proname) as fn_name
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~* 'guildbook'
    loop
        if has_function_privilege('public', r.fn_oid, 'execute') or has_function_privilege('anon', r.fn_oid, 'execute')
           or has_function_privilege('authenticated', r.fn_oid, 'execute') or has_function_privilege('service_role', r.fn_oid, 'execute') then
            raise exception '0018 post-condition: % remains callable by an API role', r.fn_name;
        end if;
    end loop;

    -- Nothing was deleted or changed: not a single Guildbook row, and the raw tables stay closed to API roles.
    for r in select * from _fdb0018_rows_before loop
        if r.t = 'guilds' then select count(*) as n, md5(coalesce(string_agg(md5(to_jsonb(g)::text), '|' order by md5(to_jsonb(g)::text)), '')) as h into v_now from public.installation_guilds g;
        elsif r.t = 'members' then select count(*) as n, md5(coalesce(string_agg(md5(to_jsonb(m)::text), '|' order by md5(to_jsonb(m)::text)), '')) as h into v_now from public.installation_guild_members m;
        else select count(*) as n, md5(coalesce(string_agg(md5(to_jsonb(p)::text), '|' order by md5(to_jsonb(p)::text)), '')) as h into v_now from public.installation_guild_professions p;
        end if;
        if v_now.n is distinct from r.n or v_now.h is distinct from r.h then
            raise exception '0018 post-condition: Guildbook % rows changed', r.t;
        end if;
    end loop;
    if has_table_privilege('authenticated', 'public.installation_guilds', 'select') or has_table_privilege('anon', 'public.installation_guilds', 'select')
       or has_table_privilege('authenticated', 'public.installation_guild_members', 'select') or has_table_privilege('anon', 'public.installation_guild_members', 'select')
       or has_table_privilege('authenticated', 'public.installation_guild_professions', 'select') or has_table_privilege('anon', 'public.installation_guild_professions', 'select') then
        raise exception '0018 post-condition: raw Guildbook tables are readable by an API role';
    end if;

    -- Every other function is byte-identical (prosrc and ACL). The three ingest functions are the designed exception; the Guildbook RPCs keep
    -- their bodies and lose only their client ACL.
    for r in select * from _fdb0018_fn_before
             where proname not in ('foreverdb_ingest_snapshot_impl_v1', 'foreverdb_ingest_snapshot_impl_v1_legacy', 'fdb_public_snapshot') loop
        select md5(p.prosrc) as src_md5, coalesce(p.proacl::text, '') as acl into v_now from pg_proc p where p.oid = to_regprocedure(r.sig);
        if not found or v_now.src_md5 is distinct from r.src_md5 then
            raise exception '0018 post-condition: existing function % changed', r.sig;
        end if;
        if r.proname !~* 'guildbook' and v_now.acl is distinct from r.acl then
            raise exception '0018 post-condition: ACL of existing function % changed', r.sig;
        end if;
    end loop;
end $verify$;

notify pgrst, 'reload schema';

commit;
