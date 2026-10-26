-- ForeverDB 0012 ROLLBACK (safe, non-destructive to data).
--
-- Removes the account/claim API: drops the six account RPCs and the three private guards. It NEVER moves ownership and NEVER
-- deletes or modifies observations, locations, items, sources, sessions or Guildbook rows. installations.owner_user_id is the
-- source of truth for ownership and is not touched, so every already-transferred installation stays with its registered account.
--
-- The three private tables are dropped ONLY when ALL of them are empty. If any claim, transfer or audit row exists, they are RETAINED, so provenance (previous_owner_uid, needed for an audited restore), the claim history and the audit
-- trail survive the rollback. The restoration migration (0013, see LEDGER below) reconnects to them.
--
-- LEDGER: this script never reads, rewrites or deletes migration-ledger entries; the `account_ownership_claims` entry of 0012 STAYS.
-- After it completes, record the rollback with `psql -v name=rollback_account_ownership_claims -f database/ops/0012_record_migration_ledger.sql`
-- (or let your apply tool record it). Because the ledger keeps 0012, re-running 0012 is refused by its pre-flight BY DESIGN; the way back is the
-- forward restoration migration database/restore/0013_account_ownership_claims_restore.sql (docs/account-v1/0012-deployment-and-recovery.md 5.2).
-- This is NOT the kill switch (database/rollback/0012_kill_switch.sql), which drops nothing and is lifted with 0012_kill_switch_restore.sql.
-- Run as the migration role. Prefer the kill switch first.
-- ONE restoration cycle per ledger history: once `account_ownership_claims_restore` is recorded, a second full rollback would leave NO
-- ledger-consistent way back (0012 and 0013 are both refused by their pre-flights; only a NEW restoration migration with new ledger
-- names, cloned from 0013, could restore). Use the kill switch instead, or acknowledge explicitly:  -v acknowledge_second_cycle=yes
\if :{?acknowledge_second_cycle} \else \set acknowledge_second_cycle no \endif
begin;
set local lock_timeout = '10s';
select set_config('fdb.ack_second_cycle', :'acknowledge_second_cycle', true) \g /dev/null
do $guard$
begin
    if to_regclass('supabase_migrations.schema_migrations') is not null then
        if exists (select 1 from supabase_migrations.schema_migrations where name = 'account_ownership_claims_restore')
           and current_setting('fdb.ack_second_cycle') <> 'yes' then
            raise exception 'rollback refused: the restoration cycle was already used (ledger shows account_ownership_claims_restore); a second rollback has no ledger-consistent way back. Use the kill switch, or pass -v acknowledge_second_cycle=yes and plan a new restoration migration';
        end if;
        if not exists (select 1 from supabase_migrations.schema_migrations where name = 'account_ownership_claims') then
            raise notice 'WARNING: the ledger does not show account_ownership_claims (0012 recorded?); continuing because a rollback must stay available in an emergency';
        end if;
    end if;
end $guard$;

-- Stop clients immediately, before anything is dropped.
revoke all on function public.fdb_account_claim_start(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_claim_redeem(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_installation_link_status(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_installations() from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_guildbook_guilds(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_guildbook_members(text, text, integer, integer) from public, anon, authenticated, service_role;

create temporary table _fdb0012_rb_before on commit drop as
select (select count(*) from public.installations) as installations,
       (select count(*) from public.installations where owner_user_id is not null) as owned,
       (select md5(coalesce(string_agg(id || ':' || coalesce(owner_user_id::text, ''), ',' order by id), '')) from public.installations) as owners_md5,
       (select count(*) from public.installation_item_stats) as item_stats,
       (select count(*) from public.installation_source_stats) as source_stats,
       (select count(*) from public.installation_location_stats) as location_stats,
       (select count(*) from public.installation_guild_members) as members;

drop function if exists public.fdb_account_claim_start(text);
drop function if exists public.fdb_account_claim_redeem(text);
drop function if exists public.fdb_installation_link_status(text);
drop function if exists public.fdb_account_installations();
drop function if exists public.fdb_account_guildbook_guilds(text);
drop function if exists public.fdb_account_guildbook_members(text, text, integer, integer);
drop function if exists private.fdb_registered_caller();
drop function if exists private.fdb_anonymous_caller();
drop function if exists private.fdb_caller();

do $tables$
declare
    v_links bigint := 0;
    v_claims bigint := 0;
    v_audit bigint := 0;
begin
    if to_regclass('private.account_installations') is not null then
        select count(*) into v_links from private.account_installations;
    end if;
    if to_regclass('private.installation_claims') is not null then
        select count(*) into v_claims from private.installation_claims;
    end if;
    if to_regclass('private.account_audit') is not null then
        select count(*) into v_audit from private.account_audit;
    end if;
    if v_links = 0 and v_claims = 0 and v_audit = 0 then
        drop table if exists private.account_installations;
        drop table if exists private.installation_claims;
        drop table if exists private.account_audit;
        raise notice '0012 rollback: private tables were empty and have been dropped';
    else
        raise notice '0012 rollback: % link(s), % claim(s) and % audit row(s) exist: private tables RETAINED (ownership stays with the accounts)', v_links, v_claims, v_audit;
    end if;
end $tables$;

do $verify$
declare
    b record;
    a record;
begin
    select * into b from _fdb0012_rb_before;
    select (select count(*) from public.installations) as installations,
           (select count(*) from public.installations where owner_user_id is not null) as owned,
           (select md5(coalesce(string_agg(id || ':' || coalesce(owner_user_id::text, ''), ',' order by id), '')) from public.installations) as owners_md5,
           (select count(*) from public.installation_item_stats) as item_stats,
           (select count(*) from public.installation_source_stats) as source_stats,
           (select count(*) from public.installation_location_stats) as location_stats,
           (select count(*) from public.installation_guild_members) as members
    into a;
    if a is distinct from b then
        raise exception '0012 rollback post-condition failed: installation ownership or historical data changed';
    end if;
    if to_regprocedure('public.fdb_account_claim_start(text)') is not null or to_regprocedure('private.fdb_caller()') is not null then
        raise exception '0012 rollback post-condition failed: an account function still exists';
    end if;
    if not has_function_privilege('authenticated', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'execute') then
        raise exception '0012 rollback post-condition failed: ingest privilege lost';
    end if;
end $verify$;

notify pgrst, 'reload schema';
commit;
