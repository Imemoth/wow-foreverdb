-- AzerDex News health check schedule. OWNER/OPERATOR, apply only after 0018_news_health_monitoring.sql and ONLY with
-- explicit owner approval (it adds one pg_cron job and changes nothing else). The job FAILS (visible in
-- cron.job_run_details) when a source is in a critical state; "no new Blizzard posts" never fails it.
-- A failing run is the alert signal: see docs/web/news-collector-v2.md for the alerting policy.

select cron.unschedule(jobid) from cron.job where jobname = 'azerdex-news-health';
select cron.schedule('azerdex-news-health', '*/15 * * * *', $$select private.azerdex_news_assert_healthy()$$);
