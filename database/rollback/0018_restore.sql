-- Explicit operator rollback for 0018 on a disposable/recovery database.
-- Restores only authenticated EXECUTE for account Guildbook RPCs that exist.
-- It never grants public/anon/service_role access, never restores the legacy
-- ingest projection, and never changes data.
begin;
do $restore$
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
        execute format('grant execute on function %s to authenticated', r.sig);
    end loop;
end $restore$;
notify pgrst, 'reload schema';
commit;
