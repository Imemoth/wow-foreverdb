-- Run AFTER 0007_restrict_legacy_public_stats.sql, ideally BEFORE
-- COMMIT in the same transaction as the REVOKE during production rollout.
-- No persistent writes are performed by this script.
do $$
begin
  if has_table_privilege('anon', 'public.observed_loot_stats', 'SELECT')
     or has_table_privilege('authenticated', 'public.observed_loot_stats', 'SELECT') then
    raise exception 'FAIL: legacy view must not be directly selectable via anon or authenticated';
  end if;
  if not has_table_privilege('service_role', 'public.observed_loot_stats', 'SELECT') then
    raise exception 'FAIL: privileged compatibility grant changed';
  end if;
  if not (has_table_privilege('anon', 'public.items', 'SELECT')
      and has_table_privilege('anon', 'public.sources', 'SELECT')
      and has_table_privilege('authenticated', 'public.items', 'SELECT')
      and has_table_privilege('authenticated', 'public.sources', 'SELECT')) then
    raise exception 'FAIL: public catalog search grants changed';
  end if;
  if not (has_function_privilege('anon', 'public.get_foreverdb_search_zones()', 'EXECUTE')
      and has_function_privilege('anon', 'public.get_foreverdb_search_in_zone(text,bigint,text)', 'EXECUTE')
      and has_function_privilege('anon', 'public.get_foreverdb_item_stats(bigint)', 'EXECUTE')
      and has_function_privilege('anon', 'public.get_foreverdb_source_stats(text,bigint,integer)', 'EXECUTE')
      and has_function_privilege('anon', 'public.get_foreverdb_item_locations(bigint)', 'EXECUTE')
      and has_function_privilege('anon', 'public.get_foreverdb_source_locations(text,bigint,integer)', 'EXECUTE')) then
    raise exception 'FAIL: anonymous read/search RPC changed';
  end if;
  if not (has_function_privilege('authenticated', 'public.get_foreverdb_search_zones()', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.get_foreverdb_search_in_zone(text,bigint,text)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.get_foreverdb_item_stats(bigint)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.get_foreverdb_source_stats(text,bigint,integer)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.get_foreverdb_item_locations(bigint)', 'EXECUTE')
      and has_function_privilege('authenticated', 'public.get_foreverdb_source_locations(text,bigint,integer)', 'EXECUTE')) then
    raise exception 'FAIL: authenticated read/search RPC changed';
  end if;
  if has_function_privilege('anon', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'EXECUTE')
      or not has_function_privilege('authenticated', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'EXECUTE') then
    raise exception 'FAIL: authenticated ingestion boundary changed';
  end if;
  if has_table_privilege('anon', 'public.installation_item_stats', 'SELECT')
      or has_table_privilege('anon', 'public.installation_source_stats', 'SELECT')
      or has_table_privilege('anon', 'public.installation_location_stats', 'SELECT')
      or has_table_privilege('authenticated', 'public.installation_item_stats', 'SELECT')
      or has_table_privilege('authenticated', 'public.installation_source_stats', 'SELECT')
      or has_table_privilege('authenticated', 'public.installation_location_stats', 'SELECT') then
    raise exception 'FAIL: raw observation tables exposed directly';
  end if;
  raise notice 'PASS: direct legacy view access closed; search/stats/location and sync grants intact';
end $$;

-- Post-commit checks must also exercise the live Data API with BOTH:
-- (1) anon API key; (2) a real anonymous Auth-user JWT (DB role authenticated).
-- GET /rest/v1/observed_loot_stats?select=*&limit=1 must reject both.
-- Current anonymous RPC contract remains intentionally available.
-- No new public external integration endpoint is introduced.
