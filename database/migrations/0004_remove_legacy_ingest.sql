-- Finalize the migration away from the legacy shared ingest token.
-- The authenticated Companion path must already be validated before this runs.

revoke all on function public.ingest_foreverdb_snapshot(text, jsonb)
from public, anon, authenticated;

drop function if exists public.ingest_foreverdb_snapshot(text, jsonb);

drop table if exists private.foreverdb_settings;

-- This helper is not part of the ForeverDB client API.
revoke all on function public.rls_auto_enable()
from public, anon, authenticated;
