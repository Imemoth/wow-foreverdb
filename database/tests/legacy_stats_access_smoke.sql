-- Run AFTER database/migrations/0007_restrict_legacy_public_stats.sql.
-- Permission-focused smoke gate; does not mutate the database.
do $$
begin
  if has_table_privilege('anon', 'public.observed_loot_stats', 'SELECT') then
    raise exception 'FAIL: anon still reads legacy observed_loot_stats';
  end if;
  if not has_table_privilege('authenticated', 'public.observed_loot_stats', 'SELECT') then
    raise exception 'FAIL: authenticated lost legacy view compatibility';
  end if;
  if not (has_table_privilege('anon', 'public.items', 'SELECT')
      and has_table_privilege('anon', 'public.sources', 'SELECT')) then
    raise exception 'FAIL: anonymous catalog search changed';
  end if;
  if not (has_function_privilege('anon', 'public.get_foreverdb_search_zones()', 'EXECUTE')
      and has_function_privilege('anon', 'public.get_foreverdb_search_in_zone(text,bigint,text)', 'EXECUTE')
      and has_function_privilege('anon', 'public.get_foreverdb_item_stats(bigint)', 'EXECUTE')
      and has_function_privilege('anon', 'public.get_foreverdb_source_stats(text,bigint,integer)', 'EXECUTE')
      and has_function_privilege('anon', 'public.get_foreverdb_item_locations(bigint)', 'EXECUTE')
      and has_function_privilege('anon', 'public.get_foreverdb_source_locations(text,bigint,integer)', 'EXECUTE')) then
    raise exception 'FAIL: public Companion detail/search RPC changed';
  end if;
  if has_function_privilege('anon', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'EXECUTE')
      or not has_function_privilege('authenticated', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'EXECUTE') then
    raise exception 'FAIL: authenticated ingestion boundary changed';
  end if;
  if has_table_privilege('anon', 'public.installation_item_stats', 'SELECT')
      or has_table_privilege('anon', 'public.installation_source_stats', 'SELECT')
      or has_table_privilege('anon', 'public.installation_location_stats', 'SELECT') then
    raise exception 'FAIL: anonymous access to installation raw observations';
  end if;
  raise notice 'PASS: legacy view restricted; Companion read RPCs/catalog and sync grants preserved';
end $$;

-- Optional integration gates using real anon/auth JWTs (PostgREST):
-- anon GET /rest/v1/observed_loot_stats?select=*&limit=1 => 401/403
-- authenticated GET same => 200
-- anon GET /rest/v1/items?select=item_id,name&limit=1 => 200
-- anon GET /rest/v1/sources?select=source_type,source_id,source_level,name&limit=1 => 200
-- anon POST /rest/v1/rpc/get_foreverdb_item_stats {"p_item_id":117} => 200
-- anon POST /rest/v1/rpc/get_foreverdb_search_zones {} => 200
-- authenticated POST /rest/v1/rpc/ingest_foreverdb_snapshot_auth => existing valid owner snapshot only;
-- never use a fabricated production snapshot for an authorization test.
