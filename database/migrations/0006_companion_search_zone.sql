-- Companion 0.7.2 search zone selector support.
-- Exposes only aggregated public search scope data; ingest/auth ownership remains unchanged.

grant usage on schema private to anon, authenticated;

create or replace function private.foreverdb_search_zones()
returns table (
    map_id bigint,
    zone_name text
)
language sql
security definer
set search_path = ''
as $$
    select
        l.map_id,
        l.zone_name
    from public.installation_location_stats l
    where l.map_id > 0
      and nullif(btrim(l.zone_name), '') is not null
      and l.observations > 0
    group by l.map_id, l.zone_name;
$$;

revoke all on function private.foreverdb_search_zones()
from public;

grant execute on function private.foreverdb_search_zones()
to anon, authenticated;

create or replace function public.get_foreverdb_search_zones()
returns table (
    map_id bigint,
    zone_name text
)
language sql
security invoker
set search_path = ''
as $$
    select *
    from private.foreverdb_search_zones();
$$;

revoke all on function public.get_foreverdb_search_zones()
from public;

grant execute on function public.get_foreverdb_search_zones()
to anon, authenticated;

create or replace function private.foreverdb_search_in_zone(
    p_query text,
    p_map_id bigint,
    p_zone_name text
)
returns table (
    entity_kind text,
    item_id bigint,
    source_type text,
    source_id bigint,
    source_level integer,
    name text
)
language sql
security definer
set search_path = ''
as $$
    with zone_locations as (
        select distinct
            l.installation_id,
            l.source_type,
            l.source_id,
            l.source_level,
            l.loot_kind
        from public.installation_location_stats l
        where l.map_id = p_map_id
          and l.zone_name = p_zone_name
          and l.observations > 0
    ),
    item_matches as (
        select distinct
            i.item_id,
            i.name
        from zone_locations l
        join public.installation_item_stats stats
          on stats.installation_id = l.installation_id
         and stats.source_type = l.source_type
         and stats.source_id = l.source_id
         and stats.source_level = l.source_level
         and stats.loot_kind = l.loot_kind
        join public.items i
          on i.item_id = stats.item_id
        where stats.drop_count > 0
          and (
              i.name ilike ('%' || p_query || '%')
              or i.item_id = case
                  when p_query ~ '^[0-9]+$'
                  then p_query::bigint
                  else null
              end
          )
    ),
    item_results as (
        select *
        from item_matches
        order by
            case
                when lower(coalesce(name, '')) = lower(p_query)
                then 0
                else 1
            end,
            name,
            item_id
        limit 20
    ),
    source_matches as (
        select distinct
            s.source_type,
            s.source_id,
            s.source_level,
            s.name
        from zone_locations l
        join public.sources s
          on s.source_type = l.source_type
         and s.source_id = l.source_id
         and s.source_level = l.source_level
        where (
            s.name ilike ('%' || p_query || '%')
            or s.source_id = case
                when p_query ~ '^[0-9]+$'
                then p_query::bigint
                else null
            end
        )
    ),
    source_results as (
        select *
        from source_matches
        order by
            case
                when lower(coalesce(name, '')) = lower(p_query)
                then 0
                else 1
            end,
            name,
            source_type,
            source_id,
            source_level
        limit 20
    )
    select
        'item'::text,
        i.item_id,
        null::text,
        null::bigint,
        null::integer,
        i.name
    from item_results i

    union all

    select
        'source'::text,
        null::bigint,
        s.source_type,
        s.source_id,
        s.source_level,
        s.name
    from source_results s;
$$;

revoke all on function private.foreverdb_search_in_zone(text, bigint, text)
from public;

grant execute on function private.foreverdb_search_in_zone(text, bigint, text)
to anon, authenticated;

create or replace function public.get_foreverdb_search_in_zone(
    p_query text,
    p_map_id bigint,
    p_zone_name text
)
returns table (
    entity_kind text,
    item_id bigint,
    source_type text,
    source_id bigint,
    source_level integer,
    name text
)
language sql
security invoker
set search_path = ''
as $$
    select *
    from private.foreverdb_search_in_zone(
        p_query,
        p_map_id,
        p_zone_name
    );
$$;

revoke all on function public.get_foreverdb_search_in_zone(text, bigint, text)
from public;

grant execute on function public.get_foreverdb_search_in_zone(text, bigint, text)
to anon, authenticated;
