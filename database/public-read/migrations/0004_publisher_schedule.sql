-- ForeverDB PUBLIC READ MODEL 0004: Supabase-native schedule wiring (pg_cron + pg_net + Vault). Requires 0001 + 0003.
--
-- Target: the isolated public-read project (azerdex-public-read) only. SUPABASE-ONLY: needs supabase_vault, pg_cron, pg_net.
-- Creates NO schedule: the recurring job is created by `select pub_ops.set_schedule(true)` after credentials, permissions
-- and failure behaviour have been verified (docs/web/public-publication-operations.md).
--
-- Authentication of an invocation (defence in depth):
--   1. the Supabase gateway verifies a project JWT (verify_jwt = true; the legacy anon key is public by design), and
--   2. the function checks the `x-publish-token` header against a random secret that exists ONLY in Vault. The token is
--      generated here, inside the database, and is never shown, logged or committed. pg_cron/pg_net read it from Vault;
--      the Edge Function validates it through pub_ops.verify_invoke_token (sha256 comparison inside the database).
--   Rotation: select vault.update_secret(id, new) for the secret named publish_invoke_token (see runbook).
begin;

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create schema if not exists pub_ops;
revoke all on schema pub_ops from public;
do $api$
declare r text;
begin
    foreach r in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = r) then
            execute format('revoke all on schema pub_ops from %I', r);
        end if;
    end loop;
end
$api$;

-- Token generated inside the database (idempotent: an existing token is kept).
do $token$
begin
    if not exists (select 1 from vault.secrets where name = 'publish_invoke_token') then
        perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'publish_invoke_token',
                                    'Shared secret between pg_cron/pg_net and the publish-observations Edge Function');
    end if;
end
$token$;

-- Stores the (non-secret) project URL and the public anon JWT used for the gateway check. Operator action, idempotent.
create function pub_ops.configure(p_project_url text, p_anon_jwt text)
returns void language plpgsql security definer set search_path = ''
as $$
declare r record;
begin
    if p_project_url !~ '^https://[a-z0-9]{20}\.supabase\.co$' then raise exception 'unexpected project url'; end if;
    if p_anon_jwt !~ '^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then raise exception 'unexpected jwt'; end if;
    for r in select * from (values ('publish_project_url', p_project_url), ('publish_gateway_jwt', p_anon_jwt)) v(n, val) loop
        if exists (select 1 from vault.secrets where name = r.n) then
            perform vault.update_secret((select id from vault.secrets where name = r.n), r.val);
        else
            perform vault.create_secret(r.val, r.n);
        end if;
    end loop;
end;
$$;

create function pub_ops.verify_invoke_token(p_token text)
returns boolean language sql stable security definer set search_path = ''
as $$
    select p_token is not null and length(p_token) <= 256 and exists (
        select 1 from vault.decrypted_secrets s
        where s.name = 'publish_invoke_token'
          and sha256(convert_to(s.decrypted_secret, 'UTF8')) = sha256(convert_to(p_token, 'UTF8')));
$$;

-- Fire-and-forget HTTP POST to the Edge Function (pg_net). Used by the schedule and for manual runs.
create function pub_ops.invoke_publisher(
    p_mode text default 'publish', p_trigger text default 'cron', p_source text default 'private', p_scale integer default null)
returns bigint language plpgsql security definer set search_path = ''
as $$
declare v_url text; v_jwt text; v_tok text; v_id bigint;
begin
    if p_mode not in ('publish', 'dry_run', 'rehearse') or p_trigger not in ('cron', 'manual', 'benchmark')
       or p_source not in ('private', 'synthetic') or (p_scale is not null and p_scale not between 1 and 200) then
        raise exception 'invalid invocation parameters';
    end if;
    select decrypted_secret into v_url from vault.decrypted_secrets where name = 'publish_project_url';
    select decrypted_secret into v_jwt from vault.decrypted_secrets where name = 'publish_gateway_jwt';
    select decrypted_secret into v_tok from vault.decrypted_secrets where name = 'publish_invoke_token';
    if v_url is null or v_jwt is null or v_tok is null then raise exception 'publisher is not configured'; end if;
    select net.http_post(
        url => v_url || '/functions/v1/publish-observations',
        headers => jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_jwt, 'x-publish-token', v_tok),
        body => jsonb_build_object('mode', p_mode, 'trigger', p_trigger, 'source', p_source, 'scale', p_scale),
        timeout_milliseconds => 150000) into v_id;
    return v_id;
end;
$$;

-- Creates (enabled = true) or removes (false) the recurring job. Nothing else ever creates it.
create function pub_ops.set_schedule(p_enabled boolean, p_expression text default '*/15 * * * *')
returns text language plpgsql security definer set search_path = ''
as $$
begin
    if p_expression !~ '^[0-9*/,-]+( [0-9*/,-]+){4}$' then raise exception 'invalid cron expression'; end if;
    if p_enabled then
        perform cron.schedule('azerdex-publish-observations', p_expression,
                              $cmd$select pub_ops.invoke_publisher('publish', 'cron')$cmd$);
        return 'scheduled ' || p_expression;
    end if;
    if exists (select 1 from cron.job where jobname = 'azerdex-publish-observations') then
        perform cron.unschedule('azerdex-publish-observations');
        return 'unscheduled';
    end if;
    return 'no schedule existed';
end;
$$;

-- Last cron outcomes and the Edge Function's HTTP responses (status codes and the function's own sanitized JSON).
create function pub_ops.cron_status(p_runs integer default 5)
returns jsonb language sql stable security definer set search_path = ''
as $$
    select jsonb_build_object(
        'job', (select jsonb_build_object('jobid', jobid, 'schedule', schedule, 'active', active)
                from cron.job where jobname = 'azerdex-publish-observations'),
        'lastRuns', coalesce((select jsonb_agg(x order by x->>'startTime' desc) from (
            select jsonb_build_object('status', d.status, 'startTime', d.start_time, 'endTime', d.end_time,
                                      'message', left(d.return_message, 200)) as x
            from cron.job_run_details d join cron.job j on j.jobid = d.jobid
            where j.jobname = 'azerdex-publish-observations' order by d.start_time desc limit least(greatest(p_runs, 1), 20)) q), '[]'::jsonb),
        'lastHttp', coalesce((select jsonb_agg(x order by x->>'created' desc) from (
            select jsonb_build_object('statusCode', r.status_code, 'created', r.created, 'timedOut', r.timed_out,
                                      'error', left(r.error_msg, 200), 'body', left(r.content, 600)) as x
            from net._http_response r order by r.created desc limit least(greatest(p_runs, 1), 20)) q), '[]'::jsonb));
$$;

revoke all on all functions in schema pub_ops from public;
grant usage on schema pub_ops to foreverdb_publisher;
grant execute on function pub_ops.verify_invoke_token(text) to foreverdb_publisher;
-- configure / invoke_publisher / set_schedule / cron_status stay with the migration owner (operator / pg_cron job owner).
alter function pub_ops.invoke_publisher(text, text, text, integer) set statement_timeout = '10s';
alter function pub_ops.verify_invoke_token(text) set statement_timeout = '3s';

do $verify$
begin
    if has_function_privilege('foreverdb_publisher', 'pub_ops.invoke_publisher(text, text, text, integer)', 'execute')
       or has_function_privilege('foreverdb_publisher', 'pub_ops.set_schedule(boolean, text)', 'execute')
       or has_function_privilege('foreverdb_publisher', 'pub_ops.configure(text, text)', 'execute')
       or has_function_privilege('foreverdb_web_reader', 'pub_ops.verify_invoke_token(text)', 'execute')
       or has_schema_privilege('foreverdb_web_reader', 'pub_ops', 'usage') then
        raise exception 'Schedule boundary FAILED';
    end if;
    if exists (select 1 from pg_roles where rolname = 'anon')
       and (has_schema_privilege('anon', 'pub_ops', 'usage') or has_function_privilege('anon', 'pub_ops.invoke_publisher(text, text, text, integer)', 'execute')) then
        raise exception 'anon can reach pub_ops';
    end if;
end
$verify$;

commit;

-- Rollback contract (manual): select pub_ops.set_schedule(false); begin; drop schema pub_ops cascade;
--   delete from vault.secrets where name in ('publish_invoke_token','publish_project_url','publish_gateway_jwt'); commit;
