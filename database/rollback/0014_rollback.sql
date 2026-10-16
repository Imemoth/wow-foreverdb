-- ForeverDB 0014 ROLLBACK (safe, non-destructive to data).
--
-- Removes the enrollment/device API: drops the nine public RPCs and the six private helpers. It NEVER changes installation ownership and
-- NEVER deletes or modifies observations, locations, items, sources, sessions or Guildbook rows. Installations that were reserved or
-- bound through enrollment stay owned by their accounts (installations.owner_user_id is untouched).
--
-- The three private tables are dropped ONLY when ALL of them are empty; otherwise they are RETAINED (device registry, ticket history and
-- audit trail survive, and a later re-application of 0014 reconnects to them, because its CREATE TABLE statements are IF NOT EXISTS).
-- Active devices lose the ability to sync (their functions are gone) until 0014 is applied again; their installations and data are intact.
-- Prefer the kill switch (database/rollback/0014_kill_switch.sql) first. The migration ledger is never read or rewritten here.
begin;
set local lock_timeout = '10s';

revoke all on function public.fdb_account_enrollment_ticket_issue(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_enrollment_tickets() from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_enrollment_ticket_revoke(uuid) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_devices() from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_device_revoke(uuid) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_enroll(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_status(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_ingest(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_rotate_credential(text) from public, anon, authenticated, service_role;

create temporary table _fdb0014_rb_before on commit drop as
select (select count(*) from public.installations) as installations,
       (select md5(coalesce(string_agg(id || ':' || coalesce(owner_user_id::text, ''), ',' order by id), '')) from public.installations) as owners_md5,
       (select count(*) from public.installation_item_stats) as item_stats,
       (select count(*) from public.installation_source_stats) as source_stats,
       (select count(*) from public.installation_location_stats) as location_stats,
       (select count(*) from public.installation_guild_members) as members;

drop function if exists public.fdb_account_enrollment_ticket_issue(text);
drop function if exists public.fdb_account_enrollment_tickets();
drop function if exists public.fdb_account_enrollment_ticket_revoke(uuid);
drop function if exists public.fdb_account_devices();
drop function if exists public.fdb_account_device_revoke(uuid);
drop function if exists public.fdb_device_enroll(text, text, text);
drop function if exists public.fdb_device_status(text);
drop function if exists public.fdb_device_ingest(text, jsonb);
drop function if exists public.fdb_device_rotate_credential(text);
drop function if exists private.fdb_device_authorize(text, uuid);
drop function if exists private.fdb_device_match(text, private.devices);
drop function if exists private.fdb_device_id_from_secret(text);
drop function if exists private.fdb_account_usable(uuid);
drop function if exists private.fdb_lock_live_session(uuid, uuid, boolean);
drop function if exists private.fdb_prune_enrollment();

do $tables$
declare
    v_tickets bigint := 0;
    v_devices bigint := 0;
    v_audit bigint := 0;
begin
    if to_regclass('private.enrollment_tickets') is not null then select count(*) into v_tickets from private.enrollment_tickets; end if;
    if to_regclass('private.devices') is not null then select count(*) into v_devices from private.devices; end if;
    if to_regclass('private.device_audit') is not null then select count(*) into v_audit from private.device_audit; end if;
    if v_tickets = 0 and v_devices = 0 and v_audit = 0 then
        drop table if exists private.devices;
        drop table if exists private.enrollment_tickets;
        drop table if exists private.device_audit;
        raise notice '0014 rollback: private tables were empty and have been dropped';
    else
        raise notice '0014 rollback: % ticket(s), % device(s) and % audit row(s) exist: private tables RETAINED', v_tickets, v_devices, v_audit;
    end if;
end $tables$;

do $verify$
declare
    b record;
    a record;
begin
    select * into b from _fdb0014_rb_before;
    select (select count(*) from public.installations) as installations,
           (select md5(coalesce(string_agg(id || ':' || coalesce(owner_user_id::text, ''), ',' order by id), '')) from public.installations) as owners_md5,
           (select count(*) from public.installation_item_stats) as item_stats,
           (select count(*) from public.installation_source_stats) as source_stats,
           (select count(*) from public.installation_location_stats) as location_stats,
           (select count(*) from public.installation_guild_members) as members
    into a;
    if a is distinct from b then
        raise exception '0014 rollback post-condition failed: installation ownership or historical data changed';
    end if;
    if to_regprocedure('public.fdb_device_enroll(text,text,text)') is not null or to_regprocedure('private.fdb_device_authorize(text,uuid)') is not null then
        raise exception '0014 rollback post-condition failed: an enrollment function still exists';
    end if;
    if to_regprocedure('public.fdb_account_claim_redeem(text)') is null
       or not has_function_privilege('authenticated', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'execute') then
        raise exception '0014 rollback post-condition failed: 0012 account functions or the anonymous-path ingest were affected';
    end if;
end $verify$;

notify pgrst, 'reload schema';
commit;
