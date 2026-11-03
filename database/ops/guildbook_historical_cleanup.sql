-- ForeverDB Guildbook HISTORICAL CLEANUP. OWNER-RUN psql script. NEVER RUN BY THE REPOSITORY, CI, AN AGENT OR A MIGRATION RUNNER.
--
-- Removes the cloud copy of Guildbook data that the Companion uploaded before the local-only policy (migration 0005 tables
-- public.installation_guilds / installation_guild_members / installation_guild_professions). It touches NOTHING else.
-- Procedure, preconditions and evidence: docs/guildbook-local-only/historical-guildbook-data.md and
-- docs/guildbook-local-only/server-deployment-runbook.md. Run database/ops/guildbook_historical_inventory.sql first.
--
-- DELETION IS IRREVERSIBLE EXCEPT FROM A BACKUP. The default mode deletes nothing. Execute mode refuses unless a confirmation text AND a
-- backup reference are given and the 0018 kill switch is active (otherwise old Companions would simply upload the data again).
--
--   DRY RUN (default; the whole transaction is READ ONLY and rolled back):
--     psql -X -v ON_ERROR_STOP=1 -v scope=all -f database/ops/guildbook_historical_cleanup.sql
--     psql -X -v ON_ERROR_STOP=1 -v scope=list -v installation_ids='id1,id2' -f database/ops/guildbook_historical_cleanup.sql
--   EXECUTE:
--     psql -X -v ON_ERROR_STOP=1 -v mode=execute -v scope=all \
--          -v confirm='DELETE-HISTORICAL-GUILDBOOK-DATA' \
--          -v backup_ref='<where the verified backup lives, no secrets>' -v operator='<your name>' \
--          [-v max_installations=200] [-v ack_account_scoped=1] -f database/ops/guildbook_historical_cleanup.sql
--
--   scope=all             every installation that has Guildbook rows (processed in batches, see max_installations)
--   scope=list            only the installations named in -v installation_ids (comma separated, at most 1000)
--   max_installations     bound per run (default 200, maximum 500). The run reports how many installations remain; re-run until 0.
--   ack_account_scoped=1  execute anyway although account-scoped Guildbook tables (a sibling branch's migration 0016, absent here) exist and
--                         are non-empty. Those tables are NOT touched by this script; see the documentation.
--
-- Safety properties
--   * ONE transaction with lock_timeout (5 s) and statement_timeout (120 s). Dry run is `begin read only` and ends with ROLLBACK, so the
--     database itself refuses a write; execute mode commits only after every verification below passed. Any failure aborts everything.
--   * Deletes only rows of the three Guildbook tables, children first (professions, members, guilds), per installation, while holding the
--     per-installation advisory lock that ingest, claims, device ingest and the 0018 wrapper use (pg_try_advisory_xact_lock: an installation
--     that is busy right now is SKIPPED and counted, never waited for, so this script cannot queue behind or ahead of user traffic).
--   * Verification inside the transaction: for every processed installation no Guildbook row remains, the deleted row counts equal the
--     counted ones, and the statistics rows, the installation row and the claim / device / link rows of that installation are unchanged.
--   * Output is COUNTS ONLY. No character, guild or realm name, no guid, and no installation id is ever printed: an installation is shown as
--     the first 8 hex characters of md5(id) and only for scope=list (at most 25 lines).
--   * Bounded and re-runnable: a second run finds nothing for already cleaned installations and reports zeros.
\set ON_ERROR_STOP on
\if :{?mode} \else \set mode dry_run \endif
\if :{?scope} \else \echo 'missing -v scope (all | list): refusing to run'
select 1 / 0 as missing_scope;
\endif
\if :{?installation_ids} \else \set installation_ids '' \endif
\if :{?max_installations} \else \set max_installations 200 \endif
\if :{?confirm} \else \set confirm '' \endif
\if :{?backup_ref} \else \set backup_ref '' \endif
\if :{?operator} \else \set operator '' \endif
\if :{?ack_account_scoped} \else \set ack_account_scoped 0 \endif

select (:'mode' = 'execute') as is_execute \gset
\if :is_execute
begin;
\else
begin read only;
\endif
set local lock_timeout = '5s';
set local statement_timeout = '120s';
select set_config('fdb.gc_mode', :'mode', true) as c1,
       set_config('fdb.gc_scope', :'scope', true) as c2,
       set_config('fdb.gc_ids', :'installation_ids', true) as c3,
       set_config('fdb.gc_max', :'max_installations', true) as c4,
       set_config('fdb.gc_confirm', :'confirm', true) as c5,
       set_config('fdb.gc_backup', :'backup_ref', true) as c6,
       set_config('fdb.gc_operator', :'operator', true) as c7,
       set_config('fdb.gc_ack', :'ack_account_scoped', true) as c8 \gset

do $cleanup$
declare
    v_mode text := current_setting('fdb.gc_mode');
    v_scope text := current_setting('fdb.gc_scope');
    v_ids_raw text := current_setting('fdb.gc_ids');
    v_max_raw text := current_setting('fdb.gc_max');
    v_confirm text := current_setting('fdb.gc_confirm');
    v_backup text := current_setting('fdb.gc_backup');
    v_operator text := current_setting('fdb.gc_operator');
    v_ack boolean := current_setting('fdb.gc_ack') in ('1', 'true', 'yes');
    v_max integer;
    v_ids text[] := '{}';
    v_targets text[] := '{}';
    v_processed text[] := '{}';
    v_id text;
    v_t text;
    v_c bigint;
    v_flag boolean;
    v_acct bigint := 0;
    v_in_scope bigint;
    v_n_inst bigint;
    v_n_guilds bigint;
    v_n_members bigint;
    v_n_profs bigint;
    v_anon bigint;
    v_registered bigint;
    v_ownerless bigint;
    v_linked bigint;
    v_lines integer := 0;
    v_g bigint; v_m bigint; v_p bigint;
    v_skipped bigint := 0;
    v_done bigint := 0;
    v_del_g bigint := 0; v_del_m bigint := 0; v_del_p bigint := 0;
    v_chk_before bigint;
    v_chk_after bigint;
    v_remaining bigint;
    r record;
begin
    -- ------------------------------------------------------------------------------------------------------------------
    -- Validation. Messages never echo a supplied value.
    -- ------------------------------------------------------------------------------------------------------------------
    if v_mode not in ('dry_run', 'execute') then
        raise exception 'refused: mode must be dry_run or execute';
    end if;
    if v_scope not in ('all', 'list') then
        raise exception 'refused: scope must be all or list';
    end if;
    if v_max_raw !~ '^[0-9]{1,4}$' then
        raise exception 'refused: max_installations must be an integer between 1 and 500';
    end if;
    v_max := v_max_raw::integer;
    if v_max not between 1 and 500 then
        raise exception 'refused: max_installations must be an integer between 1 and 500';
    end if;
    if v_scope = 'list' then
        v_ids := array(select btrim(x) from unnest(string_to_array(v_ids_raw, ',')) x where btrim(x) <> '');
        if cardinality(v_ids) = 0 or cardinality(v_ids) > 1000 then
            raise exception 'refused: scope=list needs between 1 and 1000 installation ids';
        end if;
        if exists (select 1 from unnest(v_ids) x where x !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') then
            raise exception 'refused: malformed installation id in the list';
        end if;
    elsif btrim(v_ids_raw) <> '' then
        raise exception 'refused: installation_ids is only valid with scope=list';
    end if;

    if v_mode = 'execute' then
        if v_confirm is distinct from 'DELETE-HISTORICAL-GUILDBOOK-DATA' then
            raise exception 'refused: execute mode needs the exact confirmation text (-v confirm)';
        end if;
        if length(v_backup) not between 8 and 200 then
            raise exception 'refused: execute mode needs a recorded backup reference (-v backup_ref, 8 to 200 characters)';
        end if;
        if length(v_operator) not between 2 and 80 then
            raise exception 'refused: execute mode needs -v operator (2 to 80 characters)';
        end if;
        v_flag := false;
        if to_regclass('private.guildbook_cloud_sync_guard') is not null then
            select exists (select 1 from private.guildbook_cloud_sync_guard where guard_name = 'disabled') into v_flag;
        end if;
        if not v_flag then
            raise exception 'refused: the Guildbook local-only kill switch (migration 0018) is not active; old clients would upload the data again';
        end if;
    end if;

    if to_regclass('public.installation_guilds') is null or to_regclass('public.installation_guild_members') is null
       or to_regclass('public.installation_guild_professions') is null or to_regclass('public.installations') is null then
        raise exception 'refused: the Guildbook tables are missing';
    end if;
    if to_regclass('private.account_installations') is null then
        raise exception 'refused: migration 0012 is not applied (private.account_installations is missing)';
    end if;

    -- Optional sibling-branch structures: reported, never touched.
    foreach v_t in array array['private.account_guildbook_captures', 'private.account_guildbook_guilds',
                               'private.account_guildbook_members', 'private.account_guildbook_professions'] loop
        if to_regclass(v_t) is not null then
            execute format('select count(*) from %s', v_t) into v_c;
            v_acct := v_acct + v_c;
        end if;
    end loop;
    raise notice 'GUILDBOOK-CLEANUP account_scoped_guildbook_rows_outside_this_script=%', v_acct;
    if v_mode = 'execute' and v_acct > 0 and not v_ack then
        raise exception 'refused: non-empty account-scoped Guildbook tables exist and are not covered by this script (see -v ack_account_scoped)';
    end if;

    -- ------------------------------------------------------------------------------------------------------------------
    -- Scope and counts (these are the numbers a dry run reports and execute mode re-verifies).
    -- ------------------------------------------------------------------------------------------------------------------
    select count(distinct g.installation_id) into v_in_scope
    from public.installation_guilds g where v_scope = 'all' or g.installation_id = any(v_ids);

    select coalesce(array_agg(t.installation_id order by t.installation_id), '{}') into v_targets
    from (select distinct g.installation_id from public.installation_guilds g
          where v_scope = 'all' or g.installation_id = any(v_ids)
          order by g.installation_id limit v_max) t;

    v_n_inst := cardinality(v_targets);
    select count(*) into v_n_guilds from public.installation_guilds where installation_id = any(v_targets);
    select count(*) into v_n_members from public.installation_guild_members where installation_id = any(v_targets);
    select count(*) into v_n_profs from public.installation_guild_professions where installation_id = any(v_targets);

    select count(*) filter (where i.owner_user_id is null),
           count(*) filter (where u.id is not null and u.is_anonymous),
           count(*) filter (where u.id is not null and not u.is_anonymous),
           count(*) filter (where to_regclass('private.account_installations') is not null
                              and exists (select 1 from private.account_installations l where l.installation_id = i.id))
    into v_ownerless, v_anon, v_registered, v_linked
    from public.installations i left join auth.users u on u.id = i.owner_user_id
    where i.id = any(v_targets);

    raise notice 'GUILDBOOK-CLEANUP mode=% scope=% installations_in_scope=% batch_installations=% batch_max=%', v_mode, v_scope, v_in_scope, v_n_inst, v_max;
    raise notice 'GUILDBOOK-CLEANUP would_delete guild_rows=% member_rows=% profession_rows=%', v_n_guilds, v_n_members, v_n_profs;
    raise notice 'GUILDBOOK-CLEANUP batch_owner_classes anonymous=% registered=% ownerless=% account_linked=%', v_anon, v_registered, v_ownerless, v_linked;
    raise notice 'GUILDBOOK-CLEANUP deferred_to_next_run_installations=%', greatest(v_in_scope - v_n_inst, 0);

    if v_scope = 'list' then
        for r in select left(md5(u.id), 8) as label, u.id as inst from unnest(v_targets) as u(id) order by 1 loop
            exit when v_lines >= 25;
            select count(*) into v_g from public.installation_guilds where installation_id = r.inst;
            select count(*) into v_m from public.installation_guild_members where installation_id = r.inst;
            select count(*) into v_p from public.installation_guild_professions where installation_id = r.inst;
            raise notice 'GUILDBOOK-CLEANUP installation#% guild_rows=% member_rows=% profession_rows=%', r.label, v_g, v_m, v_p;
            v_lines := v_lines + 1;
        end loop;
    end if;

    if v_mode = 'dry_run' then
        raise notice 'GUILDBOOK-CLEANUP dry_run: nothing was deleted (read-only transaction, rolled back)';
        return;
    end if;

    -- ------------------------------------------------------------------------------------------------------------------
    -- Execute: per installation, under its advisory lock, children first.
    -- ------------------------------------------------------------------------------------------------------------------
    raise notice 'GUILDBOOK-CLEANUP execute operator=% backup_ref=%', v_operator, v_backup;
    foreach v_id in array v_targets loop
        if not pg_try_advisory_xact_lock(hashtextextended(v_id, 0)) then
            v_skipped := v_skipped + 1;
            continue;
        end if;

        -- Everything that must NOT change for this installation, counted under the lock.
        select (select count(*) from public.installation_source_stats where installation_id = v_id)
             + (select count(*) from public.installation_item_stats where installation_id = v_id)
             + (select count(*) from public.installation_location_stats where installation_id = v_id)
             + (select count(*) from public.installations where id = v_id)
        into v_chk_before;
        foreach v_t in array array['private.installation_claims', 'private.account_installations', 'private.devices'] loop
            if to_regclass(v_t) is not null then
                execute format('select count(*) from %s where installation_id = $1', v_t) into v_c using v_id;
                v_chk_before := v_chk_before + v_c;
            end if;
        end loop;

        select count(*) into v_g from public.installation_guilds where installation_id = v_id;
        select count(*) into v_m from public.installation_guild_members where installation_id = v_id;
        select count(*) into v_p from public.installation_guild_professions where installation_id = v_id;

        delete from public.installation_guild_professions where installation_id = v_id;
        get diagnostics v_c = row_count;
        if v_c <> v_p then raise exception 'verification failed: profession rows deleted differ from counted rows'; end if;
        v_del_p := v_del_p + v_c;
        delete from public.installation_guild_members where installation_id = v_id;
        get diagnostics v_c = row_count;
        if v_c <> v_m then raise exception 'verification failed: member rows deleted differ from counted rows'; end if;
        v_del_m := v_del_m + v_c;
        delete from public.installation_guilds where installation_id = v_id;
        get diagnostics v_c = row_count;
        if v_c <> v_g then raise exception 'verification failed: guild rows deleted differ from counted rows'; end if;
        v_del_g := v_del_g + v_c;

        select (select count(*) from public.installation_source_stats where installation_id = v_id)
             + (select count(*) from public.installation_item_stats where installation_id = v_id)
             + (select count(*) from public.installation_location_stats where installation_id = v_id)
             + (select count(*) from public.installations where id = v_id)
        into v_chk_after;
        foreach v_t in array array['private.installation_claims', 'private.account_installations', 'private.devices'] loop
            if to_regclass(v_t) is not null then
                execute format('select count(*) from %s where installation_id = $1', v_t) into v_c using v_id;
                v_chk_after := v_chk_after + v_c;
            end if;
        end loop;
        if v_chk_after <> v_chk_before then
            raise exception 'verification failed: a non-Guildbook row of a processed installation changed';
        end if;

        v_processed := array_append(v_processed, v_id);
        v_done := v_done + 1;
    end loop;

    -- Post-verification over everything processed.
    if exists (select 1 from public.installation_guilds where installation_id = any(v_processed))
       or exists (select 1 from public.installation_guild_members where installation_id = any(v_processed))
       or exists (select 1 from public.installation_guild_professions where installation_id = any(v_processed)) then
        raise exception 'verification failed: Guildbook rows remain for a processed installation';
    end if;

    select count(distinct g.installation_id) into v_remaining
    from public.installation_guilds g where v_scope = 'all' or g.installation_id = any(v_ids);

    raise notice 'GUILDBOOK-CLEANUP result installations_processed=% skipped_busy=% deleted_guild_rows=% deleted_member_rows=% deleted_profession_rows=%',
        v_done, v_skipped, v_del_g, v_del_m, v_del_p;
    raise notice 'GUILDBOOK-CLEANUP remaining_installations_with_guild_rows_in_scope=% (re-run until 0)', v_remaining;
    raise notice 'GUILDBOOK-CLEANUP deletion is irreversible except from the backup referenced above';
end $cleanup$;

-- Verification query: counts only.
select (select count(*) from public.installation_guilds) as guild_rows_total,
       (select count(*) from public.installation_guild_members) as member_rows_total,
       (select count(*) from public.installation_guild_professions) as profession_rows_total,
       (select count(*) from public.installations) as installations_total;

\if :is_execute
commit;
\echo 'GUILDBOOK-CLEANUP committed'
\else
rollback;
\echo 'GUILDBOOK-CLEANUP dry run finished: rolled back'
\endif
