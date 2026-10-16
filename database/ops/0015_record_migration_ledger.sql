-- Records ONE AzerDex welcome-outbox step in the Supabase migration ledger when it was applied with psql / the SQL editor
-- (Supabase `apply_migration` / `supabase db push` record by themselves: do not run this as well).
--
--   psql -X -v ON_ERROR_STOP=1 -v name=<name> -f database/ops/0015_record_migration_ledger.sql
--
-- Allowed names, in the only valid order:
--   azerdex_welcome_outbox            after database/migrations/0015_azerdex_welcome_outbox.sql was applied
--   rollback_azerdex_welcome_outbox   after database/rollback/0015_rollback.sql completed (requires the entry above)
-- Mirrors database/ops/0012_record_migration_ledger.sql: it only INSERTS, refuses a duplicate name, an out-of-order step or a missing ledger,
-- never updates or deletes a ledger row, and checks that the ledger describes the database (twelve functions exist / none exists).
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
    perform pg_advisory_xact_lock(hashtextextended('fdb-azerdex-welcome-ledger', 0));
    if v_name not in ('azerdex_welcome_outbox', 'rollback_azerdex_welcome_outbox') then
        raise exception 'ledger: unknown name %', v_name;
    end if;
    if to_regclass('supabase_migrations.schema_migrations') is null then
        raise exception 'ledger: supabase_migrations.schema_migrations does not exist';
    end if;
    if exists (select 1 from supabase_migrations.schema_migrations where name = v_name) then
        raise exception 'ledger: % is already recorded', v_name;
    end if;
    if v_name = 'rollback_azerdex_welcome_outbox'
       and not exists (select 1 from supabase_migrations.schema_migrations where name = 'azerdex_welcome_outbox') then
        raise exception 'ledger: azerdex_welcome_outbox must be recorded before its rollback';
    end if;
    v_present := (select count(*) from pg_proc p
                   where p.proname like 'azerdex\_welcome\_%' and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace));
    if v_name = 'rollback_azerdex_welcome_outbox' and v_present <> 0 then
        raise exception 'ledger: the rollback is not complete (% welcome function(s) still exist)', v_present;
    end if;
    if v_name = 'azerdex_welcome_outbox' and v_present <> 12 then
        raise exception 'ledger: azerdex_welcome_outbox requires all twelve welcome functions to exist (found %)', v_present;
    end if;
    -- versions are second-resolution timestamps and must stay unique and increasing
    select max(version) into v_max from supabase_migrations.schema_migrations where version ~ '^[0-9]{14}$';
    if v_max is not null and v_max >= to_char(v_at, 'YYYYMMDDHH24MISS') then
        v_at := make_timestamp(substr(v_max, 1, 4)::int, substr(v_max, 5, 2)::int, substr(v_max, 7, 2)::int,
                               substr(v_max, 9, 2)::int, substr(v_max, 11, 2)::int, substr(v_max, 13, 2)::int) + interval '1 second';
    end if;
    v_version := to_char(v_at, 'YYYYMMDDHH24MISS');
    insert into supabase_migrations.schema_migrations (version, name, statements)
    values (v_version, v_name, array['recorded by database/ops/0015_record_migration_ledger.sql']);
end $record$;
commit;
