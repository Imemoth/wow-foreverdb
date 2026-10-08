-- Legacy aggregated view is not part of the supported Companion API.
-- Search uses sources/items and get_foreverdb_search_* RPCs.
-- Stats/location details use get_foreverdb_*_stats/locations RPCs.
-- Authenticated snapshot ingest uses ingest_foreverdb_snapshot_auth(jsonb).
-- Keep the view and authenticated SELECT for compatibility; close anonymous access.
--
-- Important: a PostgreSQL view normally executes with the owner's privileges.
-- Do not substitute security_invoker=true without separately validating RLS.
-- A future removal of the view requires another compatibility review.
--
-- Revoking from PUBLIC matters: a PUBLIC grant otherwise overrides the anon revoke.
revoke select on table public.observed_loot_stats from public, anon;
grant select on table public.observed_loot_stats to authenticated;

-- Deliberately do not alter:
-- public.sources / public.items SELECT (search)
-- get_foreverdb_* RPC EXECUTE (search, stats, locations)
-- ingest_foreverdb_snapshot_auth(jsonb) EXECUTE (authenticated sync)
-- private schema functions or installation-level RLS.
