-- ForeverDB 0015: AzerDex welcome e-mail - private outbox, trusted confirmation provenance, worker RPCs, reconciler and kill switch.
--
-- Specification (approved): docs/superpowers/specs/2026-10-13-azerdex-welcome-outbox-design.md
-- Plan / runbook / evidence: docs/superpowers/plans/2026-10-13-azerdex-welcome-implementation.md, docs/azerdex-welcome-email/
--
-- WHAT THIS MIGRATION DOES
--   * Creates four PRIVATE tables (config, candidates, outbox, trigger_failures) in schema private. RLS is enabled on every one and there
--     is NO policy and NO grant for PUBLIC / anon / authenticated / service_role: nothing but the owner and the SECURITY DEFINER
--     functions below can read or write them. Anonymous Supabase JWTs use the `authenticated` role and are therefore covered.
--   * Two AFTER triggers on auth.users (SECURITY DEFINER, search_path = '', no network I/O, lock_timeout bounded, every failure is caught
--     and recorded so registration / verification can never fail because of this feature):
--       - signup trigger: records an eligibility CANDIDATE for a new, non-anonymous, non-invited e-mail registration, only while the
--         feature's `enqueue_enabled` switch is ON and the account was created after `activation_at`;
--       - confirmation trigger: on the first NULL -> non-NULL `email_confirmed_at` of a candidate, and only when the real-GoTrue
--         provenance rule says the confirmation consumed the SIGNUP confirmation token (NOT a recovery link), it queues ONE outbox event.
--     Provenance (see docs/azerdex-welcome-email/gotrue-confirmation-probe.md): a recovery link used on an unconfirmed signup also flips
--     email_confirmed_at, so the bare transition is NOT trusted. A welcome is queued only if, at the confirming UPDATE, the user's
--     `confirmation_token` one-time token still exists, the row's confirmation_token was just cleared, and recovery_sent_at IS NULL.
--     It never reads user_metadata, a client-supplied type, redirect URLs, last_sign_in_at or confirmed_at.
--   * Stores NO raw address in the outbox: only sha256(lower(email)). The worker receives the CURRENT confirmed address from auth.users
--     at claim time, after the hash proves it is still the address that was verified; a changed address suppresses the event.
--   * Worker RPCs public.azerdex_welcome_claim / _finish / _stats: SECURITY DEFINER, search_path = '', EXECUTE for service_role only,
--     bounded inputs, no recipient parameter. Claiming uses FOR UPDATE SKIP LOCKED, a 180 s lease and a per-claim lease token.
--   * Unknown outcomes: an expired lease or an ambiguous provider result keeps the SAME idempotency key and is retried only inside a
--     20 h window (Resend keeps keys for 24 h); afterwards the event STOPS as review_required. Attempts are capped at 6.
--   * Kill switch: private.azerdex_welcome_config.{enqueue_enabled,dispatch_enabled}, both default FALSE. dispatch off => claim returns
--     nothing; enqueue off => no candidates / events. Rows are preserved.
--   * GDPR: both event tables reference auth.users ON DELETE CASCADE, so deleting an account erases its candidate, outbox row and
--     failure markers. A candidate row (and its address hash) is deleted as soon as its outbox row exists; after a successful send, an automatic suppression or an operator decision the outbox hash is zeroed at once. No history that could re-enable a duplicate
--     survives for a still-existing account.
--
-- DATA PRESERVATION: only new objects (four tables, twelve functions, two triggers on auth.users). No existing table row or function is
-- altered. NOTHING is applied to any Supabase project by the repository; apply only after explicit owner approval (kill switches stay OFF).
-- Numbering: 0012 applied; 0013 is a restore script only; 0014 is reserved by PR #56 (unmerged, untouched); 0010 reserved. 0015 is the
-- next free ID and is independent of 0014 (neither references the other).
-- Rollback / kill switch: database/rollback/0015_*.sql. Scheduler (pg_cron + pg_net): database/ops/0015_schedule_welcome_worker.sql (manual).

begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Pre-flight (read-only)
-- ---------------------------------------------------------------------------------------------------------------------
do $preflight$
declare
    v_col text;
begin
    if to_regclass('supabase_migrations.schema_migrations') is not null
       and exists (select 1 from supabase_migrations.schema_migrations where name = 'azerdex_welcome_outbox') then
        raise exception '0015 pre-flight: ledger already shows azerdex_welcome_outbox';
    end if;
    if to_regnamespace('private') is null then
        raise exception '0015 pre-flight: schema private is missing (apply 0009 first)';
    end if;
    foreach v_col in array array['id', 'email', 'email_confirmed_at', 'recovery_sent_at', 'invited_at', 'confirmation_token',
                                 'is_anonymous', 'deleted_at', 'banned_until', 'raw_app_meta_data', 'created_at'] loop
        if not exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'users' and column_name = v_col) then
            raise exception '0015 pre-flight: auth.users.% is missing (unsupported GoTrue schema)', v_col;
        end if;
    end loop;
    if to_regclass('auth.one_time_tokens') is null then
        raise exception '0015 pre-flight: auth.one_time_tokens is missing (the provenance rule needs it)';
    end if;
    if not has_table_privilege(current_user, 'auth.users', 'TRIGGER') or not has_table_privilege(current_user, 'auth.users', 'REFERENCES')
       or not has_table_privilege(current_user, 'auth.one_time_tokens', 'SELECT') then
        raise exception '0015 pre-flight: migration role lacks TRIGGER/REFERENCES on auth.users or SELECT on auth.one_time_tokens';
    end if;
    if not exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper)) then
        raise exception '0015 pre-flight: the migration role must have BYPASSRLS (the tables use FORCE ROW LEVEL SECURITY with no policy)';
    end if;
    if to_regprocedure('pg_catalog.sha256(bytea)') is null then
        raise exception '0015 pre-flight: sha256(bytea) is unavailable (PostgreSQL 11+ required)';
    end if;
end
$preflight$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Private tables (RLS on, no policies, no grants)
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists private.azerdex_welcome_config (
    singleton        boolean primary key default true check (singleton),
    enqueue_enabled  boolean not null default false,
    dispatch_enabled boolean not null default false,
    activation_at    timestamptz,
    updated_at       timestamptz not null default now()
);
insert into private.azerdex_welcome_config (singleton) values (true) on conflict (singleton) do nothing;

create table if not exists private.azerdex_welcome_candidates (
    user_id             uuid primary key references auth.users (id) on delete cascade,
    email_sha256        bytea not null check (octet_length(email_sha256) = 32),
    registered_at       timestamptz not null,
    verified_via_signup_at timestamptz
);
create index if not exists azerdex_welcome_candidates_verified_idx
    on private.azerdex_welcome_candidates (verified_via_signup_at) where verified_via_signup_at is not null;
create index if not exists azerdex_welcome_candidates_registered_idx
    on private.azerdex_welcome_candidates (registered_at);

create table if not exists private.azerdex_welcome_outbox (
    user_id             uuid primary key references auth.users (id) on delete cascade,
    email_sha256        bytea not null check (octet_length(email_sha256) = 32),
    event_at            timestamptz not null default now(),
    status              text not null default 'pending'
                        check (status in ('pending', 'leased', 'sent', 'retry', 'suppressed', 'review_required')),
    attempts            integer not null default 0 check (attempts between 0 and 6),
    next_attempt_at     timestamptz not null default now(),
    lease_until         timestamptz,
    lease_token         uuid,
    first_send_at       timestamptz,
    unknown_outcome     boolean not null default false,
    idem_epoch          integer not null default 1 check (idem_epoch >= 1),
    provider_message_id text check (provider_message_id is null or provider_message_id ~ '^[A-Za-z0-9_-]{8,64}$'),
    sent_at             timestamptz,
    last_error_code     text check (last_error_code is null or last_error_code in (
        'provider_rate_limited', 'provider_timeout', 'provider_transport', 'provider_5xx', 'provider_idempotency_conflict',
        'provider_malformed_response', 'provider_auth', 'provider_rejected', 'provider_4xx', 'circuit_open',
        'lease_expired', 'attempts_exhausted', 'idempotency_window_elapsed',
        'ineligible_unverified', 'ineligible_deleted', 'ineligible_banned', 'ineligible_anonymous', 'email_changed',
        'operator_suppressed', 'operator_resolved', 'unknown_code')),
    updated_at          timestamptz not null default now(),
    check ((status = 'leased') = (lease_token is not null)),
    check (status <> 'sent' or (sent_at is not null and provider_message_id is not null))
);
create index if not exists azerdex_welcome_outbox_due_idx
    on private.azerdex_welcome_outbox (next_attempt_at) where status in ('pending', 'retry');
create index if not exists azerdex_welcome_outbox_lease_idx
    on private.azerdex_welcome_outbox (lease_until) where status = 'leased';

create table if not exists private.azerdex_welcome_trigger_failures (
    id            bigserial primary key,
    user_id       uuid not null references auth.users (id) on delete cascade,
    phase         text not null check (phase in ('signup', 'confirm')),
    provenance_ok boolean not null default false,
    created_at    timestamptz not null default now(),
    handled_at    timestamptz
);
create index if not exists azerdex_welcome_trigger_failures_open_idx
    on private.azerdex_welcome_trigger_failures (created_at) where handled_at is null;

do $lockdown$
declare
    t text;
begin
    foreach t in array array['azerdex_welcome_config', 'azerdex_welcome_candidates', 'azerdex_welcome_outbox', 'azerdex_welcome_trigger_failures'] loop
        execute format('alter table private.%I enable row level security', t);
        execute format('alter table private.%I force row level security', t);
        execute format('revoke all on private.%I from public, anon, authenticated, service_role', t);
    end loop;
    revoke all on sequence private.azerdex_welcome_trigger_failures_id_seq from public, anon, authenticated, service_role;
end
$lockdown$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Triggers on auth.users (no network I/O; never raise)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.azerdex_welcome_note_failure(p_user uuid, p_phase text, p_prov boolean)
returns void
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
as $fn$
begin
    insert into private.azerdex_welcome_trigger_failures (user_id, phase, provenance_ok) values (p_user, p_phase, coalesce(p_prov, false));
exception when others then
    null; -- even the failure marker must never break the account flow; the missing-event counter in azerdex_welcome_stats() shows it
end
$fn$;

create or replace function private.azerdex_welcome_on_signup()
returns trigger
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $fn$
declare
    v_cfg private.azerdex_welcome_config%rowtype;
begin
    begin
        select * into v_cfg from private.azerdex_welcome_config where singleton;
        if v_cfg.enqueue_enabled
           and v_cfg.activation_at is not null
           and new.created_at >= v_cfg.activation_at
           and not coalesce(new.is_anonymous, false)
           and new.email is not null
           and new.email_confirmed_at is null
           and new.invited_at is null
           and new.raw_app_meta_data ->> 'provider' = 'email' then
            insert into private.azerdex_welcome_candidates (user_id, email_sha256, registered_at)
            values (new.id, sha256(convert_to(lower(new.email), 'UTF8')), new.created_at)
            on conflict (user_id) do nothing;
        end if;
    exception when others then
        perform private.azerdex_welcome_note_failure(new.id, 'signup', false);
    end;
    return new;
end
$fn$;

create or replace function private.azerdex_welcome_on_confirm()
returns trigger
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $fn$
declare
    v_cfg  private.azerdex_welcome_config%rowtype;
    v_prov boolean := false;
begin
    begin
        -- Only a registered candidate can ever be welcomed.
        if not exists (select 1 from private.azerdex_welcome_candidates c where c.user_id = new.id) then
            return new;
        end if;
        -- Trusted provenance (pinned by the real-GoTrue test suite): the SIGNUP confirmation token was the thing consumed.
        v_prov := new.email is not null
              and new.invited_at is null -- GoTrue sets invited_at AFTER the INSERT, so the signup trigger cannot exclude invitations itself
              and not coalesce(new.is_anonymous, false)
              and coalesce(old.confirmation_token, '') <> ''
              and coalesce(new.confirmation_token, '') = ''
              and new.recovery_sent_at is null
              and exists (select 1 from auth.one_time_tokens t where t.user_id = new.id and t.token_type = 'confirmation_token');
        if not v_prov then
            return new;
        end if;
        select * into v_cfg from private.azerdex_welcome_config where singleton;
        update private.azerdex_welcome_candidates set verified_via_signup_at = now() where user_id = new.id and verified_via_signup_at is null;
        if v_cfg.enqueue_enabled then
            insert into private.azerdex_welcome_outbox (user_id, email_sha256)
            values (new.id, sha256(convert_to(lower(new.email), 'UTF8')))
            on conflict (user_id) do nothing;
            -- The candidate (and its address hash) has served its purpose; the outbox row is the duplicate memory from here on.
            delete from private.azerdex_welcome_candidates where user_id = new.id;
        end if;
    exception when others then
        perform private.azerdex_welcome_note_failure(new.id, 'confirm', v_prov);
    end;
    return new;
end
$fn$;

-- DROP/REPLACE TRIGGER on auth.users needs table ownership, which the migration role may not have (the table belongs to the Auth
-- service role). Creating needs only TRIGGER. So: create when absent, and refuse a same-named trigger that points elsewhere.
do $triggers$
begin
    if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'azerdex_welcome_on_signup' and not tgisinternal) then
        create trigger azerdex_welcome_on_signup after insert on auth.users
            for each row execute function private.azerdex_welcome_on_signup();
    elsif not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'azerdex_welcome_on_signup'
                       and tgfoid = 'private.azerdex_welcome_on_signup()'::regprocedure) then
        raise exception '0015: trigger azerdex_welcome_on_signup exists but calls another function';
    end if;
    if not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'azerdex_welcome_on_confirm' and not tgisinternal) then
        create trigger azerdex_welcome_on_confirm after update of email_confirmed_at on auth.users
            for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
            execute function private.azerdex_welcome_on_confirm();
    elsif not exists (select 1 from pg_trigger where tgrelid = 'auth.users'::regclass and tgname = 'azerdex_welcome_on_confirm'
                       and tgfoid = 'private.azerdex_welcome_on_confirm()'::regprocedure) then
        raise exception '0015: trigger azerdex_welcome_on_confirm exists but calls another function';
    end if;
end
$triggers$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Bounded reconciler (missed events only; never a backfill)
-- ---------------------------------------------------------------------------------------------------------------------
-- Enqueues (a) candidates whose provenance was already proven (verified_via_signup_at) but whose outbox insert was lost or happened
-- while enqueue was off, and (b) confirm-phase trigger failures that had proven provenance. 7-day window, 50 rows, enqueue switch honoured.
create or replace function private.azerdex_welcome_reconcile()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_cfg private.azerdex_welcome_config%rowtype;
    v_n   integer := 0;
    r     record;
begin
    select * into v_cfg from private.azerdex_welcome_config where singleton;
    if not v_cfg.enqueue_enabled then
        return 0;
    end if;
    for r in
        select c.user_id
          from private.azerdex_welcome_candidates c
         where c.verified_via_signup_at is not null
           and c.verified_via_signup_at > now() - interval '7 days'
           and not exists (select 1 from private.azerdex_welcome_outbox o where o.user_id = c.user_id)
         order by c.verified_via_signup_at
         limit 50
    loop
        insert into private.azerdex_welcome_outbox (user_id, email_sha256)
        select c.user_id, c.email_sha256 from private.azerdex_welcome_candidates c where c.user_id = r.user_id
        on conflict (user_id) do nothing;
        delete from private.azerdex_welcome_candidates where user_id = r.user_id;
        v_n := v_n + 1;
    end loop;
    for r in
        select f.id, f.user_id
          from private.azerdex_welcome_trigger_failures f
         where f.handled_at is null and f.phase = 'confirm' and f.provenance_ok and f.created_at > now() - interval '7 days'
         order by f.created_at
         limit 50
    loop
        insert into private.azerdex_welcome_outbox (user_id, email_sha256)
        select c.user_id, c.email_sha256 from private.azerdex_welcome_candidates c where c.user_id = r.user_id
        on conflict (user_id) do nothing;
        delete from private.azerdex_welcome_candidates where user_id = r.user_id;
        update private.azerdex_welcome_trigger_failures set handled_at = now() where id = r.id;
        v_n := v_n + 1;
    end loop;
    return v_n;
end
$fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Worker RPCs (service_role only)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.azerdex_welcome_require_server_role()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
    v_claims text := nullif(current_setting('request.jwt.claims', true), '');
    v_role   text;
begin
    -- PostgREST exposes the verified JWT; a request that carries claims must be the service role. A direct database connection by the
    -- owner/operator carries none and is already limited by GRANTs. EXECUTE is additionally revoked from everyone but service_role.
    if v_claims is not null then
        begin
            v_role := v_claims::jsonb ->> 'role';
        exception when others then
            v_role := null;
        end;
        if v_role is distinct from 'service_role' then
            raise exception 'forbidden' using errcode = '42501';
        end if;
    end if;
end
$fn$;

create or replace function public.azerdex_welcome_claim(p_limit integer default 10)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
    v_cfg    private.azerdex_welcome_config%rowtype;
    v_limit  integer := least(greatest(coalesce(p_limit, 1), 1), 10);
    v_out    jsonb := '[]'::jsonb;
    r        private.azerdex_welcome_outbox%rowtype;
    u        auth.users%rowtype;
    v_reason text;
    v_token  uuid;
begin
    perform private.azerdex_welcome_require_server_role();
    select * into v_cfg from private.azerdex_welcome_config where singleton;
    if not v_cfg.dispatch_enabled then
        return v_out; -- kill switch: nothing is touched, no attempt is consumed
    end if;
    perform private.azerdex_welcome_reconcile();

    for r in
        select o.*
          from private.azerdex_welcome_outbox o
         where (o.status in ('pending', 'retry') and o.next_attempt_at <= now())
            or (o.status = 'leased' and o.lease_until < now())
         order by o.next_attempt_at, o.user_id
         limit v_limit
           for update skip locked
    loop
        -- An expired lease means a worker died or timed out after (possibly) calling the provider: the outcome is UNKNOWN.
        if r.status = 'leased' then
            r.unknown_outcome := true;
        end if;
        if r.attempts >= 6 then
            update private.azerdex_welcome_outbox set status = 'review_required', last_error_code = 'attempts_exhausted',
                   lease_until = null, lease_token = null, unknown_outcome = r.unknown_outcome, updated_at = now() where user_id = r.user_id;
            continue;
        end if;
        if r.unknown_outcome and r.first_send_at is not null and now() > r.first_send_at + interval '20 hours' then
            update private.azerdex_welcome_outbox set status = 'review_required', last_error_code = 'idempotency_window_elapsed',
                   lease_until = null, lease_token = null, unknown_outcome = true, updated_at = now() where user_id = r.user_id;
            continue;
        end if;

        -- Re-check the identity at the moment of dispatch.
        select * into u from auth.users where id = r.user_id;
        v_reason := case
            when not found then 'ineligible_deleted'
            when u.deleted_at is not null then 'ineligible_deleted'
            when u.banned_until is not null and u.banned_until > now() then 'ineligible_banned'
            when coalesce(u.is_anonymous, false) then 'ineligible_anonymous'
            when u.email_confirmed_at is null or u.email is null then 'ineligible_unverified'
            when sha256(convert_to(lower(u.email), 'UTF8')) <> r.email_sha256 then 'email_changed'
            else null end;
        if v_reason is not null then
            update private.azerdex_welcome_outbox set status = 'suppressed', last_error_code = v_reason, lease_until = null,
                   lease_token = null, email_sha256 = '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea,
                   updated_at = now() where user_id = r.user_id;
            continue;
        end if;

        v_token := gen_random_uuid();
        update private.azerdex_welcome_outbox
           set status = 'leased', attempts = attempts + 1, lease_until = now() + interval '180 seconds', lease_token = v_token,
               first_send_at = coalesce(first_send_at, now()), unknown_outcome = r.unknown_outcome,
               last_error_code = case when r.status = 'leased' then 'lease_expired' else last_error_code end, updated_at = now()
         where user_id = r.user_id;
        v_out := v_out || jsonb_build_object(
            'user_id', r.user_id,
            'recipient', u.email,
            'lease_token', v_token,
            'idempotency_key', 'azerdex-welcome-v1:' || r.user_id::text || ':' || r.idem_epoch::text,
            'attempt', r.attempts + 1);
    end loop;
    return v_out;
end
$fn$;

create or replace function public.azerdex_welcome_finish(
    p_user_id uuid,
    p_lease_token uuid,
    p_outcome text,
    p_provider_id text default null,
    p_error_code text default null,
    p_retry_after_seconds integer default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
    r        private.azerdex_welcome_outbox%rowtype;
    v_code   text;
    v_wait   integer;
    v_window boolean;
begin
    perform private.azerdex_welcome_require_server_role();
    if p_user_id is null or p_lease_token is null or p_outcome not in ('sent', 'retry', 'ambiguous', 'permanent') then
        return false;
    end if;
    select * into r from private.azerdex_welcome_outbox where user_id = p_user_id for update;
    -- A stale worker (lease taken over, row already finished, wrong token) can change nothing.
    if not found or r.status <> 'leased' or r.lease_token is distinct from p_lease_token then
        return false;
    end if;
    v_code := case when p_error_code in (
        'provider_rate_limited', 'provider_timeout', 'provider_transport', 'provider_5xx', 'provider_idempotency_conflict',
        'provider_malformed_response', 'provider_auth', 'provider_rejected', 'provider_4xx', 'circuit_open') then p_error_code
        else case when p_error_code is null then null else 'unknown_code' end end;
    v_wait := least(greatest(coalesce(p_retry_after_seconds, 0), least(3600, 60 * (2 ^ greatest(r.attempts - 1, 0))::integer)), 3600);

    if p_outcome = 'sent' then
        if p_provider_id is null or p_provider_id !~ '^[A-Za-z0-9_-]{8,64}$' then
            return false;
        end if;
        update private.azerdex_welcome_outbox
           set status = 'sent', sent_at = now(), provider_message_id = p_provider_id, last_error_code = null, lease_until = null,
               lease_token = null, unknown_outcome = false, email_sha256 = '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea,
               updated_at = now()
         where user_id = p_user_id;
        return true;
    end if;

    if p_outcome = 'permanent' then
        update private.azerdex_welcome_outbox set status = 'review_required', last_error_code = coalesce(v_code, 'provider_4xx'),
               lease_until = null, lease_token = null, updated_at = now() where user_id = p_user_id;
        return true;
    end if;

    if p_outcome = 'retry' and v_code = 'circuit_open' then
        -- Not attempted at all: give the attempt back and look again soon.
        update private.azerdex_welcome_outbox set status = 'retry', attempts = greatest(attempts - 1, 0), last_error_code = 'circuit_open',
               first_send_at = case when attempts <= 1 then null else first_send_at end, -- nothing was sent: do not start the idempotency clock
               next_attempt_at = now() + make_interval(secs => 300), lease_until = null, lease_token = null, updated_at = now()
         where user_id = p_user_id;
        return true;
    end if;

    -- retry (provider definitely did not send) or ambiguous (it may have): both are bounded by attempts; ambiguous is also bounded by the
    -- provider's idempotency window, after which an operator must reconcile with the provider's history.
    v_window := now() <= coalesce(r.first_send_at, now()) + interval '20 hours';
    if r.attempts >= 6 then
        update private.azerdex_welcome_outbox set status = 'review_required', last_error_code = 'attempts_exhausted',
               unknown_outcome = r.unknown_outcome or p_outcome = 'ambiguous', lease_until = null, lease_token = null, updated_at = now()
         where user_id = p_user_id;
    elsif p_outcome = 'ambiguous' and not v_window then
        update private.azerdex_welcome_outbox set status = 'review_required', last_error_code = 'idempotency_window_elapsed',
               unknown_outcome = true, lease_until = null, lease_token = null, updated_at = now() where user_id = p_user_id;
    else
        update private.azerdex_welcome_outbox
           set status = 'retry', last_error_code = coalesce(v_code, 'unknown_code'), next_attempt_at = now() + make_interval(secs => v_wait),
               unknown_outcome = r.unknown_outcome or p_outcome = 'ambiguous', lease_until = null, lease_token = null, updated_at = now()
         where user_id = p_user_id;
    end if;
    return true;
end
$fn$;

-- Aggregate counters for monitoring: no identifiers, no addresses.
create or replace function public.azerdex_welcome_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
    v_cfg private.azerdex_welcome_config%rowtype;
begin
    perform private.azerdex_welcome_require_server_role();
    select * into v_cfg from private.azerdex_welcome_config where singleton;
    return jsonb_build_object(
        'enqueue_enabled', v_cfg.enqueue_enabled,
        'dispatch_enabled', v_cfg.dispatch_enabled,
        'by_status', coalesce((select jsonb_object_agg(status, n) from (select status, count(*) n from private.azerdex_welcome_outbox group by status) s), '{}'::jsonb),
        'oldest_due_age_seconds', (select floor(extract(epoch from now() - min(next_attempt_at)))::bigint
                                     from private.azerdex_welcome_outbox where status in ('pending', 'retry') and next_attempt_at <= now()),
        'stale_pending_over_10m', (select count(*) from private.azerdex_welcome_outbox
                                    where status in ('pending', 'retry') and next_attempt_at < now() - interval '10 minutes'),
        'unknown_outcomes', (select count(*) from private.azerdex_welcome_outbox where unknown_outcome and status <> 'sent'),
        'review_required', (select count(*) from private.azerdex_welcome_outbox where status = 'review_required'),
        'candidates', (select count(*) from private.azerdex_welcome_candidates),
        'verified_not_enqueued', (select count(*) from private.azerdex_welcome_candidates c
                                   where c.verified_via_signup_at is not null
                                     and not exists (select 1 from private.azerdex_welcome_outbox o where o.user_id = c.user_id)),
        'trigger_failures_open', (select count(*) from private.azerdex_welcome_trigger_failures where handled_at is null),
        'signup_trigger_failures_open', (select count(*) from private.azerdex_welcome_trigger_failures where handled_at is null and phase = 'signup'));
end
$fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 6. Owner / operator procedures (private; run as the database owner only; never granted to an API role)
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.azerdex_welcome_set_switch(p_enqueue boolean, p_dispatch boolean)
returns void
language sql
security definer
set search_path = ''
as $fn$
    update private.azerdex_welcome_config
       set enqueue_enabled = coalesce(p_enqueue, enqueue_enabled),
           dispatch_enabled = coalesce(p_dispatch, dispatch_enabled),
           -- first activation fixes the cut-off: accounts registered before it can never become candidates
           activation_at = case when coalesce(p_enqueue, enqueue_enabled) then coalesce(activation_at, now()) else activation_at end,
           updated_at = now()
     where singleton;
$fn$;

-- Only for an event whose provider history the operator has checked and found NO message: new idempotency key, fresh attempts.
create or replace function private.azerdex_welcome_operator_requeue(p_user_id uuid, p_confirmed_not_sent boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    if p_confirmed_not_sent is not true then
        raise exception 'requeue refused: confirm in the provider history that no message was sent (p_confirmed_not_sent = true)';
    end if;
    update private.azerdex_welcome_outbox
       set status = 'retry', attempts = 0, idem_epoch = idem_epoch + 1, first_send_at = null, unknown_outcome = false,
           next_attempt_at = now(), lease_until = null, lease_token = null, last_error_code = null, updated_at = now()
     where user_id = p_user_id and status = 'review_required';
    -- A 'suppressed' row had its address hash zeroed: it could never pass the claim-time hash check again, so it is not requeueable.
    return found;
end
$fn$;

create or replace function private.azerdex_welcome_operator_resolve(p_user_id uuid, p_sent boolean, p_provider_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
begin
    if p_sent then
        if p_provider_id is null or p_provider_id !~ '^[A-Za-z0-9_-]{8,64}$' then
            raise exception 'resolve as sent needs the provider message id';
        end if;
        update private.azerdex_welcome_outbox
           set status = 'sent', sent_at = now(), provider_message_id = p_provider_id, last_error_code = 'operator_resolved',
               lease_until = null, lease_token = null, unknown_outcome = false,
               email_sha256 = '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea, updated_at = now()
         where user_id = p_user_id and status in ('review_required', 'retry', 'leased');
    else
        update private.azerdex_welcome_outbox
           set status = 'suppressed', last_error_code = 'operator_suppressed', lease_until = null, lease_token = null,
               email_sha256 = '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea, updated_at = now()
         where user_id = p_user_id and status in ('review_required', 'retry', 'pending', 'leased');
    end if;
    return found;
end
$fn$;

-- Bounded retention: unverified candidates after 30 days, handled failure markers after 30 days. Nothing that could re-enable a duplicate
-- for an existing account is removed (outbox rows stay until the account is deleted).
create or replace function private.azerdex_welcome_prune()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
    v_a integer;
    v_b integer;
begin
    delete from private.azerdex_welcome_candidates c
     where c.verified_via_signup_at is null and c.registered_at < now() - interval '30 days';
    get diagnostics v_a = row_count;
    delete from private.azerdex_welcome_trigger_failures where created_at < now() - interval '30 days' and (handled_at is not null or phase = 'signup');
    get diagnostics v_b = row_count;
    return v_a + v_b;
end
$fn$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 7. Privileges (explicit; Supabase default privileges would otherwise expose new public functions to anon/authenticated)
-- ---------------------------------------------------------------------------------------------------------------------
do $acl$
declare
    f text;
begin
    foreach f in array array[
        'private.azerdex_welcome_note_failure(uuid,text,boolean)',
        'private.azerdex_welcome_on_signup()',
        'private.azerdex_welcome_on_confirm()',
        'private.azerdex_welcome_reconcile()',
        'private.azerdex_welcome_require_server_role()',
        'private.azerdex_welcome_set_switch(boolean,boolean)',
        'private.azerdex_welcome_operator_requeue(uuid,boolean)',
        'private.azerdex_welcome_operator_resolve(uuid,boolean,text)',
        'private.azerdex_welcome_prune()',
        'public.azerdex_welcome_claim(integer)',
        'public.azerdex_welcome_finish(uuid,uuid,text,text,text,integer)',
        'public.azerdex_welcome_stats()'
    ] loop
        execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    end loop;
    grant execute on function public.azerdex_welcome_claim(integer) to service_role;
    grant execute on function public.azerdex_welcome_finish(uuid, uuid, text, text, text, integer) to service_role;
    grant execute on function public.azerdex_welcome_stats() to service_role;
end
$acl$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 8. Post-condition assertions (the migration aborts, and rolls back, on any surprise)
-- ---------------------------------------------------------------------------------------------------------------------
do $assert$
declare
    t text;
    r text;
    f record;
begin
    foreach t in array array['azerdex_welcome_config', 'azerdex_welcome_candidates', 'azerdex_welcome_outbox', 'azerdex_welcome_trigger_failures'] loop
        if not (select c.relrowsecurity and c.relforcerowsecurity from pg_class c where c.oid = ('private.' || t)::regclass) then
            raise exception '0015 assertion: RLS is not forced on private.%', t;
        end if;
        foreach r in array array['anon', 'authenticated', 'service_role'] loop
            if has_any_column_privilege(r, 'private.' || t, 'SELECT, INSERT, UPDATE, REFERENCES') or has_table_privilege(r, 'private.' || t, 'DELETE, TRUNCATE, TRIGGER') then
                raise exception '0015 assertion: role % has a privilege on private.%', r, t;
            end if;
        end loop;
        if exists (select 1 from pg_policy p where p.polrelid = ('private.' || t)::regclass) then
            raise exception '0015 assertion: private.% has a policy', t;
        end if;
    end loop;
    for f in
        select p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig
          from pg_proc p
         where p.proname like 'azerdex\_welcome\_%' and p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
    loop
        if not f.prosecdef or not exists (select 1 from unnest(coalesce(f.proconfig, '{}'::text[])) c where c like 'search_path=%') then
            raise exception '0015 assertion: % is not SECURITY DEFINER with a pinned search_path', f.sig;
        end if;
        if has_function_privilege('anon', f.sig, 'EXECUTE') or has_function_privilege('authenticated', f.sig, 'EXECUTE')
           or has_function_privilege('public', f.sig, 'EXECUTE') then
            raise exception '0015 assertion: % is executable by anon/authenticated/public', f.sig;
        end if;
    end loop;
    -- The shipped state is OFF. (Defaults, not current values: re-applying the idempotent body later must not fail because an owner
    -- has since switched the feature on.)
    if exists (select 1 from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
                where d.adrelid = 'private.azerdex_welcome_config'::regclass and a.attname in ('enqueue_enabled', 'dispatch_enabled')
                  and pg_get_expr(d.adbin, d.adrelid) <> 'false')
       or (select count(*) from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
            where d.adrelid = 'private.azerdex_welcome_config'::regclass and a.attname in ('enqueue_enabled', 'dispatch_enabled')) <> 2 then
        raise exception '0015 assertion: kill switches must default to OFF';
    end if;
end
$assert$;

commit;
