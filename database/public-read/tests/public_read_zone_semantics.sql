-- Ephemeral-DB ONLY. Zone-membership semantics of the PUBLIC read model (P2).
-- Precondition: 0001_public_read_model.sql applied and database/tests/fixtures/
-- zone_semantics_export.json published (scripts/public-pipeline-integration.sh).
--   creature 9001 observed in zones 1420 (12 obs) and 1421 (8 obs); item 9101 has a GLOBAL
--   drop total of 50; no zone-specific item drop count exists.
\set ON_ERROR_STOP 1

set role foreverdb_web_reader;
do $t$
declare
    r record;
    n integer := 0;
    v jsonb;
begin
    -- Item membership in BOTH zones, never with a count.
    for r in select * from web_api.zone_entities(1420, 'item', null, '', 50, 0) loop
        n := n + 1;
        if r.observations is not null or r.association <> 'inferred' or r.associated_source_count < 1 then
            raise exception 'FAIL: item % in zone 1420 has observations=% association=%', r.item_id, r.observations, r.association;
        end if;
    end loop;
    if n <> 4 then raise exception 'FAIL: expected 4 item rows in zone 1420, got %', n; end if;
    if not exists (select 1 from web_api.zone_entities(1421, 'item', null, '', 50, 0) where item_id = 9101) then
        raise exception 'FAIL: item 9101 missing from zone 1421';
    end if;

    -- Measured source observations are preserved and ordered first.
    if (select string_agg(coalesce(source_id, item_id)::text || ':' || coalesce(observations::text, 'null'), ',')
        from web_api.zone_entities(1420, null, null, '', 50, 0)) is distinct from
       '9001:12,9301:6,9002:5,1420:4,9101:null,9103:null,9104:null,9102:null' then
        raise exception 'FAIL: zone 1420 ordering/values: %',
            (select string_agg(coalesce(source_id, item_id)::text || ':' || coalesce(observations::text, 'null'), ',')
             from web_api.zone_entities(1420, null, null, '', 50, 0));
    end if;

    -- Item detail: zones are inferred, no numeric zone count; global total stays global.
    v := web_api.item(9101);
    if (v->'item'->>'totalDrops')::int <> 50 then raise exception 'FAIL: global total changed: %', v->'item'; end if;
    if jsonb_array_length(v->'zones') <> 2 then raise exception 'FAIL: item 9101 zones: %', v->'zones'; end if;
    if exists (select 1 from jsonb_array_elements(v->'zones') z
               where z->'observations' <> 'null'::jsonb or z->>'association' <> 'inferred') then
        raise exception 'FAIL: item zone carries a count: %', v->'zones';
    end if;

    -- Source detail: genuine per-zone observations for both zones.
    v := web_api.source('creature', 9001);
    if (select string_agg((z->>'mapId') || ':' || (z->>'observations') || ':' || (z->>'association'), ',' order by z->>'mapId')
        from jsonb_array_elements(v->'zones') z) <> '1420:12:observed,1421:8:observed' then
        raise exception 'FAIL: source zones: %', v->'zones';
    end if;

    raise notice 'PASS: zone semantics (items inferred/not measured, sources measured) via web_api';
end
$t$;
reset role;

-- The schema itself refuses a zone-specific ITEM count, even from the publisher role.
set role foreverdb_publisher;
do $t$
declare
    v_new bigint;
    rejected boolean := false;
begin
    v_new := pub_admin.begin_publication('zone-semantics-test', now(), now(), '{}'::jsonb);
    insert into pub.zones (publication_id, map_id, zone_name, observations, source_count, item_count)
    values (v_new, 1420, 'Tirisfal Glades', 1, 0, 1);
    begin
        insert into pub.zone_entities (publication_id, map_id, entity_kind, item_id, display_kind, name, name_norm,
                                       loot_kinds, observations, association, associated_source_count)
        values (v_new, 1420, 'item', 9101, 'item', 'X', 'x', '{mob}', 50, 'inferred', 1);
    exception when check_violation then rejected := true;
    end;
    if not rejected then raise exception 'FAIL: schema accepted a numeric zone-specific item count'; end if;
    rejected := false;
    begin
        insert into pub.zone_entities (publication_id, map_id, entity_kind, item_id, display_kind, name, name_norm,
                                       loot_kinds, observations, association, associated_source_count)
        values (v_new, 1420, 'item', 9101, 'item', 'X', 'x', '{mob}', null, 'observed', 1);
    exception when check_violation then rejected := true;
    end;
    if not rejected then raise exception 'FAIL: schema accepted an item row labelled observed'; end if;
    raise notice 'PASS: schema rejects zone-specific item counts and mislabelled item associations';
end
$t$;
reset role;
