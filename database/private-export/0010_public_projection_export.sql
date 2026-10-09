-- ForeverDB: allowlisted aggregate export for the public website projection.
--
-- STATUS: PREPARED, **NOT APPLIED TO PRODUCTION**. Applying this file to the
-- sole production Supabase database requires explicit owner approval, the
-- same single-transaction cutover discipline as 0009, and the go-live
-- checklist in docs/web/go-live-checklist.md.
--
-- Purpose
--   The public website must never read the private production database.
--   A separate publication worker reads ONLY the functions below, through a
--   dedicated least-privilege role, then validates/sanitizes the rows and
--   writes them to a physically separate public read database.
--
-- Guarantees enforced here
--   * Output columns are aggregates only. No installation_id, owner_user_id,
--     guild, member, profession, diagnostics, budget or auth data is returned.
--   * `installations` is the number of distinct anonymous installations that
--     contributed to an aggregate. It is a THRESHOLD INPUT for the worker and
--     is not published. It is not proof of distinct people (one person may
--     own several installations; several people may share one).
--   * `max_installation_share` lets the worker flag aggregates dominated by a
--     single installation (possible poisoning or single-player bias).
--   * The reader role has no table privileges and no access to `public`,
--     `private` or `auth`; it can only EXECUTE these functions, read-only.
--   * Not exposed through PostgREST: schema is not in the Data API exposed
--     schemas and anon/authenticated have no USAGE.
--   * This export does NOT consume or touch the Companion API budgets.
--
-- Denominator note
--   Observed drop rate denominator = ALL bucket observations across every
--   contributing installation. (The legacy private.foreverdb_item_stats /
--   foreverdb_source_stats only sum observations of installations that saw
--   the item at least once; see docs/web/00-current-state-assessment.md F-3.)

begin;

create schema if not exists publication_export;
revoke all on schema publication_export from public;

do $roles$
begin
    if not exists (select 1 from pg_roles where rolname = 'foreverdb_projection_reader') then
        -- NOLOGIN here. An operator enables login out-of-band:
        --   alter role foreverdb_projection_reader login password '<generated>';
        -- The password is stored only in the publication worker's secret store.
        create role foreverdb_projection_reader
            nologin noinherit nocreatedb nocreaterole noreplication nobypassrls;
    end if;
    if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke all on schema publication_export from anon';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'revoke all on schema publication_export from authenticated';
    end if;
end
$roles$;

alter role foreverdb_projection_reader set default_transaction_read_only = on;
alter role foreverdb_projection_reader set statement_timeout = '60s';
alter role foreverdb_projection_reader set idle_in_transaction_session_timeout = '30s';
alter role foreverdb_projection_reader connection limit 2;

grant usage on schema publication_export to foreverdb_projection_reader;

-- Freshness only: latest server-side update time of aggregate statistics.
create or replace function publication_export.export_meta_v1()
returns table (contract_version integer, exported_at timestamptz, data_updated_at timestamptz)
language sql stable security definer set search_path = ''
as $$
    select
        1,
        now(),
        greatest(
            (select max(updated_at) from public.installation_source_stats),
            (select max(updated_at) from public.installation_item_stats),
            (select max(updated_at) from public.installation_location_stats)
        );
$$;

create or replace function publication_export.export_sources_v1()
returns table (
    source_type text, source_id bigint, source_level integer,
    name text, first_seen_at timestamptz, last_seen_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
    select s.source_type, s.source_id, s.source_level, s.name,
           s.first_seen_at, s.last_seen_at
    from public.sources s
    where exists (
        select 1 from public.installation_source_stats ss
        where ss.source_type = s.source_type
          and ss.source_id = s.source_id
          and ss.source_level = s.source_level
          and ss.observations > 0
    );
$$;

create or replace function publication_export.export_items_v1()
returns table (item_id bigint, name text, first_seen_at timestamptz, last_seen_at timestamptz)
language sql stable security definer set search_path = ''
as $$
    select i.item_id, i.name, i.first_seen_at, i.last_seen_at
    from public.items i
    where exists (
        select 1 from public.installation_item_stats ii
        where ii.item_id = i.item_id and ii.drop_count > 0
    );
$$;

create or replace function publication_export.export_buckets_v1()
returns table (
    source_type text, source_id bigint, source_level integer, loot_kind text,
    observations bigint, installations integer,
    max_installation_share numeric, last_updated_at timestamptz
)
language sql stable security definer set search_path = ''
as $$
    select ss.source_type, ss.source_id, ss.source_level, ss.loot_kind,
           sum(ss.observations)::bigint,
           count(distinct ss.installation_id)::integer,
           round(max(ss.observations)::numeric / nullif(sum(ss.observations), 0), 4),
           max(ss.updated_at)
    from public.installation_source_stats ss
    where ss.observations > 0
    group by ss.source_type, ss.source_id, ss.source_level, ss.loot_kind;
$$;

create or replace function publication_export.export_drops_v1()
returns table (
    source_type text, source_id bigint, source_level integer, loot_kind text,
    item_id bigint, drops bigint, quantity bigint, quest_drops bigint,
    installations integer, max_installation_share numeric
)
language sql stable security definer set search_path = ''
as $$
    select ii.source_type, ii.source_id, ii.source_level, ii.loot_kind,
           ii.item_id,
           sum(ii.drop_count)::bigint,
           sum(ii.quantity)::bigint,
           sum(ii.quest_drop_count)::bigint,
           count(distinct ii.installation_id)::integer,
           round(max(ii.drop_count)::numeric / nullif(sum(ii.drop_count), 0), 4)
    from public.installation_item_stats ii
    where ii.drop_count > 0
    group by ii.source_type, ii.source_id, ii.source_level, ii.loot_kind, ii.item_id;
$$;

-- Coordinates are re-quantized server-side BEFORE leaving production.
-- p_grid is in map-percent units; only coarse grids are accepted.
create or replace function publication_export.export_locations_v1(p_grid numeric)
returns table (
    source_type text, source_id bigint, source_level integer, loot_kind text,
    map_id bigint, zone_name text, subzone_name text,
    x numeric, y numeric, observations bigint, installations integer
)
language plpgsql stable security definer set search_path = ''
as $$
begin
    if p_grid is null or p_grid not in (0.5, 1.0, 2.0, 2.5, 5.0) then
        raise exception 'Invalid export grid';
    end if;
    return query
    select l.source_type, l.source_id, l.source_level, l.loot_kind,
           l.map_id, l.zone_name, l.subzone_name,
           (round(l.x / p_grid) * p_grid)::numeric,
           (round(l.y / p_grid) * p_grid)::numeric,
           sum(l.observations)::bigint,
           count(distinct l.installation_id)::integer
    from public.installation_location_stats l
    where l.observations > 0
      and l.map_id > 0
      and l.x between 0 and 100
      and l.y between 0 and 100
    group by l.source_type, l.source_id, l.source_level, l.loot_kind,
             l.map_id, l.zone_name, l.subzone_name,
             round(l.x / p_grid) * p_grid, round(l.y / p_grid) * p_grid;
end;
$$;

do $grants$
declare
    fn text;
begin
    foreach fn in array array[
        'publication_export.export_meta_v1()',
        'publication_export.export_sources_v1()',
        'publication_export.export_items_v1()',
        'publication_export.export_buckets_v1()',
        'publication_export.export_drops_v1()',
        'publication_export.export_locations_v1(numeric)'
    ] loop
        execute format('revoke all on function %s from public', fn);
        if exists (select 1 from pg_roles where rolname = 'anon') then
            execute format('revoke all on function %s from anon', fn);
        end if;
        if exists (select 1 from pg_roles where rolname = 'authenticated') then
            execute format('revoke all on function %s from authenticated', fn);
        end if;
        execute format('grant execute on function %s to foreverdb_projection_reader', fn);
        execute format('alter function %s set statement_timeout = ''30s''', fn);
    end loop;
end
$grants$;

-- Fail the whole migration if the boundary is not exactly as intended.
do $verify$
begin
    if has_table_privilege('foreverdb_projection_reader', 'public.installations', 'select')
       or has_table_privilege('foreverdb_projection_reader', 'public.installation_source_stats', 'select')
       or has_table_privilege('foreverdb_projection_reader', 'public.installation_item_stats', 'select')
       or has_table_privilege('foreverdb_projection_reader', 'public.installation_location_stats', 'select')
       or has_table_privilege('foreverdb_projection_reader', 'public.installation_guilds', 'select')
       or has_table_privilege('foreverdb_projection_reader', 'public.installation_guild_members', 'select')
       or has_table_privilege('foreverdb_projection_reader', 'public.installation_guild_professions', 'select')
       or has_schema_privilege('foreverdb_projection_reader', 'private', 'usage')
       or (to_regclass('public.map_asset_diagnostics') is not null
           and has_table_privilege('foreverdb_projection_reader', 'public.map_asset_diagnostics', 'select'))
    then
        raise exception 'Projection reader boundary FAILED; transaction aborted';
    end if;

    if exists (select 1 from pg_roles where rolname = 'anon')
       and (has_schema_privilege('anon', 'publication_export', 'usage')
            or has_function_privilege('anon', 'publication_export.export_drops_v1()', 'execute')) then
        raise exception 'anon can reach publication_export; transaction aborted';
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated')
       and (has_schema_privilege('authenticated', 'publication_export', 'usage')
            or has_function_privilege('authenticated', 'publication_export.export_drops_v1()', 'execute')) then
        raise exception 'authenticated can reach publication_export; transaction aborted';
    end if;
end
$verify$;

commit;

-- Rollback contract (manual, approved only):
--   begin;
--   drop schema publication_export cascade;
--   drop role foreverdb_projection_reader;
--   commit;
-- No production data is created, modified or deleted by this migration.
