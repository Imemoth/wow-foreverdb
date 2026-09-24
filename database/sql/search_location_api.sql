-- ForeverDB aggregated location read API.
-- Already applied to the active Supabase project during development.
-- This file documents the SQL required to recreate the location API.

create or replace function private.foreverdb_item_locations(
    p_item_id bigint
)
returns table (
    source_type text,
    source_id bigint,
    source_level integer,
    loot_kind text,
    map_id bigint,
    zone_name text,
    subzone_name text,
    x numeric,
    y numeric,
    observations bigint
)
language sql
security definer
set search_path = ''
as $$
    select
        l.source_type,
        l.source_id,
        l.source_level,
        l.loot_kind,
        l.map_id,
        l.zone_name,
        l.subzone_name,
        l.x,
        l.y,
        sum(l.observations)::bigint
    from public.installation_location_stats l
    where exists (
        select 1
        from public.installation_item_stats i
        where i.installation_id = l.installation_id
          and i.source_type = l.source_type
          and i.source_id = l.source_id
          and i.source_level = l.source_level
          and i.loot_kind = l.loot_kind
          and i.item_id = p_item_id
    )
    group by
        l.source_type,
        l.source_id,
        l.source_level,
        l.loot_kind,
        l.map_id,
        l.zone_name,
        l.subzone_name,
        l.x,
        l.y;
$$;

create or replace function private.foreverdb_source_locations(
    p_source_type text,
    p_source_id bigint,
    p_source_level integer
)
returns table (
    source_type text,
    source_id bigint,
    source_level integer,
    loot_kind text,
    map_id bigint,
    zone_name text,
    subzone_name text,
    x numeric,
    y numeric,
    observations bigint
)
language sql
security definer
set search_path = ''
as $$
    select
        l.source_type,
        l.source_id,
        l.source_level,
        l.loot_kind,
        l.map_id,
        l.zone_name,
        l.subzone_name,
        l.x,
        l.y,
        sum(l.observations)::bigint
    from public.installation_location_stats l
    where l.source_type = p_source_type
      and l.source_id = p_source_id
      and l.source_level = p_source_level
    group by
        l.source_type,
        l.source_id,
        l.source_level,
        l.loot_kind,
        l.map_id,
        l.zone_name,
        l.subzone_name,
        l.x,
        l.y;
$$;

revoke all on function private.foreverdb_item_locations(bigint)
from public;

revoke all on function private.foreverdb_source_locations(text, bigint, integer)
from public;

grant usage on schema private to anon, authenticated;

grant execute on function private.foreverdb_item_locations(bigint)
to anon, authenticated;

grant execute on function private.foreverdb_source_locations(text, bigint, integer)
to anon, authenticated;

create or replace function public.get_foreverdb_item_locations(
    p_item_id bigint
)
returns table (
    source_type text,
    source_id bigint,
    source_level integer,
    loot_kind text,
    map_id bigint,
    zone_name text,
    subzone_name text,
    x numeric,
    y numeric,
    observations bigint
)
language sql
security invoker
set search_path = ''
as $$
    select *
    from private.foreverdb_item_locations(p_item_id);
$$;

create or replace function public.get_foreverdb_source_locations(
    p_source_type text,
    p_source_id bigint,
    p_source_level integer
)
returns table (
    source_type text,
    source_id bigint,
    source_level integer,
    loot_kind text,
    map_id bigint,
    zone_name text,
    subzone_name text,
    x numeric,
    y numeric,
    observations bigint
)
language sql
security invoker
set search_path = ''
as $$
    select *
    from private.foreverdb_source_locations(
        p_source_type,
        p_source_id,
        p_source_level
    );
$$;

revoke all on function public.get_foreverdb_item_locations(bigint)
from public;

revoke all on function public.get_foreverdb_source_locations(text, bigint, integer)
from public;

grant execute on function public.get_foreverdb_item_locations(bigint)
to anon, authenticated;

grant execute on function public.get_foreverdb_source_locations(text, bigint, integer)
to anon, authenticated;
