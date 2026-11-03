-- AzerDex retention cleanup (GDPR storage limitation). OWNER-RUN, MANUAL, NOT A MIGRATION, NOT APPLIED ANYWHERE.
--
-- Run ONLY on a project the owner has approved for it (hosted staging first), after reviewing docs/gdpr/retention-schedule.md.
-- This file creates objects and schedules NOTHING; scheduling is the separate, equally manual retention_cleanup_schedule.sql.
-- Idempotent: safe to re-run. Requires migration 0012 (private.installation_claims, account_installations, account_audit) and
-- 0009 (private.foreverdb_api_budgets); private.enrollment_tickets / devices (0014) are optional: that task is skipped when absent.
--
-- It applies, in bounded batches, the retention rules the code and the privacy notice already state - it adds NO new period:
--   claims            revoked claims, and never-redeemed expired (still `pending`) claims, older than 7 days (0012 prune script);
--                     NEVER a `consumed` claim and NEVER a claim a link row references; each row under the installation advisory lock
--   account_audit     rows older than 180 days (0012 prune script)
--   enrollment_tickets terminal / expired tickets older than 90 days that no device references (0014 private.fdb_prune_enrollment())
--   api_budgets       fixed-window counters older than 24 hours (0009 private.foreverdb_prune_api_budgets())
-- Deliberately NOT here (no retention rule exists yet, so none is invented): private.device_audit, private.devices, installation
-- statistics and Guildbook tables, public.map_asset_diagnostics, anonymous auth.users. The welcome outbox keeps its own job
-- (azerdex-welcome-prune). See docs/gdpr/retention-schedule.md.
--
-- Safety properties:
--   * bounded: at most p_batch_rows (default 100, max 1000) per batch and p_max_batches (default 5) batches per task per run; backlog
--     drains over successive runs and is reported as more_pending;
--   * no overlap: a transaction-level advisory lock makes a second concurrent run exit immediately (logged `skipped_locked`);
--   * no blocking: lock_timeout 5s, and a claim whose installation lock is busy (ingest, claim, transfer) is skipped this run
--     (pg_try_advisory_xact_lock) and retried next run, so cleanup never queues behind or ahead of user traffic;
--   * isolated: every task runs in its own sub-transaction; one failing task rolls back only itself and is logged, the others still run;
--   * observable: private.retention_run_log (counts, status and SQLSTATE only - never a row value, address, name or identifier) and
--     private.azerdex_retention_assert_healthy(), which RAISES when the latest real run failed or is stale, so a scheduled check shows up
--     as a failed job in cron.job_run_details;
--   * private: SECURITY DEFINER, search_path = '', no privilege for public, anon, authenticated or service_role.
-- First use: select private.azerdex_retention_run(p_dry_run := true);   -- counts what WOULD be deleted, deletes nothing
\set ON_ERROR_STOP on
begin;
set local lock_timeout = '10s';

do $preflight$
begin
    if to_regclass('private.installation_claims') is null or to_regclass('private.account_installations') is null
       or to_regclass('private.account_audit') is null then
        raise exception 'retention pre-flight: migration 0012 is not applied';
    end if;
    if to_regclass('private.foreverdb_api_budgets') is null then
        raise exception 'retention pre-flight: migration 0009 is not applied';
    end if;
end $preflight$;

create table if not exists private.retention_run_log (
    id            bigint generated always as identity primary key,
    run_id        uuid not null,
    started_at    timestamptz not null default clock_timestamp(),
    finished_at   timestamptz,
    task          text not null check (task in ('run', 'claims', 'account_audit', 'enrollment_tickets', 'api_budgets')),
    status        text not null check (status in ('ok', 'error', 'skipped_locked', 'skipped_missing')),
    dry_run       boolean not null default false,
    row_count     integer not null default 0 check (row_count >= 0),
    batches       integer not null default 0 check (batches >= 0),
    more_pending  boolean not null default false,
    sqlstate      text check (sqlstate is null or length(sqlstate) = 5),
    error_message text check (error_message is null or length(error_message) <= 120)
);
create index if not exists retention_run_log_run_idx on private.retention_run_log (run_id);
alter table private.retention_run_log enable row level security;
revoke all on table private.retention_run_log from public, anon, authenticated, service_role;

-- One bounded batch of one task. Returns rows deleted (or, when p_dry_run, rows that would be deleted, capped at p_rows).
create or replace function private.azerdex_retention_batch(p_task text, p_rows integer, p_dry_run boolean)
returns integer
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
    r record;
    v_n integer := 0;
    v_d integer;
begin
    if p_task = 'claims' then
        if p_dry_run then
            select count(*) into v_n from (
                select 1 from private.installation_claims c
                where ((c.status = 'revoked' and c.created_at < now() - interval '7 days')
                    or (c.status = 'pending' and c.expires_at < now() - interval '7 days'))
                  and not exists (select 1 from private.account_installations l where l.claim_id = c.id)
                limit p_rows) s;
            return v_n;
        end if;
        for r in
            select c.id, c.installation_id
            from private.installation_claims c
            where ((c.status = 'revoked' and c.created_at < now() - interval '7 days')
                or (c.status = 'pending' and c.expires_at < now() - interval '7 days'))
              and not exists (select 1 from private.account_installations l where l.claim_id = c.id)
            order by c.created_at
            limit p_rows
        loop
            -- The same key ingest and the account functions take; try-lock so cleanup never waits on (or blocks) user traffic.
            if not pg_try_advisory_xact_lock(hashtextextended(r.installation_id, 0)) then
                continue;
            end if;
            delete from private.installation_claims c
            where c.id = r.id and c.status in ('revoked', 'pending')
              and not exists (select 1 from private.account_installations l where l.claim_id = c.id);
            get diagnostics v_d = row_count;
            v_n := v_n + v_d;
        end loop;
        return v_n;

    elsif p_task = 'account_audit' then
        if p_dry_run then
            select count(*) into v_n from (select 1 from private.account_audit a where a.at < now() - interval '180 days' limit p_rows) s;
            return v_n;
        end if;
        delete from private.account_audit
        where id in (select a.id from private.account_audit a where a.at < now() - interval '180 days' order by a.id limit p_rows);
        get diagnostics v_n = row_count;
        return v_n;

    elsif p_task = 'enrollment_tickets' then
        if p_dry_run then
            select count(*) into v_n from (
                select 1 from private.enrollment_tickets t
                where t.created_at < now() - interval '90 days' and (t.status <> 'pending' or t.expires_at < now())
                  and not exists (select 1 from private.devices d where d.ticket_id = t.id)
                limit p_rows) s;
            return v_n;
        end if;
        delete from private.enrollment_tickets
        where id in (
            select t.id from private.enrollment_tickets t
            where t.created_at < now() - interval '90 days' and (t.status <> 'pending' or t.expires_at < now())
              and not exists (select 1 from private.devices d where d.ticket_id = t.id)
            order by t.created_at limit p_rows);
        get diagnostics v_n = row_count;
        return v_n;

    elsif p_task = 'api_budgets' then
        if p_dry_run then
            select count(*) into v_n from (select 1 from private.foreverdb_api_budgets b where b.window_started < now() - interval '24 hours' limit p_rows) s;
            return v_n;
        end if;
        delete from private.foreverdb_api_budgets
        where bucket in (select b.bucket from private.foreverdb_api_budgets b where b.window_started < now() - interval '24 hours' limit p_rows);
        get diagnostics v_n = row_count;
        return v_n;
    end if;
    raise exception 'retention: unknown task' using errcode = '22023';
end;
$fn$;

create or replace function private.azerdex_retention_run(
    p_batch_rows integer default 100,
    p_max_batches integer default 5,
    p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
    v_run uuid := gen_random_uuid();
    v_task text;
    v_t0 timestamptz;
    v_n integer;
    v_total integer;
    v_batches integer;
    v_more boolean;
    v_status text;
    v_state text;
    v_msg text;
    v_ok boolean := true;
    v_out jsonb := '{}'::jsonb;
begin
    if p_batch_rows is null or p_batch_rows < 1 or p_batch_rows > 1000
       or p_max_batches is null or p_max_batches < 1 or p_max_batches > 100 then
        raise exception 'retention: batch bounds out of range' using errcode = '22023';
    end if;
    -- A second concurrent run (overlapping cron invocations, an operator run during the job) leaves immediately.
    if not pg_try_advisory_xact_lock(hashtextextended('azerdex-retention-run', 0)) then
        insert into private.retention_run_log (run_id, task, status, finished_at) values (v_run, 'run', 'skipped_locked', clock_timestamp());
        return jsonb_build_object('run_id', v_run, 'ok', true, 'skipped', 'locked');
    end if;

    foreach v_task in array array['claims', 'account_audit', 'enrollment_tickets', 'api_budgets'] loop
        v_t0 := clock_timestamp(); v_total := 0; v_batches := 0; v_more := false; v_status := 'ok'; v_state := null; v_msg := null;
        begin
            if v_task = 'enrollment_tickets' and (to_regclass('private.enrollment_tickets') is null or to_regclass('private.devices') is null) then
                v_status := 'skipped_missing';
            elsif p_dry_run then
                v_total := private.azerdex_retention_batch(v_task, p_batch_rows * p_max_batches, true);
                v_batches := 1;
                v_more := v_total >= p_batch_rows * p_max_batches;
            else
                loop
                    exit when v_batches >= p_max_batches;
                    v_n := private.azerdex_retention_batch(v_task, p_batch_rows, false);
                    v_batches := v_batches + 1;
                    v_total := v_total + v_n;
                    exit when v_n < p_batch_rows;
                    v_more := v_batches >= p_max_batches;   -- a full last batch under the cap: more probably remains
                end loop;
            end if;
        exception when others then
            -- Only the failing task is rolled back; record the code and the (data-free) message and continue with the next task.
            get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
            v_status := 'error'; v_ok := false; v_total := 0; v_more := false;
            v_msg := left(v_msg, 120);
        end;
        insert into private.retention_run_log (run_id, started_at, finished_at, task, status, dry_run, row_count, batches, more_pending, sqlstate, error_message)
        values (v_run, v_t0, clock_timestamp(), v_task, v_status, p_dry_run, v_total, v_batches, v_more, v_state, v_msg);
        v_out := v_out || jsonb_build_object(v_task, jsonb_build_object('status', v_status, 'rows', v_total, 'batches', v_batches, 'more_pending', v_more));
    end loop;

    -- The log is bounded too: it keeps the newest 5000 entries (counts and codes only; no personal data).
    delete from private.retention_run_log where id <= (select max(id) from private.retention_run_log) - 5000;
    return jsonb_build_object('run_id', v_run, 'dry_run', p_dry_run, 'ok', v_ok, 'tasks', v_out);
end;
$fn$;

-- Failure visibility. Run it from its own scheduled job: it RAISES (so cron.job_run_details shows `failed`) when the latest real run had a
-- failing task or when no real run has completed within p_max_age. Read-only; never deletes anything.
create or replace function private.azerdex_retention_assert_healthy(p_max_age interval default interval '36 hours')
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $fn$
declare
    v_run uuid;
    v_at timestamptz;
    v_failed text;
    v_backlog text;
begin
    select l.run_id, l.started_at into v_run, v_at
    from private.retention_run_log l
    where l.dry_run = false and l.status <> 'skipped_locked'
    order by l.id desc limit 1;
    if v_run is null then
        raise exception 'AZERDEX_RETENTION: no retention run has been recorded' using errcode = 'P0001';
    end if;
    if v_at < now() - p_max_age then
        raise exception 'AZERDEX_RETENTION: last run is stale (%)', v_at using errcode = 'P0001';
    end if;
    select string_agg(l.task || ':' || coalesce(l.sqlstate, '?'), ', ' order by l.task) into v_failed
    from private.retention_run_log l where l.run_id = v_run and l.status = 'error';
    if v_failed is not null then
        raise exception 'AZERDEX_RETENTION: failing task(s): %', v_failed using errcode = 'P0001';
    end if;
    select string_agg(distinct l.task, ', ') into v_backlog
    from private.retention_run_log l where l.run_id = v_run and l.more_pending;
    if v_backlog is not null then
        raise warning 'AZERDEX_RETENTION: backlog remains for %', v_backlog;
    end if;
    return jsonb_build_object('ok', true, 'last_run_at', v_at, 'backlog', v_backlog);
end;
$fn$;

revoke all on function private.azerdex_retention_batch(text, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function private.azerdex_retention_run(integer, integer, boolean) from public, anon, authenticated, service_role;
revoke all on function private.azerdex_retention_assert_healthy(interval) from public, anon, authenticated, service_role;

commit;
