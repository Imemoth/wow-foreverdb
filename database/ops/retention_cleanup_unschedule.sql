-- AzerDex retention cleanup: UNSCHEDULE (kill switch). OWNER-RUN, MANUAL. Removes only the two jobs; deletes no data and drops nothing.
-- The run log and the functions stay so the history remains readable and the cleanup can be re-enabled or run by hand.
\set ON_ERROR_STOP on
select cron.unschedule(jobid) from cron.job where jobname in ('azerdex-retention-run', 'azerdex-retention-check');
