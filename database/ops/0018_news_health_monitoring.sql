-- AzerDex News Collector V2: ingestion health classification. OWNER/OPERATOR (run as the platform `postgres` admin
-- on the azerdex-public-read project AFTER migration 0011). Read-only: it creates two functions in the private schema and
-- changes no data. Counts, codes and timestamps only; no secret, header, URL query or credential is read or returned.
--
-- It separates the seven situations that the V1 pipeline could not tell apart:
--   healthy_no_new_content  (1) healthy, Blizzard simply published nothing relevant      -> info, NEVER an alert
--   all_rejected            (2) sources reachable, every fetched entry correctly rejected -> info
--   fetch_failing           (3) the collector cannot fetch the source                     -> critical after 3 consecutive failed runs
--   persistence_failing     (4) data was fetched but could not be persisted                -> critical
--   collector_stopped       (5) nothing is executing (scheduler stopped or function rejecting requests) -> critical
--   display_gap             (6) published rows exist that the website cannot show          -> warning
--   revision_stale          (7) tracked official topics were not re-checked on time        -> warning, critical after 48 h
-- Zero new posts is never a failure by itself.

begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.azerdex_news_health()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
as $$
declare
    v_snap jsonb := pub_admin.news_health_snapshot();
    v_now timestamptz := now();
    v_sources jsonb := '[]'::jsonb;
    s jsonb;
    v_job text;
    v_expect interval;
    v_cron_ok timestamptz;
    v_cron_failed timestamptz;
    v_net_2xx integer;
    v_net_207 integer;
    v_net_bad integer;
    v_net_last_bad integer;
    v_state text;
    v_severity text;
    v_causes text[];
    v_attempt timestamptz;
    v_fetch_ok timestamptz;
    v_recent jsonb;
    v_hidden integer;
    v_rank integer := 0;
    v_worst integer := 0;
begin
    -- pg_net response history is shared with other jobs and retained only for a few hours: it is used solely to EXPLAIN a stale
    -- collector (rejecting vs unreachable vs persistence), never to declare health.
    select count(*) filter (where status_code between 200 and 299 and status_code <> 207),
           count(*) filter (where status_code = 207),
           count(*) filter (where status_code is null or status_code >= 300 and status_code <> 207 or timed_out is true)
      into v_net_2xx, v_net_207, v_net_bad
      from net._http_response where created > v_now - interval '2 hours';
    select status_code into v_net_last_bad
      from net._http_response where created > v_now - interval '2 hours' and (status_code is null or status_code >= 300 and status_code <> 207)
      order by created desc limit 1;

    for s in select value from jsonb_array_elements(v_snap -> 'sources') loop
        v_job := case when s ->> 'sourceType' = 'official_news' then 'azerdex-news-official' else 'azerdex-news-blueposts' end;
        v_expect := case when s ->> 'sourceType' = 'official_news' then interval '30 minutes' else interval '10 minutes' end;
        v_causes := array[]::text[];
        v_state := 'healthy_no_new_content';
        v_severity := 'ok';
        v_attempt := (s ->> 'lastAttemptAt')::timestamptz;
        v_fetch_ok := (s ->> 'lastFetchOkAt')::timestamptz;
        v_recent := s -> 'recent';

        select max(d.start_time) filter (where d.status = 'succeeded'), max(d.start_time) filter (where d.status = 'failed')
          into v_cron_ok, v_cron_failed
          from cron.job_run_details d join cron.job j on j.jobid = d.jobid
         where j.jobname = v_job and d.start_time > v_now - interval '7 days';

        if not coalesce((s ->> 'enabled')::boolean, true) then
            v_state := 'disabled';
        elsif v_attempt is null or v_attempt < v_now - 3 * v_expect then
            -- (5)/(4): the collector is not producing runs.
            if v_cron_ok is null or v_cron_ok < v_now - 3 * v_expect then
                v_state := 'collector_stopped'; v_causes := array_append(v_causes, 'scheduler_not_running');
            elsif v_net_207 > 0 and v_net_2xx = 0 then
                v_state := 'persistence_failing'; v_causes := array_append(v_causes, 'function_reports_persistence_failure');
            elsif v_net_bad > 0 then
                v_state := 'collector_stopped'; v_causes := array_append(v_causes, 'function_rejecting_requests');
            else
                v_state := 'collector_stopped'; v_causes := array_append(v_causes, 'no_run_recorded_although_scheduler_ran');
            end if;
            v_severity := 'critical';
        elsif coalesce((s ->> 'consecutiveFailures')::int, 0) >= 3
              or (v_fetch_ok is null or v_fetch_ok < v_now - 3 * v_expect) then
            v_state := 'fetch_failing'; v_severity := 'critical';
            v_causes := array_append(v_causes, coalesce(s ->> 'lastErrorCategory', 'unknown_error'));
        elsif coalesce((v_recent ->> 'fetched')::int, 0) > 0 and coalesce((v_recent ->> 'accepted')::int, 0) = 0
              and coalesce((v_recent ->> 'rejected')::int, 0) > 0 then
            v_state := 'all_rejected'; v_severity := 'info';
        end if;

        v_hidden := coalesce((s ->> 'publishedEntries')::int, 0) - coalesce((s ->> 'visibleEntries')::int, 0)
                    - coalesce((s ->> 'futureDatedEntries')::int, 0);
        if v_severity not in ('critical') and v_hidden > 0 then
            v_state := 'display_gap'; v_severity := 'warning'; v_causes := array_append(v_causes, 'published_rows_not_visible:' || v_hidden);
        end if;
        if v_severity <> 'critical' and coalesce((s ->> 'overdueTopics')::int, 0) > 0 then
            v_state := 'revision_stale';
            v_severity := case when (s ->> 'oldestOverdueAt')::timestamptz < v_now - interval '48 hours' then 'critical' else 'warning' end;
            v_causes := array_append(v_causes, 'overdue_topics:' || (s ->> 'overdueTopics'));
        end if;

        v_rank := case v_severity when 'critical' then 3 when 'warning' then 2 when 'info' then 1 else 0 end;
        v_worst := greatest(v_worst, v_rank);
        v_sources := v_sources || jsonb_build_object(
            'sourceKey', s ->> 'sourceKey', 'state', v_state, 'severity', v_severity, 'causes', to_jsonb(v_causes),
            'lastAttemptAt', v_attempt, 'lastFetchOkAt', v_fetch_ok, 'lastOfficialPostAt', s ->> 'lastOfficialPostAt',
            'minutesSinceAttempt', case when v_attempt is null then null else round(extract(epoch from (v_now - v_attempt)) / 60) end,
            'hoursSinceOfficialPost', case when s ->> 'lastOfficialPostAt' is null then null
                                           else round(extract(epoch from (v_now - (s ->> 'lastOfficialPostAt')::timestamptz)) / 3600) end,
            'lastHttpStatus', s -> 'lastHttpStatus', 'consecutiveFailures', s -> 'consecutiveFailures',
            'recent24h', v_recent, 'trackedTopics', s -> 'trackedTopics', 'overdueTopics', s -> 'overdueTopics',
            'cronLastSucceededAt', v_cron_ok, 'cronLastFailedAt', v_cron_failed);
    end loop;

    return jsonb_build_object(
        'generatedAt', v_now,
        'overall', case v_worst when 3 then 'critical' when 2 then 'warning' when 1 then 'info' else 'ok' end,
        'netLast2h', jsonb_build_object('ok', v_net_2xx, 'partial207', v_net_207, 'bad', v_net_bad, 'lastBadStatus', v_net_last_bad),
        'sources', v_sources);
end;
$$;

-- Raises (and therefore shows as a FAILED pg_cron job in cron.job_run_details) only for critical states. info/warning
-- states and "no new content" never raise.
create or replace function private.azerdex_news_assert_healthy()
returns void
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
    v_health jsonb := private.azerdex_news_health();
    v_bad text;
begin
    select string_agg((x ->> 'sourceKey') || '=' || (x ->> 'state') || coalesce('(' || nullif((x -> 'causes') ->> 0, '') || ')', ''), '; ')
      into v_bad
      from jsonb_array_elements(v_health -> 'sources') x
     where x ->> 'severity' = 'critical';
    if v_bad is not null then
        raise exception 'AzerDex News ingestion unhealthy: %', v_bad using errcode = 'P0001';
    end if;
end;
$$;

revoke all on function private.azerdex_news_health() from public, anon, authenticated;
revoke all on function private.azerdex_news_assert_healthy() from public, anon, authenticated;
grant execute on function private.azerdex_news_health() to postgres;
grant execute on function private.azerdex_news_assert_healthy() to postgres;

commit;
