-- AzerDex retention cleanup: read-only monitoring. OWNER/OPERATOR. Counts and codes only; nothing here selects a personal value.

-- 1. Last 12 runs, one line per task (status ok | error | skipped_locked | skipped_missing; more_pending = capped, drains next run).
select run_id, started_at, task, status, dry_run, row_count, batches, more_pending, sqlstate, error_message
  from private.retention_run_log order by id desc limit 48;

-- 2. Health: raises (and so is visible as a failed job) when the last real run failed or is stale.
select private.azerdex_retention_assert_healthy();

-- 3. What the next real run WOULD delete, without deleting (dry run; logged with dry_run = true and ignored by the health check).
select private.azerdex_retention_run(p_dry_run := true);

-- 4. pg_cron's own history for the two jobs (a `failed` row here is the failure signal for the check job).
select j.jobname, d.status, d.start_time, d.end_time, left(d.return_message, 120) as message
  from cron.job_run_details d join cron.job j using (jobid)
 where j.jobname in ('azerdex-retention-run', 'azerdex-retention-check') order by d.start_time desc limit 20;
