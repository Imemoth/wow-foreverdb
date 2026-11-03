-- AzerDex retention cleanup: SCHEDULE. OWNER-RUN, MANUAL, NOT A MIGRATION, NOT APPLIED ANYWHERE.
-- Needs separate, explicit owner authorization (it changes a production database). Run only after retention_cleanup_install.sql is
-- applied AND `select private.azerdex_retention_run(p_dry_run := true);` has been reviewed on the target project.
-- Requires the pg_cron extension (already enabled for azerdex-welcome-worker). No secret is involved: both jobs are plain SQL.
--
--   azerdex-retention-run     03:37 UTC daily  bounded cleanup (max 5 x 100 rows per task per run; a backlog drains over successive days)
--   azerdex-retention-check   04:07 UTC daily  read-only health check; it RAISES when the last run failed or is >36 h old, so the failure
--                                              is visible as `failed` in cron.job_run_details (Supabase dashboard > Integrations > Cron)
-- Re-running this file updates the two jobs by name; it never creates duplicates. Undo: retention_cleanup_unschedule.sql.
\set ON_ERROR_STOP on
begin;
select cron.schedule('azerdex-retention-run', '37 3 * * *', $$ select private.azerdex_retention_run(); $$);
select cron.schedule('azerdex-retention-check', '7 4 * * *', $$ select private.azerdex_retention_assert_healthy(); $$);
commit;
