-- Safe-to-apply immediately on production with old Companion binaries.
-- Neither helper is referenced by the existing public ForeverDB RPCs.
-- This is NOT the full read API revocation in migration 0009.
-- The currently supported public read/search/ingest endpoints stay intact.
do $close_private_unused$
declare
    v_references integer;
begin
    select count(*) into v_references
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public'
      and p.prokind = 'f'
      and (p.proname like 'get_foreverdb_%'
           or p.proname = 'ingest_foreverdb_snapshot_auth')
      and (
        lower(pg_get_functiondef(p.oid)) like
            '%private.foreverdb_all_stats(%'
        or lower(pg_get_functiondef(p.oid)) like
            '%private.ingest_foreverdb_snapshot_auth(%'
      );

    if v_references <> 0 then
        raise exception
            'Cannot revoke unused private RPC grants: public dependencies found';
    end if;

    if to_regprocedure('private.foreverdb_all_stats()') is null or
       to_regprocedure('private.ingest_foreverdb_snapshot_auth(jsonb)')
           is null then
        raise exception 'Expected legacy private helper is missing';
    end if;

    revoke execute on function private.foreverdb_all_stats()
      from public, anon, authenticated;
    revoke execute on function private.ingest_foreverdb_snapshot_auth(jsonb)
      from public, anon, authenticated;

    if has_function_privilege(
           'anon','private.foreverdb_all_stats()','execute')
        or has_function_privilege(
           'authenticated','private.foreverdb_all_stats()','execute')
        or has_function_privilege(
           'anon','private.ingest_foreverdb_snapshot_auth(jsonb)','execute')
        or has_function_privilege(
           'authenticated','private.ingest_foreverdb_snapshot_auth(jsonb)',
           'execute') then
        raise exception 'Legacy private RPC execution grant still available';
    end if;

    if not has_function_privilege(
           'anon','public.get_foreverdb_item_stats(bigint)','execute')
        or not has_function_privilege(
           'authenticated',
           'public.ingest_foreverdb_snapshot_auth(jsonb)','execute') then
        raise exception 'Unexpected loss of existing Companion API access';
    end if;
end $close_private_unused$;
