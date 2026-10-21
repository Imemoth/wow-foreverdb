-- Ephemeral-DB (or hosted, read-mostly) test for 0003 publication operations and 0004 schedule wiring.
-- Precondition: 0001-0004 applied and ONE publication active. Leaves only run-log/lease rows behind, all released.
\set ON_ERROR_STOP 1

-- ------------------------------------------------------------- publisher identity
set role foreverdb_publisher;
do $t$
declare
    denied boolean;
    stmt text;
    v_id bigint;
    v_status jsonb;
begin
    -- Lease: exclusive, releasable, only the holder releases it.
    if not pub_admin.acquire_lease('test-a', 60) then raise exception 'FAIL: first lease refused'; end if;
    if pub_admin.acquire_lease('test-b', 60) then raise exception 'FAIL: overlapping lease granted'; end if;
    perform pub_admin.release_lease('test-b');   -- not the holder: no effect
    if pub_admin.acquire_lease('test-b', 60) then raise exception 'FAIL: lease released by a non-holder'; end if;
    perform pub_admin.release_lease('test-a');
    if not pub_admin.acquire_lease('test-b', 60) then raise exception 'FAIL: lease not reusable after release'; end if;
    perform pub_admin.release_lease('test-b');

    -- Lease request bounds.
    foreach stmt in array array[
        'select pub_admin.acquire_lease('''', 60)',
        'select pub_admin.acquire_lease(''x'', 5)',
        'select pub_admin.acquire_lease(''x'', 100000)'
    ] loop
        denied := false;
        begin execute stmt; exception when raise_exception then denied := true; end;
        if not denied then raise exception 'FAIL: invalid lease request accepted: %', stmt; end if;
    end loop;

    -- Run log: validated, append-only, reachable only through record_run; no direct table access.
    v_id := pub_admin.record_run('manual', 'rehearse', 'rehearsal_ok', null, null, null, 'test-0', now(), now(), repeat('b', 64),
                                 '{"totalMs": 123.4}'::jsonb);
    if v_id is null then raise exception 'FAIL: record_run returned nothing'; end if;
    foreach stmt in array array[
        'select pub_admin.record_run(''cron'', ''publish'', ''exploded'', null, null, null, ''t'', now(), null, null, ''{}''::jsonb)',
        'select pub_admin.record_run(''cron'', ''publish'', ''failed'', null, repeat(''x'', 81), null, ''t'', now(), null, null, ''{}''::jsonb)',
        'select pub_admin.record_run(''cron'', ''publish'', ''failed'', null, null, null, ''t'', now(), null, ''not-a-hash'', ''{}''::jsonb)',
        'select pub_admin.record_run(''cron'', ''publish'', ''failed'', null, null, null, ''t'', now(), null, null, jsonb_build_object(''pad'', repeat(''z'', 9000)))'
    ] loop
        denied := false;
        begin execute stmt; exception when check_violation then denied := true; end;
        if not denied then raise exception 'FAIL: invalid run record accepted: %', stmt; end if;
    end loop;
    foreach stmt in array array[
        'select 1 from pub.publish_runs limit 1', 'delete from pub.publish_runs', 'update pub.publish_runs set outcome = ''failed''',
        'select 1 from pub.publisher_lease', 'update pub.publisher_lease set expires_at = ''-infinity''',
        'select pub_ops.invoke_publisher(''publish'', ''manual'')', 'select pub_ops.set_schedule(true)',
        'select pub_ops.configure(''https://aaaaaaaaaaaaaaaaaaaa.supabase.co'', ''eyJa.b.c'')', 'select pub_ops.cron_status()',
        'select pub_admin.activate_publication(1)'
    ] loop
        denied := false;
        begin execute stmt; exception when insufficient_privilege then denied := true; end;
        if not denied then raise exception 'FAIL: publisher was allowed: %', stmt; end if;
    end loop;

    -- Operational status: everything the owner asked to see, from one call.
    v_status := pub_admin.ops_status(2700);
    if (v_status->>'activePublicationId') is null or v_status->'counts' is null
       or v_status->'lastRun' is not null and false then
        raise exception 'FAIL: ops_status incomplete: %', v_status;
    end if;
    if jsonb_typeof(v_status->'previousAvailableForRollback') <> 'boolean' or jsonb_typeof(v_status->'stale') <> 'boolean' then
        raise exception 'FAIL: ops_status flags missing: %', v_status;
    end if;
    raise notice 'PASS: lease is exclusive; run log validated and function-only; ops status complete; schedule admin not reachable by the publisher';
end
$t$;
reset role;

-- ------------------------------------------------------------- token verification
do $t$
declare v_tok text;
begin
    select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'publish_invoke_token';
    if v_tok is null or length(v_tok) <> 64 then raise exception 'FAIL: invoke token missing or malformed'; end if;
    set local role foreverdb_publisher;
    if not pub_ops.verify_invoke_token(v_tok) then raise exception 'FAIL: genuine token rejected'; end if;
    if pub_ops.verify_invoke_token(repeat('0', 64)) or pub_ops.verify_invoke_token('') or pub_ops.verify_invoke_token(null)
       or pub_ops.verify_invoke_token(v_tok || 'x') then
        raise exception 'FAIL: wrong token accepted';
    end if;
    reset role;
    raise notice 'PASS: invoke token verified inside the database (exact match only)';
end
$t$;

-- ------------------------------------------------------------- web reader / API roles
set role foreverdb_web_reader;
do $t$
declare denied boolean; stmt text;
begin
    foreach stmt in array array[
        'select pub_admin.ops_status(10)', 'select pub_admin.acquire_lease(''x'', 60)',
        'select pub_ops.verify_invoke_token(''x'')', 'select 1 from pub.publish_runs'
    ] loop
        denied := false;
        begin execute stmt; exception when insufficient_privilege then denied := true; end;
        if not denied then raise exception 'FAIL: web reader was allowed: %', stmt; end if;
    end loop;
    raise notice 'PASS: web reader cannot reach operations objects';
end
$t$;
reset role;

do $t$
declare r text;
begin
    foreach r in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = r)
           and (has_schema_privilege(r, 'pub_ops', 'usage') or has_schema_privilege(r, 'pub_admin', 'usage')
                or has_function_privilege(r, 'pub_ops.invoke_publisher(text, text, text, integer)', 'execute')) then
            raise exception 'FAIL: % can reach operations objects', r;
        end if;
    end loop;
    raise notice 'PASS: Supabase API roles cannot reach pub_ops / pub_admin';
end
$t$;

-- ------------------------------------------------------------- owner/operator: schedule control
do $t$
declare v_msg text; v_cs jsonb;
begin
    perform pub_ops.configure('https://aaaaaaaaaaaaaaaaaaaa.supabase.co', 'eyJhbGciOi.eyJpc3M.sig_-x');
    begin perform pub_ops.configure('http://evil.example', 'eyJa.b.c'); raise exception 'FAIL: configure accepted a foreign url';
    exception when raise_exception then if sqlerrm like 'FAIL:%' then raise; end if; end;
    begin perform pub_ops.set_schedule(true, '* * * * * *; drop table x'); raise exception 'FAIL: set_schedule accepted an invalid expression';
    exception when raise_exception then if sqlerrm like 'FAIL:%' then raise; end if; end;
    v_msg := pub_ops.set_schedule(true, '*/15 * * * *');
    v_cs := pub_ops.cron_status(3);
    if v_cs->'job'->>'schedule' <> '*/15 * * * *' then raise exception 'FAIL: schedule not created: %', v_cs; end if;
    perform pub_ops.set_schedule(false);
    if (pub_ops.cron_status(3)->'job') is not null and (pub_ops.cron_status(3)->>'job') <> 'null' then raise exception 'FAIL: schedule not removed'; end if;
    raise notice 'PASS: schedule can be created and removed only by the owner (%)', v_msg;
end
$t$;
