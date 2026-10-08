-- Close direct access to the legacy aggregated view while preserving Companion.
-- Live Supabase audit (2026-10-08):
--   anon SELECT = true; authenticated SELECT = true;
--   view option security_invoker=true; per-installation base tables deny
--   direct SELECT to both roles. A grant on this view alone is NOT proof that
--   either role can actually read the underlying rows.
--
-- Supabase anonymous Auth sign-ins (used by Companion sync) receive the
-- authenticated Postgres role. Revoking only from anon therefore does NOT
-- remove self-service anonymous-user access. Neither role needs direct access:
-- Companion search uses public.items / public.sources and search RPCs;
-- stats/location details use get_foreverdb_* RPCs; sync uses the separate
-- authenticated ingest_foreverdb_snapshot_auth(jsonb).
--
-- Preserve the view itself, ownership, privileged-role grants, existing
-- read-only Companion RPCs/catalog grants, and authenticated sync privileges.
-- Do not publish a new external API as part of this migration.
-- A single DO statement makes the DCL change and all contract assertions
-- atomic even if the migration runner does not explicitly wrap SQL in BEGIN.
-- Any failing assertion aborts and rolls back the REVOKE.
do $foreverdb_restrict_stats_view$
begin
  if to_regclass('public.observed_loot_stats') is null then
    raise exception 'FAIL: legacy view missing; refusing migration';
  end if;
  if not has_table_privilege('service_role', 'public.observed_loot_stats', 'SELECT') then
    raise exception 'FAIL: expected service_role grant missing before migration';
  end if;
  execute 'revoke select on table public.observed_loot_stats from public, anon, authenticated';
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
end $foreverdb_restrict_stats_view$;
