-- AzerDex Operations Bot (AZR-004, Option G): a gated, short-lived-signature RPC that lets the `azerdex-ops-health` Edge Function read the health
-- report through the Supabase Data API as plain `anon`, so the function no longer needs a direct PostgreSQL LOGIN credential.
-- OWNER/OPERATOR, run as the platform `postgres` admin on the azerdex-public-read project AFTER 0019_ops_health_report.sql. NOT applied by the repository:
-- it needs the owner's explicit approval (Decision 2). Roll back with 0020_ops_health_gated_rpc_rollback.sql.
--
-- WHAT IT ADDS (nothing that already exists is changed):
--   ops_report.gate_keys        table: at most two HMAC keys (`current`, and `previous` for a bounded overlap). No grants to anyone, RLS on with no policy.
--   ops_report.rotate_gate_key  creates a key INSIDE the database and returns it once to the operator (it is never written in a statement, migration or log).
--   ops_report.revoke_gate      deletes every key: the instant kill switch (no key => every request is refused).
--   ops_report.gate_status      operator-only: key slots, ages and validity (never the key).
--   ops_report.gated_health     the gate: verifies the request's HMAC, then returns ops_report.health() (the existing contract v1 projection).
--   public.ops_health_report    thin SECURITY INVOKER wrapper in the already-exposed schema `public` (no change to "Exposed schemas").
--
-- HOW A REQUEST IS AUTHORISED: headers `x-azerdex-gate-ts` (unix seconds) and `x-azerdex-gate-sig` = hex(HMAC-SHA256(key, "<ts>\nGET\nops_health_report")),
-- read from PostgREST's documented `request.headers` setting; the method must be GET (`request.method`); the timestamp must be within 60 s of the database
-- clock; the key may be the current key or a previous key that has not yet expired. Every refusal is the same error (SQLSTATE PT401 -> HTTP 401, message
-- `unauthorized`, no detail). There is deliberately NO failure counter or lock-out: it would let an anonymous caller lock the bot out.
--
-- PRIVILEGE CHAIN (proved by scripts/ops-health-gate-sql-tests.sh and database/ops/verify_ops_health_gated_rpc.sql):
--   anon -> USAGE ops_report, EXECUTE public.ops_health_report() [INVOKER] -> EXECUTE ops_report.gated_health() [DEFINER, owner postgres]
--        -> ops_report.health() [DEFINER] -> private.azerdex_news_health() and cron.*, all as the owner, inside the function only.
--   Nobody else (PUBLIC, authenticated, service_role, the reporter) can execute the new functions; only postgres can run rotate/revoke/status.
--   The DEFINER functions live in the UNEXPOSED schema ops_report, pin search_path = pg_catalog, use no dynamic SQL and qualify every reference.
begin;

-- Pre-flight: abort (changing nothing) unless 0019 is applied and pgcrypto is where the platform puts it.
do $do$
begin
    if to_regprocedure('ops_report.health()') is null then
        raise exception '0020 requires 0019_ops_health_report.sql (ops_report.health() is missing)';
    end if;
    if to_regprocedure('extensions.hmac(bytea,bytea,text)') is null
       or to_regprocedure('extensions.digest(bytea,text)') is null
       or to_regprocedure('extensions.gen_random_bytes(integer)') is null then
        raise exception '0020 requires pgcrypto (hmac, digest, gen_random_bytes) in schema extensions';
    end if;
end
$do$;

create table if not exists ops_report.gate_keys (
    slot       text primary key check (slot in ('current', 'previous')),
    key        bytea not null check (octet_length(key) = 32),
    created_at timestamptz not null default now(),
    expires_at timestamptz,
    constraint gate_keys_expiry check ((slot = 'current' and expires_at is null) or (slot = 'previous' and expires_at is not null))
);
alter table ops_report.gate_keys enable row level security;      -- no policy: even a stray grant would read nothing
revoke all on table ops_report.gate_keys from public, anon, authenticated, service_role;

-- Operator-only (postgres). The previous key stays valid for p_overlap (default 15 minutes, at most 1 hour, 0 = cut over immediately), then dies by itself.
create or replace function ops_report.rotate_gate_key(p_overlap interval default interval '15 minutes') returns text
language plpgsql security definer set search_path = pg_catalog as $$
declare
    k bytea;
begin
    if p_overlap is null or p_overlap < interval '0' or p_overlap > interval '1 hour' then
        raise exception 'overlap must be between 0 and 1 hour';
    end if;
    k := extensions.gen_random_bytes(32);
    delete from ops_report.gate_keys where slot = 'previous';
    update ops_report.gate_keys set slot = 'previous', expires_at = now() + p_overlap where slot = 'current';
    insert into ops_report.gate_keys (slot, key) values ('current', k);
    return encode(k, 'hex');
end
$$;

-- Operator-only: with no key the gate refuses everything.
create or replace function ops_report.revoke_gate() returns void
language sql security definer set search_path = pg_catalog as $$ delete from ops_report.gate_keys $$;

-- Operator-only: which keys exist and whether they are valid right now. Never returns key material.
create or replace function ops_report.gate_status() returns table (slot text, created_at timestamptz, expires_at timestamptz, valid boolean)
language sql stable security definer set search_path = pg_catalog as $$
    select gk.slot, gk.created_at, gk.expires_at, (gk.slot = 'current' or gk.expires_at > now())
      from ops_report.gate_keys gk order by gk.slot
$$;

-- The gate. Both key slots are always evaluated and compared as SHA-256 digests of both sides, so timing reveals nothing useful.
create or replace function ops_report.gated_health() returns jsonb
language plpgsql stable security definer set search_path = pg_catalog set statement_timeout = '5s' as $$
declare
    h jsonb;
    ts text;
    sig text;
    payload bytea;
    k record;
    ok boolean := false;
begin
    begin
        h := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
    exception when others then
        h := '{}'::jsonb;
    end;
    ts := h ->> 'x-azerdex-gate-ts';
    sig := h ->> 'x-azerdex-gate-sig';
    if current_setting('request.method', true) is distinct from 'GET'
       or ts is null or sig is null or ts !~ '^[0-9]{10}$' or sig !~ '^[0-9a-f]{64}$'
       or abs(floor(extract(epoch from now()))::bigint - ts::bigint) > 60 then
        raise exception 'unauthorized' using errcode = 'PT401';
    end if;
    payload := convert_to(ts || E'\nGET\nops_health_report', 'UTF8');
    for k in select gk.key from ops_report.gate_keys gk where gk.slot = 'current' or (gk.slot = 'previous' and gk.expires_at > now()) loop
        if extensions.digest(extensions.hmac(payload, k.key, 'sha256'), 'sha256') = extensions.digest(decode(sig, 'hex'), 'sha256') then
            ok := true;
        end if;
    end loop;
    if not ok then
        raise exception 'unauthorized' using errcode = 'PT401';
    end if;
    return ops_report.health();
end
$$;

-- Thin INVOKER wrapper in the already-exposed schema. It runs AS the caller (anon), so the caller needs USAGE on ops_report and EXECUTE on gated_health.
create or replace function public.ops_health_report() returns jsonb
language sql stable security invoker set search_path = pg_catalog as $$ select ops_report.gated_health() $$;

-- Strictly limited EXECUTE. The revokes on public.* also remove the platform's default grants to authenticated and service_role.
revoke all on function ops_report.rotate_gate_key(interval) from public, anon, authenticated, service_role;
revoke all on function ops_report.revoke_gate() from public, anon, authenticated, service_role;
revoke all on function ops_report.gate_status() from public, anon, authenticated, service_role;
revoke all on function ops_report.gated_health() from public, anon, authenticated, service_role;
revoke all on function public.ops_health_report() from public, anon, authenticated, service_role;
grant usage on schema ops_report to anon;
grant execute on function ops_report.gated_health() to anon;
grant execute on function public.ops_health_report() to anon;

commit;
