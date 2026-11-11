-- Rollback for 0018_schedule_news_health_check.sql (removes only the health-check job).
select cron.unschedule(jobid) from cron.job where jobname = 'azerdex-news-health';
