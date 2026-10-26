-- Explicit operator rollback for 0018 on a disposable/recovery database.
-- Restores only authenticated EXECUTE for account Guildbook RPCs that exist.
-- It never grants public/anon/service_role access, never restores the legacy
-- ingest projection, and never changes data.
begin;
do $restore$
declare
    r record;
    v_local_only boolean := false;
begin
    if to_regclass('private.guildbook_cloud_sync_guard') is not null then
        execute 'select exists (select 1 from private.guildbook_cloud_sync_guard where guard_name = ''disabled'')'
            into v_local_only;
    end if;
    if v_local_only then
        raise exception '0018 rollback refused: Guildbook local-only kill switch is active';
    end if;

    for r in
        select p.oid::regprocedure::text as sig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname like 'fdb_account_guildbook_%'
    loop
        execute format('grant execute on function %s to authenticated', r.sig);
    end loop;
end $restore$;
notify pgrst, 'reload schema';
commit;
