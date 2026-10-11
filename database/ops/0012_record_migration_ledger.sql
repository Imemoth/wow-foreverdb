-- Records ONE Account System V1 step in the Supabase migration ledger when the step was applied with psql / the SQL editor
-- (Supabase `apply_migration` records by itself: do not run this as well).
--
--   psql -X -v ON_ERROR_STOP=1 -v name=<name> -f database/ops/0012_record_migration_ledger.sql
--
-- Allowed names, in the only valid order:
--   account_ownership_claims            after 0012 was applied
--   rollback_account_ownership_claims   after database/rollback/0012_rollback.sql completed (requires the entry above)
--   account_ownership_claims_restore    after database/restore/0013_account_ownership_claims_restore.sql (requires the entry above)
-- It only INSERTS. It refuses a duplicate name, an out-of-order step or a missing ledger, and never updates or deletes any ledger row.
\if :{?name} \else \echo 'missing -v name: refusing to run'
select 1 / 0 as missing_name;
\endif
begin;
select set_config('fdb.ledger_name', :'name', true) \g /dev/null
do $record$
declare
    v_name text := current_setting('fdb.ledger_name');
    v_at timestamp := date_trunc('second', clock_timestamp() at time zone 'utc');
    v_version text;
    v_max text;
    v_present integer;
begin
    perform pg_advisory_xact_lock(hashtextextended('fdb-account-ledger', 0));
    if v_name not in ('account_ownership_claims', 'rollback_account_ownership_claims', 'account_ownership_claims_restore') then
        raise exception 'ledger: unknown name %', v_name;
    end if;
    if to_regclass('supabase_migrations.schema_migrations') is null then
        raise exception 'ledger: supabase_migrations.schema_migrations does not exist';
    end if;
    if exists (select 1 from supabase_migrations.schema_migrations where name = v_name) then
        raise exception 'ledger: % is already recorded', v_name;
    end if;
    if v_name = 'rollback_account_ownership_claims'
       and not exists (select 1 from supabase_migrations.schema_migrations where name = 'account_ownership_claims') then
        raise exception 'ledger: account_ownership_claims must be recorded before its rollback';
    end if;
    if v_name = 'account_ownership_claims_restore'
       and not exists (select 1 from supabase_migrations.schema_migrations where name = 'rollback_account_ownership_claims') then
        raise exception 'ledger: rollback_account_ownership_claims must be recorded before the restore';
    end if;
    -- The ledger must describe the database: the nine account functions exist for `account_ownership_claims` and
    -- `account_ownership_claims_restore`, and none exists for `rollback_account_ownership_claims`.
    v_present := (select count(*) from pg_proc p where p.oid = any (array[
        to_regprocedure('public.fdb_account_claim_start(text)'), to_regprocedure('public.fdb_account_claim_redeem(text)'),
        to_regprocedure('public.fdb_installation_link_status(text)'), to_regprocedure('public.fdb_account_installations()'),
        to_regprocedure('public.fdb_account_guildbook_guilds(text)'), to_regprocedure('public.fdb_account_guildbook_members(text,text,integer,integer)'),
        to_regprocedure('private.fdb_caller()'), to_regprocedure('private.fdb_anonymous_caller()'), to_regprocedure('private.fdb_registered_caller()')]::oid[]));
    if v_name = 'rollback_account_ownership_claims' and v_present <> 0 then
        raise exception 'ledger: the rollback is not complete (% account function(s) still exist)', v_present;
    end if;
    if v_name <> 'rollback_account_ownership_claims' and v_present <> 9 then
        raise exception 'ledger: % requires all nine account functions to exist (found %)', v_name, v_present;
    end if;
    -- versions are second-resolution timestamps and must stay unique and increasing: never go below the newest existing version
    select max(version) into v_max from supabase_migrations.schema_migrations where version ~ '^[0-9]{14}$';
    if v_max is not null and v_max >= to_char(v_at, 'YYYYMMDDHH24MISS') then
        v_at := make_timestamp(substr(v_max, 1, 4)::int, substr(v_max, 5, 2)::int, substr(v_max, 7, 2)::int,
                               substr(v_max, 9, 2)::int, substr(v_max, 11, 2)::int, substr(v_max, 13, 2)::int) + interval '1 second';
    end if;
    v_version := to_char(v_at, 'YYYYMMDDHH24MISS');
    insert into supabase_migrations.schema_migrations (version, name, statements)
    values (v_version, v_name, array['recorded by database/ops/0012_record_migration_ledger.sql']);
end $record$;
commit;
