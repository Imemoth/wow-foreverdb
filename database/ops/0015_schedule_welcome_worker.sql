-- OWNER-RUN, MANUAL, NOT A MIGRATION. Schedules the AzerDex welcome worker with Supabase Cron (pg_cron + pg_net), authenticated by a
-- shared secret held in Supabase Vault. Run ONLY on an approved project (hosted staging first), after:
--   1. migration 0015 is applied (kill switches OFF),  2. the Edge Function `azerdex-welcome-worker` is deployed with its secrets,
--   3. extensions pg_cron, pg_net and supabase_vault are enabled.
-- The secret VALUE never appears in this file, in git, or on a command line (a command-line argument is visible in the process list):
-- it is read from the file /dev/shm/azerdex_worker_secret (umask 077, created in runbook §2) by psql itself. Only the non-secret URL is a -v variable:
--   psql "$DB_URL" -v fn_url="https://<ref>.supabase.co/functions/v1/azerdex-welcome-worker" -f this.sql
-- NOTE: secrets are created only if absent. To ROTATE, use vault.update_secret (runbook §6), not this script.
\set worker_secret `cat /dev/shm/azerdex_worker_secret`
-- Refuse to run with a missing/short secret (a failed `cat` yields an empty string, which Vault would happily store).
select (length(:'worker_secret') >= 32) as secret_ok \gset
\if :secret_ok
\else
\echo 'refusing: /dev/shm/azerdex_worker_secret is missing or shorter than 32 characters'
\quit 1
\endif
-- NOTE: the secret value is part of the SQL text sent to the server. On a self-managed server with log_statement=all (or an error that logs
-- the statement) it could reach the server log; Supabase-hosted projects do not log statement text by default. Check log settings first.
-- Scheduling does NOT start sending: the worker flag AZERDEX_WELCOME_ENABLED and both database switches must also be ON (runbook §5).
\set ON_ERROR_STOP on
begin;
select vault.create_secret(:'worker_secret', 'azerdex_worker_secret', 'AzerDex welcome worker invocation secret (rotate per runbook)')
 where not exists (select 1 from vault.secrets where name = 'azerdex_worker_secret');
select vault.create_secret(:'fn_url', 'azerdex_worker_url', 'AzerDex welcome worker URL')
 where not exists (select 1 from vault.secrets where name = 'azerdex_worker_url');

select cron.schedule(
  'azerdex-welcome-worker',
  '* * * * *',
  $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'azerdex_worker_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-azerdex-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'azerdex_worker_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000);
  $job$);
-- Daily retention (bounded, never touches outbox rows):
select cron.schedule('azerdex-welcome-prune', '17 3 * * *', $$ select private.azerdex_welcome_prune(); $$);
commit;
