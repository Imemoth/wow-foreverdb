-- OWNER-RUN. Stops scheduled invocations (the kill switch in database/rollback/0015_kill_switch.sql is the faster, preferred first step).
select cron.unschedule('azerdex-welcome-worker') where exists (select 1 from cron.job where jobname = 'azerdex-welcome-worker');
select cron.unschedule('azerdex-welcome-prune') where exists (select 1 from cron.job where jobname = 'azerdex-welcome-prune');

-- TEARDOWN ONLY (staging deletion / decommissioning): remove the Vault copies of the invocation secret and URL. Run this deliberately, after the
-- two statements above; the scheduler cannot work without them. Rotation (not teardown) uses vault.update_secret instead (runbook §6).
-- delete from vault.secrets where name in ('azerdex_worker_secret', 'azerdex_worker_url');
