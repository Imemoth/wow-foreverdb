-- Append exactly one Browser Pairing V1 lifecycle entry. This script never updates or deletes ledger history.
-- psql -X -v ON_ERROR_STOP=1 -v name=<browser_pairing|rollback_browser_pairing|browser_pairing_restore> -f this-file.sql
\if :{?name} \else \echo 'missing -v name: refusing to run'
select 1 / 0 as missing_name;
\endif
begin;
set local lock_timeout = '10s';
select set_config('fdb.ledger_name', :'name', true) \g /dev/null
do $record$
declare
    v_name text := current_setting('fdb.ledger_name');
    v_at timestamp := date_trunc('second', clock_timestamp() at time zone 'utc');
    v_version text; v_max text; v_public integer; v_private integer;
    v_schema integer; v_complete boolean; v_absent boolean;
begin
    perform pg_advisory_xact_lock(hashtextextended('fdb-browser-pairing-ledger',0));
    if v_name not in ('browser_pairing','rollback_browser_pairing','browser_pairing_restore') then
        raise exception 'ledger: unknown browser-pairing name %',v_name;
    end if;
    if to_regclass('supabase_migrations.schema_migrations') is null then
        raise exception 'ledger: supabase_migrations.schema_migrations does not exist';
    end if;
    if exists(select 1 from supabase_migrations.schema_migrations where name=v_name) then
        raise exception 'ledger: % is already recorded',v_name;
    end if;
    if not exists(select 1 from supabase_migrations.schema_migrations where name='account_ownership_claims')
       or not exists(select 1 from supabase_migrations.schema_migrations where name='zero_touch_enrollment') then
        raise exception 'ledger: Account V1 0012 and 0014 entries must precede browser pairing';
    end if;
    if v_name in ('rollback_browser_pairing','browser_pairing_restore')
       and not exists(select 1 from supabase_migrations.schema_migrations where name='browser_pairing') then
        raise exception 'ledger: browser_pairing must be recorded first';
    end if;
    if v_name='browser_pairing_restore'
       and not exists(select 1 from supabase_migrations.schema_migrations where name='rollback_browser_pairing') then
        raise exception 'ledger: rollback_browser_pairing must be recorded before restore';
    end if;
    if v_name='rollback_browser_pairing'
       and exists(select 1 from supabase_migrations.schema_migrations where name='browser_pairing_restore') then
        raise exception 'ledger: the single restore cycle was already used';
    end if;

    select count(*) into v_public from pg_proc where oid=any(array[
      to_regprocedure('public.fdb_device_pair_start(uuid,text,uuid,text,text,text)'),to_regprocedure('public.fdb_device_pair_poll(uuid,text)'),
      to_regprocedure('public.fdb_device_pair_cancel(uuid,text)'),to_regprocedure('public.fdb_account_device_pair_preview(uuid)'),
      to_regprocedure('public.fdb_account_device_pair_approve(uuid)'),to_regprocedure('public.fdb_account_device_pair_deny(uuid)')]::oid[]);
    select count(*) into v_private from pg_proc where oid=any(array[
      to_regprocedure('private.fdb_pair_poll_global_budget()'),to_regprocedure('private.fdb_device_pair_native(uuid,text,boolean)'),
      to_regprocedure('private.device_pairing_revocation_trigger()')]::oid[]);
    select count(*) into v_schema from (values
      (to_regclass('private.device_pairing_config')),(to_regclass('private.device_pairings')),
      (to_regclass('private.device_pairing_audit')),(to_regclass('private.devices_one_per_pairing'))) s(oid) where oid is not null;
    v_complete := v_schema=4 and exists(select 1 from pg_attribute where attrelid='private.devices'::regclass and attname='pairing_id' and not attisdropped)
      and exists(select 1 from pg_constraint where conrelid='private.devices'::regclass and conname='devices_exactly_one_provenance' and convalidated)
      and exists(select 1 from pg_trigger where tgrelid='private.devices'::regclass and tgname='devices_propagate_pairing_revocation' and not tgisinternal);
    v_absent := v_schema=0 and not exists(select 1 from pg_attribute where attrelid='private.devices'::regclass and attname='pairing_id' and not attisdropped)
      and not exists(select 1 from pg_constraint where conrelid='private.devices'::regclass and conname='devices_exactly_one_provenance')
      and not exists(select 1 from pg_trigger where tgrelid='private.devices'::regclass and tgname='devices_propagate_pairing_revocation' and not tgisinternal);

    if v_name in ('browser_pairing','browser_pairing_restore') and not (v_public=6 and v_private=3 and v_complete) then
        raise exception 'ledger: % requires the complete 0016 schema and callable surface',v_name;
    end if;
    if v_name='rollback_browser_pairing' and not (v_public=0 and ((v_private=1 and v_complete) or (v_private=0 and v_absent))) then
        raise exception 'ledger: rollback state is incomplete or mixed';
    end if;
    if v_name<>'rollback_browser_pairing' then
        if not exists(select 1 from private.device_pairing_config where singleton and not enabled) then
            raise exception 'ledger: pairing must remain disabled while recording %',v_name;
        end if;
    elsif v_complete then
        if not exists(select 1 from private.device_pairing_config where singleton and not enabled) then
            raise exception 'ledger: retained rollback must keep pairing disabled';
        end if;
    end if;

    select max(version) into v_max from supabase_migrations.schema_migrations where version~'^[0-9]{14}$';
    if v_max is not null and v_max>=to_char(v_at,'YYYYMMDDHH24MISS') then
      v_at:=make_timestamp(substr(v_max,1,4)::int,substr(v_max,5,2)::int,substr(v_max,7,2)::int,
        substr(v_max,9,2)::int,substr(v_max,11,2)::int,substr(v_max,13,2)::int)+interval '1 second';
    end if;
    v_version:=to_char(v_at,'YYYYMMDDHH24MISS');
    insert into supabase_migrations.schema_migrations(version,name,statements)
    values(v_version,v_name,array['recorded by database/ops/0016_record_migration_ledger.sql']);
end $record$;
commit;
