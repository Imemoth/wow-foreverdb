-- AzerDex Operations Bot: read-only health report for the protected reporting endpoint (Gate C).
-- OWNER/OPERATOR, run as the platform `postgres` admin on the azerdex-public-read project AFTER migration 0011 and
-- database/ops/0018_news_health_monitoring.sql. NOT applied by the repository: it needs the owner's explicit approval.
--
-- It adds exactly ONE schema (`ops_report`), ONE function (`ops_report.health()`) and ONE login role (`azerdex_ops_reporter`).
-- It adds no table, no cron job and no grant on anything that already exists, and it does not touch jobs 3 to 7, the G2 functions
-- (`private.azerdex_news_health()`, `private.azerdex_news_assert_healthy()`) or any other object. Roll back with
-- 0019_ops_health_report_rollback.sql.
--
-- WHAT THE FUNCTION RETURNS: the "health report contract v1" that the Ops Bot validates with `.strict()` (ops-bot/src/health/contract.ts):
-- counts, stable codes and timestamps per source, plus the state of the G6 job (`azerdex-news-health`, from cron.job and
-- cron.job_run_details). Fields are copied from the G2 report by NAME (an allow-list), never passed through, so nothing the G2 function
-- may add later can leak. Codes are lower-cased and anything outside the contract's code alphabet becomes `unclassified`.
-- It never returns post text, URLs, player, character, guild or account data, request headers, secrets or error messages.
--
-- FAIL CLOSED: if the G2 function raises, if it reports no source, or if it reports an unknown severity, `health()` RAISES (the endpoint
-- turns that into HTTP 503 and the bot shows UNKNOWN). It never invents a healthy answer. A missing G6 job is reported as
-- present=false (valid data: the bot raises that as its own critical state), not as an error.
--
-- BOUNDED: STABLE (cannot write), statement_timeout 5 s on the function, at most 16 sources, fixed-size output.
--
-- ACCESS: SECURITY DEFINER, owner postgres, search_path = pg_catalog. EXECUTE only for `azerdex_ops_reporter`; USAGE on the new schema only
-- for that role. The role has NO table, sequence or other function privilege, belongs to no role, is not superuser / createdb /
-- createrole / bypassrls, and has no password in this file: the owner sets one out of band (see docs/ops-bot/supabase-reporting-contract.md).

begin;

create schema if not exists ops_report;
revoke all on schema ops_report from public, anon, authenticated, service_role;

do $do$
begin
    if not exists (select 1 from pg_roles where rolname = 'azerdex_ops_reporter') then
        create role azerdex_ops_reporter login nosuperuser nocreatedb nocreaterole noinherit nobypassrls connection limit 3;
    end if;
end
$do$;
-- Defence in depth for the role's own sessions (the real barrier is that it holds no privileges beyond one function).
alter role azerdex_ops_reporter set statement_timeout = '5s';
alter role azerdex_ops_reporter set lock_timeout = '2s';
alter role azerdex_ops_reporter set idle_in_transaction_session_timeout = '5s';
alter role azerdex_ops_reporter set default_transaction_read_only = on;
alter role azerdex_ops_reporter set search_path = pg_catalog;

create or replace function ops_report.health()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog
set statement_timeout = '5s'
as $$
declare
    v_now timestamptz := now();
    v_g2 jsonb := private.azerdex_news_health();
    v_sources jsonb := '[]'::jsonb;
    v_src jsonb;
    v_cause text;
    v_causes jsonb;
    v_state text;
    v_sev text;
    v_worst integer := 0;
    v_overall text;
    v_job_id bigint;
    v_job_schedule text;
    v_job_active boolean;
    v_last_at timestamptz;
    v_last_status text;
    v_last_ok timestamptz;
    v_g6 jsonb;
    v_count integer := 0;
begin
    for v_src in select value from jsonb_array_elements(coalesce(v_g2 -> 'sources', '[]'::jsonb)) limit 16 loop
        v_count := v_count + 1;
        v_sev := v_src ->> 'severity';
        if v_sev is null or v_sev not in ('ok', 'info', 'warning', 'critical') then
            raise exception 'ops_report: unexpected severity in the G2 report' using errcode = 'P0001';
        end if;
        v_state := lower(coalesce(v_src ->> 'state', ''));
        if v_state !~ '^[a-z0-9][a-z0-9_:.-]{0,79}$' then v_state := 'unclassified'; end if;

        v_causes := '[]'::jsonb;
        for v_cause in select lower(c) from jsonb_array_elements_text(coalesce(v_src -> 'causes', '[]'::jsonb)) c limit 8 loop
            v_causes := v_causes || to_jsonb(case when v_cause ~ '^[a-z0-9][a-z0-9_:.-]{0,79}$' then v_cause else 'unclassified' end);
        end loop;

        v_worst := greatest(v_worst, case v_sev when 'critical' then 3 when 'warning' then 2 when 'info' then 1 else 0 end);
        v_sources := v_sources || jsonb_build_object(
            'sourceKey', v_src ->> 'sourceKey',
            'state', v_state,
            'severity', v_sev,
            'causes', v_causes,
            'lastAttemptAt', v_src -> 'lastAttemptAt',
            'lastFetchOkAt', v_src -> 'lastFetchOkAt',
            'minutesSinceAttempt', case when v_src ->> 'minutesSinceAttempt' is null then null
                                        else least(greatest((v_src ->> 'minutesSinceAttempt')::numeric, 0), 10000000)::bigint end,
            'consecutiveFailures', least(greatest(coalesce((v_src ->> 'consecutiveFailures')::numeric, 0), 0), 1000000)::bigint,
            'overdueTopics', least(greatest(coalesce((v_src ->> 'overdueTopics')::numeric, 0), 0), 1000000)::bigint);
    end loop;

    if v_count = 0 then
        raise exception 'ops_report: the G2 report contains no source' using errcode = 'P0001';
    end if;
    v_overall := case v_worst when 3 then 'critical' when 2 then 'warning' when 1 then 'info' else 'ok' end;

    -- G6: the scheduled assertion job. Read as the function owner (the job's own user), so the row-level security on cron.job applies correctly.
    select j.jobid, left(j.schedule, 40), coalesce(j.active, true)
      into v_job_id, v_job_schedule, v_job_active
      from cron.job j where j.jobname = 'azerdex-news-health' order by j.jobid limit 1;
    if v_job_id is null then
        v_g6 := jsonb_build_object('jobName', 'azerdex-news-health', 'present', false, 'active', false, 'schedule', null,
                                   'lastRunAt', null, 'lastRunStatus', null, 'lastSucceededAt', null);
    else
        select d.start_time, d.status into v_last_at, v_last_status
          from cron.job_run_details d where d.jobid = v_job_id and d.start_time > v_now - interval '7 days'
         order by d.start_time desc limit 1;
        select max(d.start_time) into v_last_ok
          from cron.job_run_details d where d.jobid = v_job_id and d.status = 'succeeded' and d.start_time > v_now - interval '7 days';
        v_g6 := jsonb_build_object('jobName', 'azerdex-news-health', 'present', true, 'active', v_job_active, 'schedule', v_job_schedule,
            'lastRunAt', v_last_at,
            'lastRunStatus', case when v_last_at is null then null
                                  when v_last_status = 'succeeded' then 'succeeded'
                                  when v_last_status = 'failed' then 'failed'
                                  when v_last_status in ('starting', 'running', 'sending', 'connecting') then 'running'
                                  else 'unknown' end,
            'lastSucceededAt', v_last_ok);
    end if;

    return jsonb_build_object('schemaVersion', 1, 'generatedAt', v_now, 'overall', v_overall, 'sources', v_sources, 'g6', v_g6);
end;
$$;

revoke all on function ops_report.health() from public, anon, authenticated, service_role;
grant usage on schema ops_report to azerdex_ops_reporter;
grant execute on function ops_report.health() to azerdex_ops_reporter;

commit;
