-- Run only after the authenticated companion sync has been validated.

revoke all on function public.ingest_foreverdb_snapshot(text, jsonb)
from public, anon, authenticated;

drop function if exists public.ingest_foreverdb_snapshot(text, jsonb);

delete from private.foreverdb_settings
where key = 'ingest_token';
