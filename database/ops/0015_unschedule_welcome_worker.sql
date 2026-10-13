-- OWNER-RUN. Stops scheduled invocations (the kill switch in database/rollback/0015_kill_switch.sql is the faster, preferred first step).
select cron.unschedule('azerdex-welcome-worker') where exists (select 1 from cron.job where jobname = 'azerdex-welcome-worker');
select cron.unschedule('azerdex-welcome-prune') where exists (select 1 from cron.job where jobname = 'azerdex-welcome-prune');
