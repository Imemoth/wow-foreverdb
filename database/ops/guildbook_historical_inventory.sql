-- ForeverDB Guildbook HISTORICAL INVENTORY. READ-ONLY, COUNTS AND AGGREGATES ONLY. Safe to run before and after migration 0018.
--
-- Answers: how much Guildbook data does the private project hold in the cloud, since when, for whom (class of owner), and is any other
-- structure holding or exposing it? It never prints a character, guild or realm name, a guid, an installation id, an e-mail address or a
-- user id. Every statement runs in a READ ONLY transaction (the database refuses a write). Use the output as the "before" record for
-- database/ops/guildbook_historical_cleanup.sql (docs/guildbook-local-only/historical-guildbook-data.md).
--
--   psql -X -v ON_ERROR_STOP=1 -f database/ops/guildbook_historical_inventory.sql > inventory-<date>.txt
--
-- Run it on the PRODUCTION project only with explicit owner authorisation; run it on staging freely. Keep the output private.
\set ON_ERROR_STOP on
begin read only;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $inventory$
declare
    v_n bigint;
    v_avg numeric;
    v_a bigint; v_b bigint; v_c bigint; v_d bigint;
    v_t text;
    v_ts timestamptz; v_ts2 timestamptz;
    v_x text;
    r record;
begin
    -- 1. Which migrations / objects are present --------------------------------------------------------------------------
    if to_regclass('supabase_migrations.schema_migrations') is not null then
        for r in execute $q$select name from supabase_migrations.schema_migrations
                            where name in ('fix_observed_drop_rate_denominator', 'account_ownership_claims', 'zero_touch_enrollment',
                                           'azerdex_welcome_outbox', 'account_scoped_guildbook', 'account_independent_collectors',
                                           'disable_guildbook_cloud_sync')
                            order by 1$q$ loop
            raise notice 'INVENTORY ledger_entry %', r.name;
        end loop;
    else
        raise notice 'INVENTORY ledger_table absent';
    end if;
    raise notice 'INVENTORY legacy_ingest_body_present %', to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)') is not null;
    raise notice 'INVENTORY legacy_ingest_renamed_present %', to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is not null;
    select (p.prosrc like '%fdb_public_snapshot%') into v_x from pg_proc p where p.oid = to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)');
    raise notice 'INVENTORY ingest_has_observation_only_projection %', coalesce(v_x, 'n/a');
    raise notice 'INVENTORY kill_switch_guard_table_present %', to_regclass('private.guildbook_cloud_sync_guard') is not null;
    if to_regclass('private.guildbook_cloud_sync_guard') is not null then
        execute 'select count(*) from private.guildbook_cloud_sync_guard' into v_n;
        raise notice 'INVENTORY kill_switch_guard_rows %', v_n;
    end if;
    for r in
        select format('%s.%s(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as sig,
               has_function_privilege('public', p.oid, 'execute') as pub,
               has_function_privilege('anon', p.oid, 'execute') as anon_x,
               has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
               has_function_privilege('service_role', p.oid, 'execute') as svc_x
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname ~* 'guildbook' order by 1
    loop
        raise notice 'INVENTORY guildbook_rpc % public=% anon=% authenticated=% service_role=%', r.sig, r.pub, r.anon_x, r.auth_x, r.svc_x;
    end loop;

    -- 2. Row counts, size, bloat --------------------------------------------------------------------------------------------
    select count(*) into v_a from public.installation_guilds;
    select count(*) into v_b from public.installation_guild_members;
    select count(*) into v_c from public.installation_guild_professions;
    select count(distinct installation_id) into v_d from public.installation_guilds;
    select count(*) into v_n from public.installations;
    raise notice 'INVENTORY installations_total % installations_with_guild_rows %', v_n, v_d;
    raise notice 'INVENTORY guild_rows % member_rows % profession_rows %', v_a, v_b, v_c;
    for r in
        select c.relname, pg_total_relation_size(c.oid) as bytes, coalesce(s.n_live_tup, 0) as live, coalesce(s.n_dead_tup, 0) as dead
        from pg_class c left join pg_stat_user_tables s on s.relid = c.oid
        where c.oid in ('public.installation_guilds'::regclass, 'public.installation_guild_members'::regclass, 'public.installation_guild_professions'::regclass)
        order by 1
    loop
        raise notice 'INVENTORY table % total_bytes=% est_live=% est_dead=% (dead tuples remain on disk until vacuum)', r.relname, r.bytes, r.live, r.dead;
    end loop;

    select coalesce(min(k), 0), coalesce(round(avg(k), 1), 0), coalesce(max(k), 0) into v_a, v_avg, v_c
    from (select count(*) as k from public.installation_guilds group by installation_id) x;
    raise notice 'INVENTORY guilds_per_installation min=% avg=% max=%', v_a, v_avg, v_c;
    select coalesce(max(k), 0) into v_a from (select count(*) as k from public.installation_guild_members group by installation_id) x;
    raise notice 'INVENTORY members_per_installation max=%', v_a;

    -- 3. Date range -------------------------------------------------------------------------------------------------------
    select min(updated_at), max(updated_at) into v_ts, v_ts2 from public.installation_guilds;
    raise notice 'INVENTORY guild_updated_at min=% max=%', v_ts, v_ts2;
    select min(updated_at), max(updated_at) into v_ts, v_ts2 from public.installation_guild_members;
    raise notice 'INVENTORY member_updated_at min=% max=%', v_ts, v_ts2;
    select min(captured_at), max(captured_at) into v_a, v_b from public.installation_guilds;
    raise notice 'INVENTORY guild_captured_at_raw min=% max=% (addon clock value, unit as exported)', v_a, v_b;
    select min(i.first_seen_at), max(i.last_seen_at) into v_ts, v_ts2
    from public.installations i where exists (select 1 from public.installation_guilds g where g.installation_id = i.id);
    raise notice 'INVENTORY installations_with_guild_rows first_seen_min=% last_seen_max=%', v_ts, v_ts2;

    -- 4. Is anything still uploading? (fresh rows after the Companion/RPC change mean an old client is active) --------------------
    select count(distinct installation_id) filter (where updated_at > now() - interval '1 day'),
           count(distinct installation_id) filter (where updated_at > now() - interval '7 days'),
           count(distinct installation_id) filter (where updated_at > now() - interval '30 days')
    into v_a, v_b, v_c from public.installation_guilds;
    raise notice 'INVENTORY installations_with_guild_rows_updated last_24h=% last_7d=% last_30d=%', v_a, v_b, v_c;
    for r in
        select coalesce(i.addon_version, '(none)') as addon_version, i.schema_version, count(*) as n
        from public.installations i
        where exists (select 1 from public.installation_guilds g where g.installation_id = i.id and g.updated_at > now() - interval '30 days')
        group by 1, 2 order by n desc limit 20
    loop
        raise notice 'INVENTORY recent_guild_uploaders addon_version=% schema_version=% installations=%', r.addon_version, r.schema_version, r.n;
    end loop;

    -- 5. Whose data (class of owner only) ---------------------------------------------------------------------------------------
    select count(*) filter (where i.owner_user_id is null),
           count(*) filter (where u.id is not null and u.is_anonymous),
           count(*) filter (where u.id is not null and not u.is_anonymous),
           count(*) filter (where i.owner_user_id is not null and u.id is null)
    into v_a, v_b, v_c, v_d
    from public.installations i left join auth.users u on u.id = i.owner_user_id
    where exists (select 1 from public.installation_guilds g where g.installation_id = i.id);
    raise notice 'INVENTORY guild_installations_by_owner ownerless=% anonymous=% registered=% owner_user_missing=%', v_a, v_b, v_c, v_d;
    if to_regclass('private.account_installations') is not null then
        execute $q$select count(*) from public.installations i
                   where exists (select 1 from public.installation_guilds g where g.installation_id = i.id)
                     and exists (select 1 from private.account_installations l where l.installation_id = i.id)$q$ into v_n;
        raise notice 'INVENTORY guild_installations_account_linked %', v_n;
    end if;
    if to_regclass('private.devices') is not null then
        execute $q$select count(*) from public.installations i
                   where exists (select 1 from public.installation_guilds g where g.installation_id = i.id)
                     and exists (select 1 from private.devices d where d.installation_id = i.id and d.status <> 'revoked')$q$ into v_n;
        raise notice 'INVENTORY guild_installations_with_live_device %', v_n;
    end if;

    -- 6. Other structures that could hold or expose Guildbook data -----------------------------------------------------------------
    select count(*) into v_n from pg_depend d
        join pg_rewrite rw on d.classid = 'pg_rewrite'::regclass and rw.oid = d.objid join pg_class vc on vc.oid = rw.ev_class and vc.relkind in ('v', 'm')
        where d.refobjid in ('public.installation_guilds'::regclass, 'public.installation_guild_members'::regclass, 'public.installation_guild_professions'::regclass);
    raise notice 'INVENTORY views_or_matviews_depending_on_guild_tables %', v_n;
    select count(*) into v_n from pg_trigger t
        where t.tgrelid in ('public.installation_guilds'::regclass, 'public.installation_guild_members'::regclass, 'public.installation_guild_professions'::regclass) and not t.tgisinternal;
    raise notice 'INVENTORY user_triggers_on_guild_tables %', v_n;
    select count(*) into v_n from pg_publication_tables where schemaname = 'public'
        and tablename in ('installation_guilds', 'installation_guild_members', 'installation_guild_professions');
    raise notice 'INVENTORY publication_memberships_of_guild_tables % (realtime / logical replication would replicate them)', v_n;
    select count(*) into v_n from pg_policies where schemaname = 'public' and tablename in ('installation_guilds', 'installation_guild_members', 'installation_guild_professions');
    raise notice 'INVENTORY policies_on_guild_tables %', v_n;
    for r in
        select c.relname, has_table_privilege('anon', c.oid, 'select,insert,update,delete') as anon_x,
               has_table_privilege('authenticated', c.oid, 'select,insert,update,delete') as auth_x,
               has_table_privilege('service_role', c.oid, 'select,insert,update,delete') as svc_x, c.relrowsecurity as rls
        from pg_class c where c.oid in ('public.installation_guilds'::regclass, 'public.installation_guild_members'::regclass, 'public.installation_guild_professions'::regclass) order by 1
    loop
        raise notice 'INVENTORY table_access % anon=% authenticated=% service_role=% rls=%', r.relname, r.anon_x, r.auth_x, r.svc_x, r.rls;
    end loop;
    for r in
        select distinct p.proname, n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname in ('public', 'private') and p.prosrc ~* 'installation_guild' order by 2, 1
    loop
        raise notice 'INVENTORY function_referencing_guild_tables %.%', r.nspname, r.proname;
    end loop;
    if to_regclass('public.map_asset_diagnostics') is not null then
        execute $q$select count(*) from public.map_asset_diagnostics where details::text ~* 'guild'$q$ into v_n;
        raise notice 'INVENTORY map_asset_diagnostics_rows_whose_details_mention_guild %', v_n;
    else
        raise notice 'INVENTORY map_asset_diagnostics absent';
    end if;
    v_a := 0;
    foreach v_t in array array['private.account_guildbook_captures', 'private.account_guildbook_guilds',
                               'private.account_guildbook_members', 'private.account_guildbook_professions'] loop
        if to_regclass(v_t) is not null then
            execute format('select count(*) from %s', v_t) into v_n;
            raise notice 'INVENTORY account_scoped_table % rows=%', v_t, v_n;
            v_a := v_a + v_n;
        end if;
    end loop;
    raise notice 'INVENTORY account_scoped_guildbook_rows_total % (sibling branch structures; not covered by the cleanup script)', v_a;
    raise notice 'INVENTORY not_visible_from_sql backups_and_PITR, provider_logs, pg_stat_statements_text, local_exports (see historical-guildbook-data.md)';
end $inventory$;

rollback;
