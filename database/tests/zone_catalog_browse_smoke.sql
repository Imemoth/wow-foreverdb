-- Run AFTER 0008_zone_catalog_browse.sql on a controlled DB.
-- Read-only assertions (transaction rolled back). No fixture writes,
-- installation identifiers, private coordinates or artwork are exported.
begin;

do $zone_browse_smoke$
declare
    v_map_id bigint;
    v_zone_name text;
    v_rows integer;
    v_total bigint;
    v_min_total bigint;
    v_extra_rows integer;
    v_oversize_rows integer;
    v_fingerprint_1 text;
    v_fingerprint_2 text;
begin
    if to_regprocedure(
        'public.get_foreverdb_zone_catalog(bigint,text,integer,integer)'
    ) is null then
        raise exception 'FAIL: zone catalog RPC not installed';
    end if;

    if has_function_privilege(
        'anon',
        'public.get_foreverdb_zone_catalog(bigint,text,integer,integer)',
        'EXECUTE'
    ) then
        raise exception 'FAIL: publishable/anon role can page the catalog';
    end if;

    if not has_function_privilege(
        'authenticated',
        'public.get_foreverdb_zone_catalog(bigint,text,integer,integer)',
        'EXECUTE'
    ) then
        raise exception 'FAIL: authenticated role cannot browse the catalog';
    end if;

    if has_table_privilege(
        'anon', 'public.installation_location_stats', 'SELECT'
    ) or has_table_privilege(
        'authenticated', 'public.installation_location_stats', 'SELECT'
    ) then
        raise exception 'FAIL: raw installation locations became exposed';
    end if;

    select z.map_id, z.zone_name
      into v_map_id, v_zone_name
    from private.foreverdb_search_zones() z
    order by z.map_id, z.zone_name
    limit 1;

    if not found then
        raise notice 'PASS: authorization checks; no observed zones to sample';
        return;
    end if;

    select count(*)::integer, max(r.total_count), min(r.total_count)
      into v_rows, v_total, v_min_total
    from public.get_foreverdb_zone_catalog(
        v_map_id, v_zone_name, 50, 0
    ) r;

    if v_rows > 50 or v_rows < 1 or
       v_total is distinct from v_min_total or
       v_total < v_rows then
        raise exception 'FAIL: invalid first catalog page or total count';
    end if;

    select count(*)::integer
      into v_oversize_rows
    from public.get_foreverdb_zone_catalog(
        v_map_id, v_zone_name, 100000, 0
    );

    if v_oversize_rows > 50 then
        raise exception 'FAIL: p_limit is not capped at 50';
    end if;

    select count(*)::integer
      into v_extra_rows
    from public.get_foreverdb_zone_catalog(
        v_map_id, v_zone_name, 50, 50
    );

    if v_extra_rows > 50 then
        raise exception 'FAIL: second page is not bounded';
    end if;

    -- Stable data/sorting should yield the same first page twice.
    select coalesce(
        string_agg(
            concat_ws('|',
                r.entity_kind,
                r.item_id,
                r.source_type,
                r.source_id,
                r.source_level,
                r.name
            ),
            E'\n'
            order by
                lower(r.name),
                r.entity_kind,
                r.item_id,
                r.source_type,
                r.source_id,
                r.source_level
        ),
        ''
    )
      into v_fingerprint_1
    from public.get_foreverdb_zone_catalog(
        v_map_id, v_zone_name, 50, 0
    ) r;

    select coalesce(
        string_agg(
            concat_ws('|',
                r.entity_kind,
                r.item_id,
                r.source_type,
                r.source_id,
                r.source_level,
                r.name
            ),
            E'\n'
            order by
                lower(r.name),
                r.entity_kind,
                r.item_id,
                r.source_type,
                r.source_id,
                r.source_level
        ),
        ''
    )
      into v_fingerprint_2
    from public.get_foreverdb_zone_catalog(
        v_map_id, v_zone_name, 50, 0
    ) r;

    if v_fingerprint_1 is distinct from v_fingerprint_2 then
        raise exception 'FAIL: catalog paging order was unstable';
    end if;

    raise notice
        'PASS: verified bounded zone catalog pages and grants for one zone';
end
$zone_browse_smoke$;

rollback;
