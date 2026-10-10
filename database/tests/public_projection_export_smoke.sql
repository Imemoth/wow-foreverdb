-- Ephemeral-DB ONLY test for database/private-export/0010_public_projection_export.sql.
-- Requires: repo migrations + 0010 + database/tests/fixtures/synthetic_private_seed.sql.
-- Every check raises on failure (run with ON_ERROR_STOP=1).

\set ON_ERROR_STOP 1

do $t$
declare
    n bigint;
    ok boolean;
begin
    -- 1. Client API roles cannot reach the export at all.
    if has_schema_privilege('anon', 'publication_export', 'usage')
       or has_schema_privilege('authenticated', 'publication_export', 'usage')
       or has_function_privilege('anon', 'publication_export.export_drops_v1()', 'execute')
       or has_function_privilege('authenticated', 'publication_export.export_locations_v1(numeric)', 'execute') then
        raise exception 'FAIL: API role can reach publication_export';
    end if;

    -- 2. Denominator correctness: bucket observations equal the sum over ALL installations.
    select count(*) into n
    from publication_export.export_buckets_v1() b
    join (select source_type, source_id, source_level, loot_kind, sum(observations) s
          from public.installation_source_stats group by 1, 2, 3, 4) raw
      using (source_type, source_id, source_level, loot_kind)
    where b.observations <> raw.s;
    if n <> 0 then raise exception 'FAIL: % bucket denominators differ from raw sums', n; end if;

    -- 3. Coarse quantization is applied before data leaves production.
    select count(*) into n from publication_export.export_locations_v1(1.0)
    where x <> round(x) or y <> round(y);
    if n <> 0 then raise exception 'FAIL: % locations not quantized to the 1.0 grid', n; end if;

    -- 4. Invalid grids are rejected.
    ok := false;
    begin
        perform * from publication_export.export_locations_v1(0.01);
    exception when others then ok := true;
    end;
    if not ok then raise exception 'FAIL: fine-grained export grid accepted'; end if;

    raise notice 'PASS: export privileges, denominators, quantization, grid validation';
end
$t$;

-- 5. Act as the projection reader.
set role foreverdb_projection_reader;

do $t$
declare
    n bigint;
    denied boolean;
    t text;
begin
    select count(*) into n from publication_export.export_drops_v1();
    if n = 0 then raise exception 'FAIL: reader got no drops'; end if;

    foreach t in array array['public.installations', 'public.installation_source_stats',
                             'public.installation_item_stats', 'public.installation_location_stats',
                             'public.installation_guilds', 'public.installation_guild_members',
                             'public.installation_guild_professions', 'public.map_asset_diagnostics',
                             'public.items', 'public.sources', 'private.foreverdb_api_budgets'] loop
        denied := false;
        begin
            execute format('select 1 from %s limit 1', t);
        exception when insufficient_privilege then denied := true;
        end;
        if not denied then raise exception 'FAIL: projection reader can read %', t; end if;
    end loop;

    -- No private identifiers or Guildbook canaries anywhere in any export.
    select count(*) into n from (
        select row_to_json(r)::text j from publication_export.export_sources_v1() r
        union all select row_to_json(r)::text from publication_export.export_items_v1() r
        union all select row_to_json(r)::text from publication_export.export_buckets_v1() r
        union all select row_to_json(r)::text from publication_export.export_drops_v1() r
        union all select row_to_json(r)::text from publication_export.export_locations_v1(1.0) r
        union all select row_to_json(r)::text from publication_export.export_meta_v1() r
    ) all_rows
    where j ilike '%synthetic-installation%' or j like '%CANARY%' or j like '%00000000-0000-4000%';
    if n <> 0 then raise exception 'FAIL: % export rows contain private identifiers', n; end if;

    raise notice 'PASS: projection reader is export-only and leaks no private identifiers';
end
$t$;

reset role;
