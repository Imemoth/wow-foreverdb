-- ForeverDB 0018: Guildbook is Companion-local only.
--
-- Keep all existing Guildbook tables, rows and function definitions. This
-- migration only removes API-role EXECUTE privileges from the legacy and
-- account-scoped Guildbook RPCs so an old client cannot continue cloud sync.
-- The grants are restorable with database/rollback/0018_restore.sql.

begin;

do $preflight$
declare
    _sig text;
begin
    if to_regclass('supabase_migrations.schema_migrations') is not null
       and exists (select 1 from supabase_migrations.schema_migrations where name = 'disable_guildbook_cloud_sync') then
        raise exception '0018 pre-flight: ledger already shows disable_guildbook_cloud_sync';
    end if;
    foreach _sig in array array[
        'public.fdb_account_guildbook_guilds(text)',
        'public.fdb_account_guildbook_members(text,text,integer,integer)',
        'public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb)',
        'public.fdb_account_guildbook_guilds_scoped(text)',
        'public.fdb_account_guildbook_members_scoped(text,text,integer,integer)'
    ] loop
        if to_regprocedure(_sig) is null then
            raise exception '0018 pre-flight: required Guildbook RPC % is missing', _sig;
        end if;
    end loop;
end $preflight$;

revoke all on function public.fdb_account_guildbook_guilds(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_guildbook_members(text,text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_guildbook_guilds_scoped(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_guildbook_members_scoped(text,text,integer,integer) from public, anon, authenticated, service_role;

do $verify$
declare
    _sig text;
begin
    foreach _sig in array array[
        'public.fdb_account_guildbook_guilds(text)',
        'public.fdb_account_guildbook_members(text,text,integer,integer)',
        'public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb)',
        'public.fdb_account_guildbook_guilds_scoped(text)',
        'public.fdb_account_guildbook_members_scoped(text,text,integer,integer)'
    ] loop
        if has_function_privilege('public', _sig, 'execute')
           or has_function_privilege('anon', _sig, 'execute')
           or has_function_privilege('authenticated', _sig, 'execute')
           or has_function_privilege('service_role', _sig, 'execute') then
            raise exception '0018 post-condition: % remains callable by an API role', _sig;
        end if;
    end loop;
end $verify$;

notify pgrst, 'reload schema';
commit;
