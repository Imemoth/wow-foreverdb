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
revoke select on table public.observed_loot_stats
from public, anon, authenticated;
