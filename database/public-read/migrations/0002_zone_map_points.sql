-- ForeverDB PUBLIC READ MODEL 0002: zone-wide map points (additive, read-only).
--
-- NOT APPLIED ANYWHERE. Committed for owner review only (P2-Z1). Target: the isolated public-read database, never the private
-- production project. Requires 0001. Adds exactly ONE function and ONE index; no table, column, role or existing function changes.
--
-- web_api.zone_map_points(map_id, loot_kind, limit)
--   The zone-wide counterpart of the `locations` array that web_api.source() already returns per source. It reads ONLY pub.locations
--   (cells the publication worker has already thresholded: >= minLocationCellObservations, 1% grid) of the ACTIVE publication, so it
--   cannot reveal a cell that web_api.source() does not already reveal. Defence in depth on top of the worker, enforced HERE:
--     * a floor of 2 observations on every published cell, applied BEFORE any summing (never lower than the published threshold);
--     * coordinates are re-quantized to the 1% grid (a finer value, if a publication ever contained one, is never emitted) and cells
--       that coincide after re-quantization are summed;
--     * disenchant results and item-backed sources have no map location and are never returned;
--     * no installation/contributor/account columns exist in pub.locations, so none can be returned.
--   Bounded: 1..3000 rows, one zone, optional single loot kind, fixed deterministic order (observations desc, then keys), 2 s timeout.
--   `total_count` is the number of cells that pass the rules above (published data only), so a client can say "showing N of M".
begin;

grant foreverdb_pub_owner to current_user with set true, inherit false;
set local role foreverdb_pub_owner;

create index if not exists locations_map_idx on pub.locations (publication_id, map_id, observations desc);

create function web_api.zone_map_points(p_map_id bigint, p_loot_kind text, p_limit integer)
returns table (
    source_type text, source_id bigint, source_level integer, name text, loot_kind text, subzone_name text,
    x numeric, y numeric, observations bigint, total_count bigint)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
    if p_map_id is null or p_map_id < 1 or p_map_id > 999999
       or p_limit is null or p_limit < 1 or p_limit > 3000
       or (p_loot_kind is not null and p_loot_kind not in ('mob', 'skinning', 'mining', 'herbalism', 'fishing',
                                                           'fishing_pool', 'chest', 'gameobject')) then
        raise exception using errcode = '22023', message = 'invalid_parameters';
    end if;
    return query
    with cells as (
        select l.source_type, l.source_id, l.source_level, l.loot_kind, l.subzone_name,
               round(l.x)::numeric as x, round(l.y)::numeric as y, sum(l.observations)::bigint as observations
        from pub.locations l
        where l.publication_id = web_api.active_id()
          and l.map_id = p_map_id
          and l.source_type <> 'item'
          and l.loot_kind <> 'disenchant'
          and l.observations >= 2  -- floor on every PUBLISHED cell, before any summing: sub-threshold cells never combine into a visible one
          and (p_loot_kind is null or l.loot_kind = p_loot_kind)
        group by l.source_type, l.source_id, l.source_level, l.loot_kind, l.subzone_name, round(l.x), round(l.y)
    )
    select c.source_type, c.source_id, c.source_level, s.name, c.loot_kind, c.subzone_name,
           c.x, c.y, c.observations, count(*) over () as total_count
    from cells c
    join pub.sources s on s.publication_id = web_api.active_id()
                      and s.source_type = c.source_type and s.source_id = c.source_id and s.source_level = c.source_level
    order by c.observations desc, c.source_type, c.source_id, c.source_level, c.loot_kind, c.subzone_name, c.x, c.y
    limit p_limit;
end;
$$;

revoke all on function web_api.zone_map_points(bigint, text, integer) from public;
grant execute on function web_api.zone_map_points(bigint, text, integer) to foreverdb_web_reader;
alter function web_api.zone_map_points(bigint, text, integer) set statement_timeout = '2s';

-- Boundary assertions (run as the owner): abort the migration if the web reader gained anything but EXECUTE on web_api.
do $verify$
begin
    if has_table_privilege('foreverdb_web_reader', 'pub.locations', 'select')
       or has_schema_privilege('foreverdb_web_reader', 'pub', 'usage') then
        raise exception 'Public read model boundary FAILED after 0002';
    end if;
    if not has_function_privilege('foreverdb_web_reader', 'web_api.zone_map_points(bigint, text, integer)', 'execute') then
        raise exception 'web_api.zone_map_points is not executable by the web reader';
    end if;
end
$verify$;

reset role;
commit;
