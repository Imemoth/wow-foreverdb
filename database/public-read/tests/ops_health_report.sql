-- Requires migration 0011, database/ops/0018_news_health_monitoring.sql and database/ops/0019_ops_health_report.sql, plus cron/net (real extensions
-- on Supabase, stand-ins locally). Run as the throwaway cluster's superuser (it needs catalog visibility). Transactional: everything is rolled back.
begin;
-- The harness seeds look-alikes of jobs 3 to 7; this transaction (rolled back) works on its own job rows.
delete from cron.job_run_details; delete from cron.job;

create function pg_temp.report() returns jsonb language sql as $$ select ops_report.health() $$;
create function pg_temp.src(p_key text) returns jsonb language sql as
$$ select x from jsonb_array_elements(ops_report.health() -> 'sources') x where x ->> 'sourceKey' = p_key $$;
create function pg_temp.keys(j jsonb) returns text language sql as $$ select string_agg(k, ',' order by k) from jsonb_object_keys(j) k $$;

do $t$
declare
    v_job bigint;
    v_g6 bigint;
    r jsonb;
    v_text text;
begin
    insert into cron.job (jobname, schedule, command) values ('azerdex-news-blueposts', '*/10 * * * *', 'x') returning jobid into v_job;
    insert into pub.news_sources (source_key, source_type, region, endpoint_url) values
        ('h-us', 'bluepost', 'us', 'https://example.com/a'), ('h-eu', 'bluepost', 'eu', 'https://example.com/b');
    update pub.news_sources set last_attempt_at = now() - interval '4 minutes', last_fetch_ok_at = now() - interval '4 minutes',
           last_official_post_at = now() - interval '9 days';
    insert into cron.job_run_details (jobid, status, start_time) values (v_job, 'succeeded', now() - interval '4 minutes');
    insert into cron.job (jobname, schedule, command, active) values ('azerdex-news-health', '*/15 * * * *', 'select private.azerdex_news_assert_healthy()', true) returning jobid into v_g6;
    insert into cron.job_run_details (jobid, status, start_time) values (v_g6, 'succeeded', now() - interval '7 minutes');

    -- (1) HEALTHY: the exact contract v1 shape, nothing more.
    r := pg_temp.report();
    assert pg_temp.keys(r) = 'g6,generatedAt,overall,schemaVersion,sources', 'top-level keys are not exactly the contract: ' || pg_temp.keys(r);
    assert (r ->> 'schemaVersion')::int = 1 and r ->> 'overall' = 'ok', 'healthy collector must report overall ok';
    assert jsonb_array_length(r -> 'sources') = 2, 'both sources must be reported';
    assert pg_temp.keys(pg_temp.src('h-us')) = 'causes,consecutiveFailures,lastAttemptAt,lastFetchOkAt,minutesSinceAttempt,overdueTopics,severity,sourceKey,state',
           'source keys are not exactly the contract';
    assert pg_temp.src('h-us') ->> 'state' = 'healthy_no_new_content' and pg_temp.src('h-us') ->> 'severity' = 'ok', 'zero new posts must stay healthy';
    assert pg_temp.keys(r -> 'g6') = 'active,jobName,lastRunAt,lastRunStatus,lastSucceededAt,present,schedule', 'g6 keys are not exactly the contract';
    assert r -> 'g6' ->> 'present' = 'true' and r -> 'g6' ->> 'active' = 'true' and r -> 'g6' ->> 'lastRunStatus' = 'succeeded'
       and r -> 'g6' ->> 'schedule' = '*/15 * * * *' and r -> 'g6' ->> 'jobName' = 'azerdex-news-health', 'healthy G6 job not reported';
    assert (r ->> 'generatedAt')::timestamptz > now() - interval '1 minute', 'generatedAt must be the database clock';
    raise notice 'PASS: healthy data produces exactly the contract v1 shape';

    -- (2) INFO: reachable, everything correctly rejected.
    insert into pub.news_sync_runs (source_key, status, finished_at, fetched_count, accepted_count, rejected_count) values ('h-us', 'succeeded', now(), 20, 0, 20);
    assert pg_temp.src('h-us') ->> 'severity' = 'info' and ops_report.health() ->> 'overall' = 'info', 'all-rejected must be informational';
    delete from pub.news_sync_runs where source_key = 'h-us';

    -- (3) WARNING: published rows the website cannot show.
    insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug, canonical_url, title,
            region, published_at, category, relevance, status, content_hash)
    values ('h-us', 'post:hidden', 'topic:1', 5, 'us:topic:1', 'hidden-reply', 'https://example.com/t/1/5', 'WoW Forever hidden', 'us',
            now() - interval '1 day', 'bluepost', 'relevant', 'published', repeat('a', 64));
    assert pg_temp.src('h-us') ->> 'state' = 'display_gap' and pg_temp.src('h-us') ->> 'severity' = 'warning' and ops_report.health() ->> 'overall' = 'warning',
           'a display gap must be a warning';
    assert (pg_temp.src('h-us') -> 'causes') ? 'published_rows_not_visible:1', 'warning cause code lost';
    delete from pub.news_entries where source_entry_id = 'post:hidden';
    raise notice 'PASS: info and warning severities are reported, never escalated';

    -- (4) CRITICAL: repeated fetch failures.
    insert into pub.news_sync_runs (source_key, status, finished_at, error, error_category)
    select 'h-us', 'failed', now(), 'source_http_503', 'http_503' from generate_series(1, 3);
    update pub.news_sources set last_error_category = 'http_503' where source_key = 'h-us';   -- what the collector records with a failed run
    assert pg_temp.src('h-us') ->> 'state' = 'fetch_failing' and pg_temp.src('h-us') ->> 'severity' = 'critical' and ops_report.health() ->> 'overall' = 'critical'
       and (pg_temp.src('h-us') -> 'causes') ? 'http_503' and (pg_temp.src('h-us') ->> 'consecutiveFailures')::int = 3, 'critical fetch failure not reported';
    delete from pub.news_sync_runs where source_key = 'h-us';
    raise notice 'PASS: a critical source is reported with its stable cause code';

    -- (5) STALE: nothing executing for hours (collector_stopped), and the numeric fields stay in range.
    update pub.news_sources set last_attempt_at = now() - interval '3 hours', last_fetch_ok_at = now() - interval '3 hours' where source_key = 'h-us';
    delete from cron.job_run_details where jobid = v_job; insert into cron.job_run_details (jobid, status, start_time) values (v_job, 'succeeded', now() - interval '3 hours');
    assert pg_temp.src('h-us') ->> 'state' = 'collector_stopped' and (pg_temp.src('h-us') -> 'causes') ? 'scheduler_not_running'
       and (pg_temp.src('h-us') ->> 'minutesSinceAttempt')::int between 175 and 185, 'stale collector not reported';
    update pub.news_sources set last_attempt_at = now(), last_fetch_ok_at = now() where source_key = 'h-us';
    raise notice 'PASS: a stalled collector is reported as critical with minutesSinceAttempt';

    -- (6) G6 job states.
    delete from cron.job_run_details where jobid = v_g6;
    r := ops_report.health() -> 'g6';
    assert r ->> 'present' = 'true' and r -> 'lastRunAt' = 'null'::jsonb and r -> 'lastRunStatus' = 'null'::jsonb and r -> 'lastSucceededAt' = 'null'::jsonb, 'a job that never ran must report null run fields';
    insert into cron.job_run_details (jobid, status, start_time) values (v_g6, 'succeeded', now() - interval '40 minutes'), (v_g6, 'failed', now() - interval '10 minutes');
    r := ops_report.health() -> 'g6';
    assert r ->> 'lastRunStatus' = 'failed' and (r ->> 'lastRunAt')::timestamptz > now() - interval '11 minutes' and (r ->> 'lastSucceededAt')::timestamptz < now() - interval '39 minutes', 'failed run not reported with the older success';
    insert into cron.job_run_details (jobid, status, start_time) values (v_g6, 'running', now() - interval '1 minute');
    assert ops_report.health() -> 'g6' ->> 'lastRunStatus' = 'running', 'an in-flight run must be reported as running';
    insert into cron.job_run_details (jobid, status, start_time) values (v_g6, 'something-new', now());
    assert ops_report.health() -> 'g6' ->> 'lastRunStatus' = 'unknown', 'an unknown platform status must be reported as unknown, not guessed';
    delete from cron.job_run_details where jobid = v_g6 and start_time > now() - interval '5 minutes';
    update cron.job set active = false where jobid = v_g6;
    assert ops_report.health() -> 'g6' ->> 'active' = 'false' and ops_report.health() -> 'g6' ->> 'present' = 'true', 'an inactive job must be reported as inactive';
    delete from cron.job where jobid = v_g6;
    r := ops_report.health() -> 'g6';
    assert r ->> 'present' = 'false' and r ->> 'active' = 'false' and r -> 'schedule' = 'null'::jsonb, 'a missing job must be reported as absent, not as an error';
    assert (ops_report.health() ->> 'overall') is not null, 'a missing G6 job must not break the report';
    raise notice 'PASS: G6 present/inactive/missing/never-ran/failed/running/unknown states';

    -- (7) G6 history is bounded: a run older than seven days is ignored.
    insert into cron.job (jobname, schedule, command) values ('azerdex-news-health', '*/15 * * * *', 'x') returning jobid into v_g6;
    insert into cron.job_run_details (jobid, status, start_time) values (v_g6, 'succeeded', now() - interval '9 days');
    assert ops_report.health() -> 'g6' -> 'lastRunAt' = 'null'::jsonb, 'runs older than seven days must not be reported';
    raise notice 'PASS: G6 history is bounded to seven days';
end
$t$;

-- (8) FAIL CLOSED, sanitising and allow-listing. The G2 function is replaced inside this transaction only (rolled back below).
create or replace function private.azerdex_news_health() returns jsonb language sql as $$ select '{"sources": []}'::jsonb $$;
do $t$ begin
    begin perform ops_report.health(); raise exception 'an empty G2 report must raise';
    exception when sqlstate 'P0001' then null; end;
    raise notice 'PASS: a G2 report with no source raises (fail closed), never an empty healthy report';
end $t$;

create or replace function private.azerdex_news_health() returns jsonb language sql as $$ select jsonb_build_object('sources', jsonb_build_array(
    jsonb_build_object('sourceKey', 'x-us', 'state', 'ok', 'severity', 'bogus'))) $$;
do $t$ begin
    begin perform ops_report.health(); raise exception 'an unknown severity must raise';
    exception when sqlstate 'P0001' then null; end;
    raise notice 'PASS: an unknown severity raises instead of being guessed';
end $t$;

create or replace function private.azerdex_news_health() returns jsonb language sql as $$ select jsonb_build_object('overall', 'ok', 'sources', jsonb_build_array(
    jsonb_build_object('sourceKey', 'x-us', 'state', 'Weird State!', 'severity', 'critical',
        'causes', jsonb_build_array('Http_503', 'has space', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9-dropped'),
        'lastAttemptAt', now(), 'lastFetchOkAt', null, 'minutesSinceAttempt', -5, 'consecutiveFailures', 99999999999, 'overdueTopics', null,
        'secret', 'postgresql://user:pw@host/db', 'recent24h', jsonb_build_object('title', 'WoW Forever post text'), 'lastHttpStatus', 503))) $$;
do $t$
declare r jsonb := ops_report.health(); s jsonb := r -> 'sources' -> 0; v_text text := r::text;
begin
    assert r ->> 'overall' = 'critical', 'overall must be recomputed from the sources, not copied';
    assert s ->> 'state' = 'unclassified', 'a state outside the code alphabet must become unclassified';
    assert s -> 'causes' = '["http_503", "unclassified", "c3", "c4", "c5", "c6", "c7", "c8"]'::jsonb, 'causes must be lower-cased, sanitised and capped at 8: ' || (s -> 'causes')::text;
    assert (s ->> 'minutesSinceAttempt')::int = 0 and (s ->> 'consecutiveFailures')::int = 1000000 and (s ->> 'overdueTopics')::int = 0, 'numbers must be clamped into the contract range';
    assert pg_temp.keys(s) = 'causes,consecutiveFailures,lastAttemptAt,lastFetchOkAt,minutesSinceAttempt,overdueTopics,severity,sourceKey,state', 'extra fields must be dropped by the allow-list';
    assert v_text !~* '(secret|postgresql://|WoW Forever|recent24h|lastHttpStatus)', 'a field the contract does not list leaked through';
    raise notice 'PASS: output is an allow-list: extra G2 fields are dropped, codes sanitised, numbers clamped';
end $t$;

-- A G2 failure surfaces as an error too.
create or replace function private.azerdex_news_health() returns jsonb language plpgsql as $$ begin raise exception 'boom'; end $$;
do $t$ begin
    begin perform ops_report.health(); raise exception 'a failing G2 function must fail the report';
    exception when others then if sqlerrm = 'boom' then null; else raise; end if; end;
    raise notice 'PASS: a failing G2 function fails the report (the endpoint answers 503)';
end $t$;

rollback;

-- ---------------------------------------------------------------------------------------------------------------------
-- Privilege model (read-only catalog checks; nothing is written).
do $t$
declare
    v_role oid := (select oid from pg_roles where rolname = 'azerdex_ops_reporter');
    p pg_proc%rowtype;
    v_n integer;
    v_bad text;
begin
    assert v_role is not null, 'role azerdex_ops_reporter missing';
    assert exists (select 1 from pg_roles where rolname = 'azerdex_ops_reporter' and rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole
                   and not rolbypassrls and not rolinherit and not rolreplication and rolconnlimit = 3), 'role flags are not least-privilege';
    assert (select rolpassword from pg_authid where rolname = 'azerdex_ops_reporter') is null, 'the migration must not set a password';
    assert not exists (select 1 from pg_auth_members where member = v_role), 'the role must not be a member of any role';
    assert not exists (select 1 from pg_auth_members where roleid = v_role), 'no role may inherit from the reporting role';

    select * into p from pg_proc where oid = 'ops_report.health()'::regprocedure;
    assert p.prosecdef and p.provolatile = 's', 'health() must be SECURITY DEFINER and STABLE (cannot write)';
    assert p.proowner = (select oid from pg_roles where rolname = current_user), 'health() must be owned by the admin that applied the migration';
    assert p.proconfig @> array['search_path=pg_catalog'] and p.proconfig @> array['statement_timeout=5s'], 'health() must pin search_path and a statement timeout';

    assert has_function_privilege('azerdex_ops_reporter', 'ops_report.health()', 'execute'), 'the reporting role cannot run the report';
    assert has_schema_privilege('azerdex_ops_reporter', 'ops_report', 'usage'), 'the reporting role cannot reach the schema';
    foreach v_bad in array array['public', 'anon', 'authenticated', 'service_role', 'foreverdb_web_reader', 'azerdex_news_ingest'] loop
        if v_bad <> 'public' and not exists (select 1 from pg_roles where rolname = v_bad) then continue; end if;
        assert not has_function_privilege(v_bad, 'ops_report.health()', 'execute'), v_bad || ' can run the report';
        assert not has_schema_privilege(v_bad, 'ops_report', 'usage'), v_bad || ' can use the ops_report schema';
    end loop;

    -- The reporting role holds exactly ONE explicit grant on a function, none on any table, view, sequence or other schema.
    select count(*) into v_n from pg_proc f, lateral aclexplode(f.proacl) a where a.grantee = v_role;
    assert v_n = 1, 'the reporting role must have exactly one function privilege, found ' || v_n;
    select count(*) into v_n from pg_class c, lateral aclexplode(c.relacl) a where a.grantee = v_role;
    assert v_n = 0, 'the reporting role must have no table/view/sequence privilege, found ' || v_n;
    select count(*) into v_n from pg_namespace s, lateral aclexplode(s.nspacl) a where a.grantee = v_role;
    assert v_n = 1, 'the reporting role must have USAGE on exactly one schema, found ' || v_n;
    assert not has_function_privilege('azerdex_ops_reporter', 'private.azerdex_news_health()', 'execute'), 'the reporting role can call the G2 function directly';
    assert not has_function_privilege('azerdex_ops_reporter', 'private.azerdex_news_assert_healthy()', 'execute'), 'the reporting role can call the G2 assertion';
    assert not has_table_privilege('azerdex_ops_reporter', 'cron.job', 'select') and not has_table_privilege('azerdex_ops_reporter', 'cron.job_run_details', 'select'), 'the reporting role can read cron tables';
    assert not has_table_privilege('azerdex_ops_reporter', 'pub.news_sources', 'select'), 'the reporting role can read News tables';
    assert not has_schema_privilege('azerdex_ops_reporter', 'private', 'usage'), 'the reporting role can use the private schema';
    raise notice 'PASS: least-privilege model: one function, one schema, no table, no membership, no password';
end
$t$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Behaviour AS the reporting role: it can run the report and nothing else.
begin;
delete from cron.job_run_details; delete from cron.job;
insert into pub.news_sources (source_key, source_type, region, endpoint_url, last_attempt_at, last_fetch_ok_at)
values ('r-us', 'bluepost', 'us', 'https://example.com/r', now(), now());
insert into cron.job (jobname, schedule, command) values ('azerdex-news-health', '*/15 * * * *', 'x');
set local role azerdex_ops_reporter;
do $t$
declare r jsonb;
begin
    r := ops_report.health();
    assert r ->> 'schemaVersion' = '1' and jsonb_array_length(r -> 'sources') = 1, 'the reporting role must be able to run the report';
    begin perform 1 from pub.news_sources; raise exception 'the role read pub.news_sources';
    exception when insufficient_privilege then null; end;
    begin perform 1 from cron.job; raise exception 'the role read cron.job';
    exception when insufficient_privilege then null; end;
    begin perform 1 from cron.job_run_details; raise exception 'the role read cron.job_run_details';
    exception when insufficient_privilege then null; end;
    begin perform private.azerdex_news_health(); raise exception 'the role called the G2 function';
    exception when insufficient_privilege then null; end;
    begin perform pub_admin.news_health_snapshot(); raise exception 'the role called the snapshot function';
    exception when insufficient_privilege then null; end;
    begin insert into pub.news_sources (source_key, source_type, region, endpoint_url) values ('w-us', 'bluepost', 'us', 'https://example.com/w'); raise exception 'the role wrote to pub.news_sources';
    exception when insufficient_privilege then null; end;
    begin update cron.job set active = false; raise exception 'the role changed a cron job';
    exception when insufficient_privilege then null; end;
    begin create table public.ops_report_probe (x int); raise exception 'the role created a table in public';
    exception when insufficient_privilege then null; end;
    raise notice 'PASS: as azerdex_ops_reporter: the report runs; no read of tables or cron, no G2 call, no write, no DDL';
end
$t$;
rollback;
