-- ForeverDB PUBLIC READ MODEL 0005: per-source map points (additive, read-only). Requires 0001 and 0002.
--
-- web_api.source_map_points(source_type, source_id, map_id, loot_kind, source_level, limit)
--   The source-detail counterpart of web_api.zone_map_points (0002), with IDENTICAL privacy rules so a source page and the zone
--   overview can never disagree or reveal different cells: reads only pub.locations of the ACTIVE publication, a floor of 2
--   observations on every published cell BEFORE summing, re-quantization to the 1% grid (coinciding cells are summed), no
--   disenchant results, no item-backed sources, bounded (1..3000), deterministic order, `total_count` = cells passing the rules.
--   It additionally returns `map_id` (UiMapID) because a source can be observed in several zones.
begin;

grant foreverdb_pub_owner to current_user with set true, inherit false;
set local role foreverdb_pub_owner;

create function web_api.source_map_points(
    p_source_type text, p_source_id bigint, p_map_id bigint, p_loot_kind text, p_source_level integer, p_limit integer)
returns table (
    source_type text, source_id bigint, source_level integer, name text, loot_kind text, map_id bigint, subzone_name text,
    x numeric, y numeric, observations bigint, total_count bigint)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
    if p_source_type is null or p_source_type not in ('creature', 'gameobject', 'fishing')
       or p_source_id is null or p_source_id < -2147483648 or p_source_id > 999999999
       or (p_map_id is not null and (p_map_id < 1 or p_map_id > 999999))
       or (p_source_level is not null and (p_source_level < 0 or p_source_level > 255))
       or p_limit is null or p_limit < 1 or p_limit > 3000
       or (p_loot_kind is not null and p_loot_kind not in ('mob', 'skinning', 'mining', 'herbalism', 'fishing',
                                                           'fishing_pool', 'chest', 'gameobject')) then
        raise exception using errcode = '22023', message = 'invalid_parameters';
    end if;
    return query
    with cells as (
        select l.source_type, l.source_id, l.source_level, l.loot_kind, l.map_id, l.subzone_name,
               round(l.x)::numeric as x, round(l.y)::numeric as y, sum(l.observations)::bigint as observations
        from pub.locations l
        where l.publication_id = web_api.active_id()
          and l.source_type = p_source_type
          and l.source_id = p_source_id
          and (p_map_id is null or l.map_id = p_map_id)
          and (p_source_level is null or l.source_level = p_source_level)
          and l.loot_kind <> 'disenchant'
          and l.observations >= 2  -- floor on every PUBLISHED cell, before any summing (same rule as zone_map_points)
          and (p_loot_kind is null or l.loot_kind = p_loot_kind)
        group by l.source_type, l.source_id, l.source_level, l.loot_kind, l.map_id, l.subzone_name, round(l.x), round(l.y)
    )
    select c.source_type, c.source_id, c.source_level, s.name, c.loot_kind, c.map_id, c.subzone_name,
           c.x, c.y, c.observations, count(*) over () as total_count
    from cells c
    join pub.sources s on s.publication_id = web_api.active_id()
                      and s.source_type = c.source_type and s.source_id = c.source_id and s.source_level = c.source_level
    order by c.observations desc, c.map_id, c.source_level, c.loot_kind, c.subzone_name, c.x, c.y
    limit p_limit;
end;
$$;

revoke all on function web_api.source_map_points(text, bigint, bigint, text, integer, integer) from public;
grant execute on function web_api.source_map_points(text, bigint, bigint, text, integer, integer) to foreverdb_web_reader;
alter function web_api.source_map_points(text, bigint, bigint, text, integer, integer) set statement_timeout = '2s';

do $verify$
begin
    if has_table_privilege('foreverdb_web_reader', 'pub.locations', 'select')
       or has_schema_privilege('foreverdb_web_reader', 'pub', 'usage')
       or has_function_privilege('foreverdb_publisher', 'web_api.source_map_points(text, bigint, bigint, text, integer, integer)', 'execute') then
        raise exception 'Public read model boundary FAILED after 0005';
    end if;
    if not has_function_privilege('foreverdb_web_reader', 'web_api.source_map_points(text, bigint, bigint, text, integer, integer)', 'execute') then
        raise exception 'web_api.source_map_points is not executable by the web reader';
    end if;
end
$verify$;

reset role;
commit;

-- Rollback contract (manual): drop function web_api.source_map_points(text, bigint, bigint, text, integer, integer);
