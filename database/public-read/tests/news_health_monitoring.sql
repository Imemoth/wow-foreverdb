-- Requires migration 0011 and database/ops/0018_news_health_monitoring.sql, plus cron/net (real extensions on Supabase,
-- stand-ins locally). Transactional: everything is rolled back.
begin;

create function pg_temp.state(p_key text) returns text language sql as
$$ select x ->> 'state' from jsonb_array_elements(private.azerdex_news_health() -> 'sources') x where x ->> 'sourceKey' = p_key $$;
create function pg_temp.severity(p_key text) returns text language sql as
$$ select x ->> 'severity' from jsonb_array_elements(private.azerdex_news_health() -> 'sources') x where x ->> 'sourceKey' = p_key $$;

do $t$
declare
    v_job bigint;
    r text;
begin
    insert into cron.job (jobname, schedule, command) values ('azerdex-news-blueposts', '*/10 * * * *', 'x') returning jobid into v_job;
    insert into pub.news_sources (source_key, source_type, region, endpoint_url) values
        ('h-ok', 'bluepost', 'us', 'https://example.com/a');

    -- (1) Healthy collector, Blizzard published nothing relevant for 9 days: NOT a failure.
    update pub.news_sources set last_attempt_at = now() - interval '4 minutes', last_fetch_ok_at = now() - interval '4 minutes',
           last_official_post_at = now() - interval '9 days' where source_key = 'h-ok';
    insert into cron.job_run_details (jobid, status, start_time) values (v_job, 'succeeded', now() - interval '4 minutes');
    assert pg_temp.state('h-ok') = 'healthy_no_new_content' and pg_temp.severity('h-ok') = 'ok', 'zero new posts must not be a failure';
    perform private.azerdex_news_assert_healthy();
    raise notice 'PASS: healthy collector with no new official content is not an alert';

    -- (2) Reachable, everything correctly rejected: informational.
    insert into pub.news_sync_runs (source_key, status, finished_at, fetched_count, accepted_count, rejected_count)
    values ('h-ok', 'succeeded', now(), 20, 0, 20);
    assert pg_temp.state('h-ok') = 'all_rejected' and pg_temp.severity('h-ok') = 'info', 'all-rejected must be informational';
    perform private.azerdex_news_assert_healthy();
    raise notice 'PASS: all-rejected is informational and never raises';
    delete from pub.news_sync_runs where source_key = 'h-ok';

    -- (3) Fetch failing: three consecutive failed runs.
    insert into pub.news_sync_runs (source_key, status, finished_at, error, error_category)
    select 'h-ok', 'failed', now(), 'source_http_503', 'http_503' from generate_series(1, 3);
    assert pg_temp.state('h-ok') = 'fetch_failing' and pg_temp.severity('h-ok') = 'critical', 'three consecutive failures must be critical';
    begin perform private.azerdex_news_assert_healthy(); raise exception 'assert_healthy must raise';
    exception when sqlstate 'P0001' then null; end;
    -- two failures are tolerated (transient 503 blips happened in production on Oct 27 and Oct 30)
    delete from pub.news_sync_runs where id = (select max(id) from pub.news_sync_runs where source_key = 'h-ok');
    assert pg_temp.severity('h-ok') <> 'critical', 'a transient failure pair must not alert';
    raise notice 'PASS: fetch failures alert only when repeated';
    delete from pub.news_sync_runs where source_key = 'h-ok';

    -- (5) Collector stopped: scheduler not running.
    update pub.news_sources set last_attempt_at = now() - interval '3 hours', last_fetch_ok_at = now() - interval '3 hours' where source_key = 'h-ok';
    delete from cron.job_run_details; insert into cron.job_run_details (jobid, status, start_time) values (v_job, 'succeeded', now() - interval '3 hours');
    assert pg_temp.state('h-ok') = 'collector_stopped' and (private.azerdex_news_health() -> 'sources' -> 0 -> 'causes') ? 'scheduler_not_running', 'stopped scheduler not identified';

    -- (5b) Scheduler runs but the function rejects requests (401/403/404/5xx).
    insert into cron.job_run_details (jobid, status, start_time) values (v_job, 'succeeded', now() - interval '2 minutes');
    delete from net._http_response; insert into net._http_response (status_code, created) values (401, now() - interval '3 minutes');
    assert pg_temp.state('h-ok') = 'collector_stopped' and (private.azerdex_news_health() -> 'sources' -> 0 -> 'causes') ? 'function_rejecting_requests', 'rejecting function not identified';

    -- (4) Fetched but persistence failing: the function answers 207 and no run reaches the database.
    delete from net._http_response; insert into net._http_response (status_code, created) values (207, now() - interval '3 minutes');
    assert pg_temp.state('h-ok') = 'persistence_failing' and pg_temp.severity('h-ok') = 'critical', 'persistence failure not identified';
    raise notice 'PASS: stopped scheduler, rejecting function and persistence failure are distinguished';

    -- recover
    update pub.news_sources set last_attempt_at = now(), last_fetch_ok_at = now() where source_key = 'h-ok';
    delete from net._http_response;

    -- (6) Data exists but the website cannot show it: a published reply without provenance is hidden by the fail-closed view.
    insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug, canonical_url, title,
            region, published_at, category, relevance, status, content_hash)
    values ('h-ok', 'post:hidden', 'topic:1', 5, 'us:topic:1', 'hidden-reply', 'https://example.com/t/1/5', 'WoW Forever hidden', 'us',
            now() - interval '1 day', 'bluepost', 'relevant', 'published', repeat('a', 64));
    assert pg_temp.state('h-ok') = 'display_gap' and pg_temp.severity('h-ok') = 'warning', 'published-but-invisible rows must be reported';
    perform private.azerdex_news_assert_healthy();  -- a warning never pages
    delete from pub.news_entries where source_entry_id = 'post:hidden';
    raise notice 'PASS: published-but-hidden rows are reported as a display gap (warning)';

    -- (7) Revision tracking missed a topic.
    insert into pub.news_tracked_topics (source_key, topic_id, next_check_at, last_official_at) values ('h-ok', 'topic:5', now() - interval '20 hours', now());
    assert pg_temp.state('h-ok') = 'revision_stale' and pg_temp.severity('h-ok') = 'warning', 'overdue topic must warn';
    update pub.news_tracked_topics set next_check_at = now() - interval '60 hours' where topic_id = 'topic:5';
    assert pg_temp.severity('h-ok') = 'critical', 'a topic overdue by 48h+ must be critical';
    raise notice 'PASS: missed revision tracking warns, then escalates after 48 hours';

    -- Never exposes secrets: the report only contains counts, codes and timestamps.
    r := private.azerdex_news_health()::text;
    assert r !~* '(secret|password|authorization|x-azerdex|postgresql://)', 'health report must not contain credentials';
    -- Privileges: only the platform admin may call the monitoring functions.
    assert not has_function_privilege('public', 'private.azerdex_news_health()', 'execute'), 'PUBLIC can read the health report';
    assert not has_function_privilege('foreverdb_web_reader', 'private.azerdex_news_health()', 'execute'), 'web reader can read the health report';
    assert not has_function_privilege('azerdex_news_ingest', 'private.azerdex_news_assert_healthy()', 'execute'), 'ingest role can run the health check';
    raise notice 'PASS: monitoring exposes no credentials and is not reachable by API roles';
end
$t$;

rollback;
