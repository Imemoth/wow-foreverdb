-- ForeverDB Guildbook local-only: RE-ASSERT the closed state of migration 0018. OPERATOR-RUN, idempotent, tightening only.
--
-- Use after anything that may have re-granted a Guildbook RPC: database/rollback/0012_kill_switch_restore.sql, database/restore/0013_*,
-- a hosted-project schema restore, or a later migration that creates a new Guildbook RPC. It only REVOKES; it never grants, never writes
-- a row and never touches the ledger. It refuses on a database where 0018 is not active and verifies the ingest projection is still the
-- one in front of the legacy body.
--
--   psql -X -v ON_ERROR_STOP=1 -f database/ops/guildbook_local_only_reassert.sql
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '10s';

do $reassert$
declare
    r record;
    v_src text;
    v_sig text;
    v_active boolean;
begin
    -- Two separate statements on purpose: PL/pgSQL plans a statement before running it, so a single expression that mentions the table
    -- fails with "relation does not exist" when the table is absent. A missing table must be a controlled refusal (fail-closed), not an error.
    v_active := false;
    if to_regclass('private.guildbook_cloud_sync_guard') is not null then
        select exists (select 1 from private.guildbook_cloud_sync_guard where guard_name = 'disabled') into v_active;
    end if;
    if not v_active then
        raise exception 'reassert refused: the Guildbook local-only kill switch (0018) is not active on this database';
    end if;

    select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)');
    if v_src is null or v_src not like '%fdb_public_snapshot%' or to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is null then
        raise exception 'reassert refused: the observation-only ingest projection is not in front of the legacy ingest body';
    end if;

    for r in
        select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~* 'guildbook'
    loop
        execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
    end loop;
    foreach v_sig in array array[
        'private.fdb_public_snapshot(jsonb)', 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)', 'private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)'
    ] loop
        execute format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);
    end loop;

    for r in
        select p.oid as fn_oid, format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~* 'guildbook'
    loop
        if has_function_privilege('public', r.fn_oid, 'execute') or has_function_privilege('anon', r.fn_oid, 'execute')
           or has_function_privilege('authenticated', r.fn_oid, 'execute') or has_function_privilege('service_role', r.fn_oid, 'execute') then
            raise exception 'reassert failed: % is still callable by an API role', r.sig;
        end if;
        raise notice 'closed: %', r.sig;
    end loop;
end $reassert$;

notify pgrst, 'reload schema';
commit;
