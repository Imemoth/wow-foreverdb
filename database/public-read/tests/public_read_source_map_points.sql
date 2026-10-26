-- Ephemeral-DB ONLY. web_api.source_map_points (0005): same privacy rules as zone_map_points, consistency with the zone read, bounds.
-- Preconditions: 0001, 0002, 0005 applied; database/tests/fixtures/zone_semantics_export.json published through the real worker
-- (creature 9001 observed in 1420 and 1421; creature 9002 and a mining node and a fishing source in 1420); the planted rows of
-- public_read_zone_map_points.sql MAY be present (they are ignored/never revealed by the same floor).
\set ON_ERROR_STOP 1

set role foreverdb_web_reader;
do $t$
declare n_all integer; n_1420 integer; n_1421 integer; v_total bigint;
begin
    select count(*), max(total_count) into n_all, v_total from web_api.source_map_points('creature', 9001, null, null, null, 100);
    if n_all < 2 or n_all <> v_total then raise exception 'FAIL: baseline rows=% total=%', n_all, v_total; end if;
    select count(*) into n_1420 from web_api.source_map_points('creature', 9001, 1420, null, null, 100);
    select count(*) into n_1421 from web_api.source_map_points('creature', 9001, 1421, null, null, 100);
    if n_1420 = 0 or n_1421 = 0 or n_1420 + n_1421 <> n_all then raise exception 'FAIL: zone split % + % <> %', n_1420, n_1421, n_all; end if;
    if exists (select 1 from web_api.source_map_points('creature', 9001, 1420, null, null, 100) where map_id <> 1420) then
        raise exception 'FAIL: other zone returned';
    end if;
    if (select count(*) from web_api.source_map_points('creature', 424242, null, null, null, 10)) <> 0 then raise exception 'FAIL: unknown source returned rows'; end if;
    raise notice 'PASS: source map points: per-source cells split cleanly by zone';
end
$t$;

-- consistency with the zone overview: the same cells, same counts, for every located source of the zone
do $t$
declare r record;
begin
    for r in select distinct z.source_type, z.source_id from web_api.zone_map_points(1420, null, 3000) z loop
        if exists (
            (select z.source_level, z.loot_kind, z.subzone_name, z.x, z.y, z.observations from web_api.zone_map_points(1420, null, 3000) z
              where z.source_type = r.source_type and z.source_id = r.source_id
             except
             select s.source_level, s.loot_kind, s.subzone_name, s.x, s.y, s.observations from web_api.source_map_points(r.source_type, r.source_id, 1420, null, null, 3000) s)
            union all
            (select s.source_level, s.loot_kind, s.subzone_name, s.x, s.y, s.observations from web_api.source_map_points(r.source_type, r.source_id, 1420, null, null, 3000) s
             except
             select z.source_level, z.loot_kind, z.subzone_name, z.x, z.y, z.observations from web_api.zone_map_points(1420, null, 3000) z
              where z.source_type = r.source_type and z.source_id = r.source_id)) then
            raise exception 'FAIL: zone overview and source read disagree for % %', r.source_type, r.source_id;
        end if;
    end loop;
    raise notice 'PASS: source map points: identical to the zone overview for every source of the zone';
end
$t$;
reset role;

-- planted rows a worker would never publish (as owner), exactly like the zone test: the floor must hold HERE too
do $plant$
declare v_pub bigint := (select active_publication_id from pub.state where id = 1);
begin
    insert into pub.locations (publication_id, source_type, source_id, source_level, loot_kind, map_id, subzone_name, x, y, observations) values
        (v_pub, 'creature', 9001, 10, 'mob', 1420, 'Brill', 61.0, 61.0, 1),
        (v_pub, 'creature', 9001, 10, 'mob', 1420, 'Brill', 71.3, 71.3, 1),
        (v_pub, 'creature', 9001, 10, 'mob', 1420, 'Brill', 71.4, 71.4, 1),
        (v_pub, 'creature', 9001, 10, 'mob', 1420, 'Brill', 81.2, 81.2, 2),
        (v_pub, 'creature', 9001, 10, 'mob', 1420, 'Brill', 80.8, 80.8, 3)
        on conflict do nothing;
    insert into pub.buckets (publication_id, source_type, source_id, source_level, loot_kind, observations, confidence)
        values (v_pub, 'creature', 9001, 10, 'disenchant', 5, 'low') on conflict do nothing;
    insert into pub.locations (publication_id, source_type, source_id, source_level, loot_kind, map_id, subzone_name, x, y, observations)
        values (v_pub, 'creature', 9001, 10, 'disenchant', 1420, 'Brill', 14.0, 14.0, 9) on conflict do nothing;
end
$plant$;

set role foreverdb_web_reader;
do $t$
declare r record;
begin
    if exists (select 1 from web_api.source_map_points('creature', 9001, null, null, null, 3000) where observations < 2) then
        raise exception 'FAIL: cell below the privacy floor returned';
    end if;
    if exists (select 1 from web_api.source_map_points('creature', 9001, 1420, null, null, 3000) where (x = 61 and y = 61) or (x = 71 and y = 71)) then
        raise exception 'FAIL: sub-threshold cells became visible';
    end if;
    if exists (select 1 from web_api.source_map_points('creature', 9001, null, null, null, 3000) where x <> round(x) or y <> round(y)) then
        raise exception 'FAIL: coordinate finer than the 1%% grid';
    end if;
    select * into r from web_api.source_map_points('creature', 9001, 1420, null, null, 3000) where x = 81 and y = 81;
    if r.observations is distinct from 5 then raise exception 'FAIL: coinciding qualifying cells were not summed: %', r.observations; end if;
    if exists (select 1 from web_api.source_map_points('creature', 9001, null, null, null, 3000) where loot_kind = 'disenchant') then
        raise exception 'FAIL: disenchant located';
    end if;
    -- filters can only narrow
    if exists (select 1 from web_api.source_map_points('creature', 9001, 1420, 'mob', 10, 3000) f
               where not exists (select 1 from web_api.source_map_points('creature', 9001, null, null, null, 3000) a
                                 where (a.map_id, a.source_level, a.loot_kind, a.subzone_name, a.x, a.y, a.observations)
                                     = (f.map_id, f.source_level, f.loot_kind, f.subzone_name, f.x, f.y, f.observations))) then
        raise exception 'FAIL: filter revealed a cell absent from the unfiltered read';
    end if;
    raise notice 'PASS: source map points: floor before summing, 1%% re-quantization, no disenchant, filters only narrow';
end
$t$;

do $t$
declare v_total bigint; n integer; a text; b text;
begin
    select total_count into v_total from web_api.source_map_points('creature', 9001, null, null, null, 1);
    select count(*) into n from web_api.source_map_points('creature', 9001, null, null, null, 3000);
    if v_total <> n then raise exception 'FAIL: total_count % <> rows %', v_total, n; end if;
    if (select observations from web_api.source_map_points('creature', 9001, null, null, null, 1)) <> (select max(observations) from web_api.source_map_points('creature', 9001, null, null, null, 3000)) then
        raise exception 'FAIL: limit does not keep the best-observed cell first';
    end if;
    select string_agg(concat_ws('|', map_id, source_level, loot_kind, subzone_name, x, y, observations), ';') into a from web_api.source_map_points('creature', 9001, null, null, null, 3000);
    select string_agg(concat_ws('|', map_id, source_level, loot_kind, subzone_name, x, y, observations), ';') into b from web_api.source_map_points('creature', 9001, null, null, null, 3000);
    if a is distinct from b then raise exception 'FAIL: not deterministic'; end if;
    raise notice 'PASS: source map points: ordered, deterministic, total_count honest';
end
$t$;

do $t$
begin
    begin perform * from web_api.source_map_points('item', 9101, null, null, null, 10); raise exception 'FAIL: item source accepted'; exception when sqlstate '22023' then null; end;
    begin perform * from web_api.source_map_points(null, 9001, null, null, null, 10); raise exception 'FAIL: null type accepted'; exception when sqlstate '22023' then null; end;
    begin perform * from web_api.source_map_points('creature', null, null, null, null, 10); raise exception 'FAIL: null id accepted'; exception when sqlstate '22023' then null; end;
    begin perform * from web_api.source_map_points('creature', 9001, 0, null, null, 10); raise exception 'FAIL: map 0 accepted'; exception when sqlstate '22023' then null; end;
    begin perform * from web_api.source_map_points('creature', 9001, 1000000, null, null, 10); raise exception 'FAIL: map 1000000 accepted'; exception when sqlstate '22023' then null; end;
    begin perform * from web_api.source_map_points('creature', 9001, null, null, 256, 10); raise exception 'FAIL: level 256 accepted'; exception when sqlstate '22023' then null; end;
    begin perform * from web_api.source_map_points('creature', 9001, null, null, null, 0); raise exception 'FAIL: limit 0 accepted'; exception when sqlstate '22023' then null; end;
    begin perform * from web_api.source_map_points('creature', 9001, null, null, null, 3001); raise exception 'FAIL: limit 3001 accepted'; exception when sqlstate '22023' then null; end;
    begin perform * from web_api.source_map_points('creature', 9001, null, 'disenchant', null, 10); raise exception 'FAIL: disenchant kind accepted'; exception when sqlstate '22023' then null; end;
    begin perform * from web_api.source_map_points('creature', 9001, null, '''; drop table pub.items; --', null, 10); raise exception 'FAIL: injection kind accepted'; exception when sqlstate '22023' then null; end;
    begin perform * from web_api.source_map_points('creature''; --', 9001, null, null, null, 10); raise exception 'FAIL: injection type accepted'; exception when sqlstate '22023' then null; end;
    raise notice 'PASS: source map points: bounded parameters, item sources and injection strings rejected';
end
$t$;
reset role;

do $t$
begin
    if has_function_privilege('public', 'web_api.source_map_points(text, bigint, bigint, text, integer, integer)', 'execute') then raise exception 'FAIL: PUBLIC can execute source_map_points'; end if;
    if has_function_privilege('foreverdb_publisher', 'web_api.source_map_points(text, bigint, bigint, text, integer, integer)', 'execute') then raise exception 'FAIL: publisher can execute source_map_points'; end if;
    raise notice 'PASS: source map points: EXECUTE limited to the web reader';
end
$t$;
