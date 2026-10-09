-- Local / isolated Postgres regression for migration 0009.
-- Run as database owner after fixture migrations, not against production:
-- 20 catalog invocations temporarily consume quota rows (rolled back here).
begin;

do $acl$
begin
    if has_schema_privilege('anon','private','usage')
        or has_schema_privilege('authenticated','private','usage')
        or has_table_privilege('anon','public.items','select')
        or has_table_privilege('authenticated','public.items','select')
        or has_table_privilege('anon','public.sources','select')
        or has_table_privilege('authenticated','public.sources','select')
    then
        raise exception 'FAIL: direct private/catalog access was not revoked';
    end if;

    if has_function_privilege(
        'anon',
        'public.get_foreverdb_zone_catalog(bigint,text,integer,integer)',
        'execute'
    ) or has_function_privilege(
        'anon',
        'public.get_foreverdb_search_global(text)',
        'execute'
    ) or has_function_privilege(
        'anon',
        'public.get_foreverdb_item_locations(bigint)',
        'execute'
    ) or has_function_privilege(
        'anon',
        'public.ingest_foreverdb_snapshot_auth(jsonb)',
        'execute'
    ) then
        raise exception 'FAIL: anon may still use a read or ingest RPC';
    end if;

    if not has_function_privilege(
        'authenticated',
        'public.get_foreverdb_zone_catalog(bigint,text,integer,integer)',
        'execute'
    ) or not has_function_privilege(
        'authenticated',
        'public.get_foreverdb_search_global(text)',
        'execute'
    ) or not has_function_privilege(
        'authenticated',
        'public.get_foreverdb_item_locations(bigint)',
        'execute'
    ) or not has_function_privilege(
        'authenticated',
        'public.ingest_foreverdb_snapshot_auth(jsonb)',
        'execute'
    ) then
        raise exception 'FAIL: Companion authenticated rights missing';
    end if;

    if has_table_privilege('authenticated',
          'public.installation_location_stats','select') then
        raise exception 'FAIL: installation locations exposed';
    end if;
end $acl$;

set local role authenticated;
select set_config(
    'request.jwt.claim.sub',
    '00000000-0000-4000-8000-000000000009', true
);
select set_config('request.jwt.claim.role','authenticated',true);

do $auth_checks$
declare
    v_count integer;
    v_throttled boolean := false;
begin
    -- All of these wrappers are real authenticated, elevated calls even
    -- though authenticated has NO direct SELECT on their underlying tables.
    perform public.get_foreverdb_search_zones();
    perform public.get_foreverdb_search_global('Copper');
    perform public.get_foreverdb_search_in_zone(
        'Copper',1420,'Tirisfal Glades');
    perform public.get_foreverdb_item_stats(2770);
    perform public.get_foreverdb_source_stats('gameobject',1731,0);
    perform public.get_foreverdb_item_locations(2770);
    perform public.get_foreverdb_source_locations('gameobject',1731,0);
    perform public.get_foreverdb_zone_catalog(
        1420,'Tirisfal Glades',50,0);

    -- Scope caps are validation contracts, not advisory UI hints.
    begin
        perform public.get_foreverdb_zone_catalog(
            1420,'Tirisfal Glades',500,0);
        raise exception 'FAIL: oversized catalog page accepted';
    exception
        when sqlstate 'PT400' then null;
    end;

    begin
        perform public.get_foreverdb_zone_catalog(
            1420,'Tirisfal Glades',50,2001);
        raise exception 'FAIL: unbounded offset accepted';
    exception
        when sqlstate 'PT400' then null;
    end;

    begin
        perform public.get_foreverdb_search_global('%');
        raise exception 'FAIL: wildcard-only query accepted';
    exception
        when sqlstate 'PT400' then null;
    end;

    begin
        perform public.get_foreverdb_search_in_zone(
            repeat('x',120),1420,'Tirisfal Glades');
        raise exception 'FAIL: huge query accepted';
    exception
        when sqlstate 'PT400' then null;
    end;

    -- Try fewer than 20 extra calls (2 rejected calls above were rolled back)
    -- to reach the per-UID 20/minute catalog threshold.
    for v_count in 1..19 loop
        perform public.get_foreverdb_zone_catalog(
            1420,'Tirisfal Glades',50,0);
    end loop;

    begin
        perform public.get_foreverdb_zone_catalog(
            1420,'Tirisfal Glades',50,0);
    exception
        when sqlstate 'PT429' then v_throttled := true;
    end;

    if not v_throttled then
        raise exception 'FAIL: 20-per-minute catalog quota not enforced';
    end if;

    begin
        perform public.ingest_foreverdb_snapshot_auth(
          jsonb_build_object(
            'installationId','security-only-test',
            'schemaVersion',7,
            'updatedAt',1,
            'sources',jsonb_build_array(),
            'guilds',jsonb_build_array(
              jsonb_build_object('members',jsonb_build_array(
                repeat('a',8500000)
              ))
            )
          )
        );
        raise exception 'FAIL: overlarge ingest payload accepted';
    exception
        when sqlstate 'PT413' then null;
    end;

    raise notice 'PASS: authenticated wrappers, auth identity, bounded inputs and 429 quotas';
end $auth_checks$;

reset role;
rollback;
