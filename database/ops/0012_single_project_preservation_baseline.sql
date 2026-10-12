-- ForeverDB Account V1: single-project preservation baseline (read-only).
-- Run before and after migration 0012 and compare row counts + checksums.
-- No writes, DDL, explicit row locks, user identifiers or tokens in output.
-- A hash here is an integrity fingerprint, NOT a database backup.
WITH owners AS (
 SELECT count(*) AS installations,
        count(*) FILTER (WHERE owner_user_id IS NULL) AS ownerless_installations,
        md5(coalesce(string_agg(md5(to_jsonb(i)::text), '|' ORDER BY md5(to_jsonb(i)::text)), 'empty')) AS installation_rows_md5
 FROM public.installations AS i
), guilds AS (
 SELECT count(*) AS guild_rows,
        md5(coalesce(string_agg(md5(to_jsonb(g)::text), '|' ORDER BY md5(to_jsonb(g)::text)), 'empty')) AS guild_rows_md5
 FROM public.installation_guilds AS g
), members AS (
 SELECT count(*) AS guild_member_rows,
        md5(coalesce(string_agg(md5(to_jsonb(m)::text), '|' ORDER BY md5(to_jsonb(m)::text)), 'empty')) AS guild_member_rows_md5
 FROM public.installation_guild_members AS m
)
SELECT
 (SELECT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE name='fix_observed_drop_rate_denominator')) AS ledger_0011_present,
 (SELECT EXISTS(SELECT 1 FROM supabase_migrations.schema_migrations WHERE name='account_ownership_claims')) AS ledger_0012_present,
 to_regprocedure('private.foreverdb_take_budget(text,integer,integer)') IS NOT NULL AS budget_present,
 to_regprocedure('private.foreverdb_api_gate(text)') IS NOT NULL AS api_gate_present,
 to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)') IS NOT NULL AS ingest_impl_present,
 to_regprocedure('public.ingest_foreverdb_snapshot_auth(jsonb)') IS NOT NULL AS ingest_rpc_present,
 to_regprocedure('extensions.digest(text,text)') IS NOT NULL AS digest_present,
 (SELECT count(*) FROM auth.users WHERE is_anonymous IS FALSE) AS registered_users,
 (SELECT count(*) FROM auth.users WHERE is_anonymous IS TRUE) AS anonymous_users,
 owners.*, guilds.*, members.*
FROM owners CROSS JOIN guilds CROSS JOIN members;
