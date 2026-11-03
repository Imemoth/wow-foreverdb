-- Ephemeral-DB ONLY. web_api.zone_map_points (0002): bounds, privacy floor, re-quantization, location semantics, no private access.
-- Preconditions: 0001 and 0002 applied, and database/tests/fixtures/zone_semantics_export.json published through the real worker
-- (scripts/public-pipeline-integration.sh): creature 9001 in 1420 (12 obs at 41,52) and 1421; creature 9002 in 1420 (5 obs at 20,30);
-- a mining node and a fishing source in 1420.
-- This file ALSO plants rows that the real worker would never publish (sub-threshold cells, sub-grid coordinates, an item-backed source,
-- a disenchant bucket) directly as the database owner, to prove the function enforces the privacy floor ITSELF.
\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------- baseline (as the web reader)
set role foreverdb_web_reader;
do $t$
declare r record; n integer := 0; v_total bigint;
begin
    select count(*), max(total_count) into n, v_total from web_api.zone_map_points(1420, null, 100);
    if n < 2 or n <> v_total then raise exception 'FAIL: baseline zone 1420 rows=% total=%', n, v_total; end if;
    if not exists (select 1 from web_api.zone_map_points(1420, null, 100)
                   where source_type = 'creature' and source_id = 9001 and source_level = 10 and loot_kind = 'mob'
                     and subzone_name = 'Brill' and x = 41 and y = 52 and observations = 12 and name is not null) then
        raise exception 'FAIL: published cell missing or wrong';
    end if;
    -- other zones are not mixed in
    if exists (select 1 from web_api.zone_map_points(1420, null, 100) where subzone_name = 'The Sepulcher') then
        raise exception 'FAIL: cell of zone 1421 returned for zone 1420';
    end if;
    if (select count(*) from web_api.zone_map_points(999999, null, 10)) <> 0 then raise exception 'FAIL: unknown zone returned rows'; end if;
    raise notice 'PASS: zone map points: published cells of the requested zone only';
end
$t$;
reset role;

-- ---------------------------------------------------------------- plant rows the worker would never publish (owner / superuser)
do $plant$
declare v_pub bigint := (select active_publication_id from pub.state where id = 1);
begin
    -- sub-threshold cells (1 observation) and a pair that would COINCIDE after re-quantization (1 + 1)
    insert into pub.locations (publication_id, source_type, source_id, source_level, loot_kind, map_id, subzone_name, x, y, observations) values
        (v_pub, 'creature', 9001, 10, 'mob', 1420, 'Brill', 60.0, 60.0, 1),
        (v_pub, 'creature', 9001, 10, 'mob', 1420, 'Brill', 70.3, 70.3, 1),
        (v_pub, 'creature', 9001, 10, 'mob', 1420, 'Brill', 70.4, 70.4, 1),
        -- a sub-grid (finer than 1%) pair of qualifying cells that coincide after re-quantization: must be summed (2 + 3)
        (v_pub, 'creature', 9001, 10, 'mob', 1420, 'Brill', 80.2, 80.2, 2),
        (v_pub, 'creature', 9001, 10, 'mob', 1420, 'Brill', 79.8, 79.8, 3)
        on conflict do nothing;
    -- a disenchant bucket and an item-backed source with located rows (neither has a map location)
    insert into pub.buckets (publication_id, source_type, source_id, source_level, loot_kind, observations, confidence)
        values (v_pub, 'creature', 9001, 10, 'disenchant', 5, 'low') on conflict do nothing;
    insert into pub.locations (publication_id, source_type, source_id, source_level, loot_kind, map_id, subzone_name, x, y, observations)
        values (v_pub, 'creature', 9001, 10, 'disenchant', 1420, 'Brill', 12.0, 12.0, 9) on conflict do nothing;
    insert into pub.sources (publication_id, source_type, source_id, source_level, name, name_norm, display_kind, total_observations)
        values (v_pub, 'item', 9101, 0, 'Item Source', 'item source', 'item', 9) on conflict do nothing;
    insert into pub.buckets (publication_id, source_type, source_id, source_level, loot_kind, observations, confidence)
        values (v_pub, 'item', 9101, 0, 'gameobject', 9, 'low') on conflict do nothing;
    insert into pub.locations (publication_id, source_type, source_id, source_level, loot_kind, map_id, subzone_name, x, y, observations)
        values (v_pub, 'item', 9101, 0, 'gameobject', 1420, 'Brill', 13.0, 13.0, 9) on conflict do nothing;
end
$plant$;

-- ---------------------------------------------------------------- privacy floor, quantization, semantics
set role foreverdb_web_reader;
do $t$
declare r record;
begin
    if exists (select 1 from web_api.zone_map_points(1420, null, 3000) where observations < 2) then
        raise exception 'FAIL: a cell below the privacy floor was returned';
    end if;
    if exists (select 1 from web_api.zone_map_points(1420, null, 3000) where (x = 60 and y = 60) or (x = 70 and y = 70)) then
        raise exception 'FAIL: sub-threshold cells (alone or combined after rounding) became visible';
    end if;
    if exists (select 1 from web_api.zone_map_points(1420, null, 3000) where x <> round(x) or y <> round(y)) then
        raise exception 'FAIL: a coordinate finer than the 1%% grid was returned';
    end if;
    select * into r from web_api.zone_map_points(1420, null, 3000) where x = 80 and y = 80;
    if r.observations is distinct from 5 then raise exception 'FAIL: coinciding qualifying cells were not summed: %', r.observations; end if;
    if exists (select 1 from web_api.zone_map_points(1420, null, 3000) where loot_kind = 'disenchant' or source_type = 'item') then
        raise exception 'FAIL: disenchant/item-backed rows were located';
    end if;
    -- the creature level stays part of the cell identity
    if exists (select 1 from web_api.zone_map_points(1420, null, 3000) where source_level is null) then raise exception 'FAIL: level lost'; end if;
    raise notice 'PASS: zone map points: floor before summing, 1%% re-quantization, no disenchant/item locations';
end
$t$;

-- ---------------------------------------------------------------- filter differencing: per-kind results partition the unfiltered result
do $t$
declare k text; n_all integer; n_sum integer := 0; n integer;
begin
    select count(*) into n_all from web_api.zone_map_points(1420, null, 3000);
    foreach k in array array['mob', 'skinning', 'mining', 'herbalism', 'fishing', 'fishing_pool', 'chest', 'gameobject'] loop
        select count(*) into n from web_api.zone_map_points(1420, k, 3000);
        n_sum := n_sum + n;
        if exists (select 1 from web_api.zone_map_points(1420, k, 3000) f
                   where not exists (select 1 from web_api.zone_map_points(1420, null, 3000) a
                                     where (a.source_type, a.source_id, a.source_level, a.loot_kind, a.subzone_name, a.x, a.y, a.observations)
                                         = (f.source_type, f.source_id, f.source_level, f.loot_kind, f.subzone_name, f.x, f.y, f.observations))) then
            raise exception 'FAIL: filter % revealed a cell absent from the unfiltered read', k;
        end if;
    end loop;
    if n_sum <> n_all then raise exception 'FAIL: per-kind results (%) do not partition the unfiltered result (%)', n_sum, n_all; end if;
    raise notice 'PASS: zone map points: filtering cannot reveal withheld cells';
end
$t$;

-- ---------------------------------------------------------------- determinism, bounds, truncation count
do $t$
declare a text; b text; v_total bigint; n integer;
begin
    select string_agg(concat_ws('|', source_type, source_id, source_level, loot_kind, subzone_name, x, y, observations), ';') into a from web_api.zone_map_points(1420, null, 3000);
    select string_agg(concat_ws('|', source_type, source_id, source_level, loot_kind, subzone_name, x, y, observations), ';') into b from web_api.zone_map_points(1420, null, 3000);
    if a is distinct from b then raise exception 'FAIL: not deterministic'; end if;
    select total_count into v_total from web_api.zone_map_points(1420, null, 1);
    select count(*) into n from web_api.zone_map_points(1420, null, 3000);
    if v_total <> n then raise exception 'FAIL: total_count % <> rows %', v_total, n; end if;
    if (select observations from web_api.zone_map_points(1420, null, 1)) <> (select max(observations) from web_api.zone_map_points(1420, null, 3000)) then
        raise exception 'FAIL: limit does not keep the best-observed cell first';
    end if;
    raise notice 'PASS: zone map points: deterministic, ordered, total_count honest';
end
$t$;

-- ---------------------------------------------------------------- parameter validation and injection
do $t$
declare bad boolean;
begin
    foreach bad in array array[true] loop
        begin perform * from web_api.zone_map_points(0, null, 10); raise exception 'FAIL: map 0 accepted'; exception when sqlstate '22023' then null; end;
        begin perform * from web_api.zone_map_points(1000000, null, 10); raise exception 'FAIL: map 1000000 accepted'; exception when sqlstate '22023' then null; end;
        begin perform * from web_api.zone_map_points(null, null, 10); raise exception 'FAIL: null map accepted'; exception when sqlstate '22023' then null; end;
        begin perform * from web_api.zone_map_points(1420, null, 0); raise exception 'FAIL: limit 0 accepted'; exception when sqlstate '22023' then null; end;
        begin perform * from web_api.zone_map_points(1420, null, 3001); raise exception 'FAIL: limit 3001 accepted'; exception when sqlstate '22023' then null; end;
        begin perform * from web_api.zone_map_points(1420, null, null); raise exception 'FAIL: null limit accepted'; exception when sqlstate '22023' then null; end;
        begin perform * from web_api.zone_map_points(1420, 'disenchant', 10); raise exception 'FAIL: disenchant kind accepted'; exception when sqlstate '22023' then null; end;
        begin perform * from web_api.zone_map_points(1420, '''; drop table pub.items; --', 10); raise exception 'FAIL: injection kind accepted'; exception when sqlstate '22023' then null; end;
    end loop;
    raise notice 'PASS: zone map points: bounded parameters, injection strings rejected';
end
$t$;

-- ---------------------------------------------------------------- the web reader still has no table access and cannot write
do $t$
declare denied boolean := false;
begin
    begin perform 1 from pub.locations limit 1; exception when insufficient_privilege then denied := true; end;
    if not denied then raise exception 'FAIL: web reader can SELECT pub.locations'; end if;
    denied := false;
    begin delete from pub.locations; exception when insufficient_privilege or read_only_sql_transaction then denied := true; end;
    if not denied then raise exception 'FAIL: web reader can DELETE'; end if;
    raise notice 'PASS: zone map points: read-only, function-only access';
end
$t$;
reset role;

-- a role without the grant (PUBLIC) cannot execute it
do $t$
begin
    if has_function_privilege('public', 'web_api.zone_map_points(bigint, text, integer)', 'execute') then raise exception 'FAIL: PUBLIC can execute zone_map_points'; end if;
    if has_function_privilege('foreverdb_publisher', 'web_api.zone_map_points(bigint, text, integer)', 'execute') then raise exception 'FAIL: publisher can execute zone_map_points'; end if;
    raise notice 'PASS: zone map points: EXECUTE limited to the web reader';
end
$t$;
