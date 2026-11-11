#!/usr/bin/env bash
# AZR-004 Option G: validates database/ops/0020_ops_health_gated_rpc.sql (+ rollback, + 0021) END TO END on an EPHEMERAL PostgreSQL that this script creates and
# destroys itself, plus a real, version-pinned PostgREST over HTTP. Nothing here touches Supabase, a service, or any real credential: every key, password and
# JWT secret is generated per run, kept in memory/env, and never printed.
#
# Stages: (1) private cluster (verbose statement logging ON, to make the secret scan meaningful)  (2) base build + the Gate C tests  (3) hosted-like fixtures and a
# full effective-privilege snapshot  (4) apply 0020, verifier, exact privilege diff, privilege-chain proofs, refusal matrix, bounded overlap, role isolation, SQL
# hygiene  (5) vitest end to end through the real bot provider + handler + gated source  (6) real PostgREST: HTTP contract, role isolation, abuse and load  (7) scan
# every log for the key / signatures / headers  (8) destructive last: rollback (snapshot must equal the original), 0019-rollback ordering, re-apply, 0021.
# Env: none required. Optional: KEEP_WORK=1 keeps the work dir (logs contain only synthetic data); SKIP_POSTGREST=1 skips stage 6 (not for CI).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
FAILED=0
export NO_COLOR=1 FORCE_COLOR=0      # plain test output: the pass counts below are matched as text
passcount() { sed 's/\x1b\[[0-9;]*m//g' "$1" | command grep -E "Tests +[0-9]+ passed" | head -1 | sed 's/^ *//'; }
# `grep -q` exits at the first match; under `set -o pipefail` the producer then gets SIGPIPE and a SUCCESSFUL match can read as a failure, intermittently.
# This wrapper makes every quiet grep read all of its input, so pipelines are deterministic.
grep() {
  local args=() quiet=0 a
  for a in "$@"; do
    if [ "$a" = -q ]; then quiet=1
    elif [[ "$a" =~ ^-q(.+)$ ]]; then quiet=1; args+=("-${BASH_REMATCH[1]}")
    else args+=("$a"); fi
  done
  if [ "$quiet" = 1 ]; then command grep "${args[@]}" >/dev/null; else command grep "${args[@]}"; fi
}
fail() { echo "FAIL: $*"; FAILED=1; exit 1; }
pass() { echo "PASS: $*"; }

# ---------- tools
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
[ -x "$PGBIN/initdb" ] || fail "PostgreSQL server binaries not found (set PGBIN)"
export PATH="$PGBIN:$PATH"
command -v node >/dev/null || fail "node is required"
umask 077
WORK=$(mktemp -d /var/tmp/ops-gate.XXXXXX)
chmod 755 "$WORK"
PORT=$((5600 + RANDOM % 300))
if [ "$(id -u)" = 0 ]; then
  chown postgres "$WORK"
  as_pg() { su postgres -s /bin/bash -c "export PATH='$PATH'; $*"; }
else
  as_pg() { bash -c "$*"; }
fi
PIDS=""
: >"$WORK/keys"
cleanup() {
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  as_pg "pg_ctl -D '$WORK/pgdata' stop -m immediate >/dev/null 2>&1" || true
  if [ "${KEEP_WORK:-0}" = 1 ]; then echo "work dir kept: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# ---------- 1. private cluster, statement logging at its most verbose
as_pg "initdb -D '$WORK/pgdata' -U postgres -A trust --no-sync >/dev/null"
mkdir -p "$WORK/sock"; chmod 777 "$WORK/sock"; [ "$(id -u)" = 0 ] && chown postgres "$WORK/sock"
# Logging goes in postgresql.conf (NOT on the server command line: command-line settings would override the later ALTER SYSTEM of stage 6b).
as_pg "printf '%s\n' \"log_statement = 'all'\" \"log_min_error_statement = 'error'\" \"log_error_verbosity = 'verbose'\" \"log_connections = off\" \"max_connections = 100\" >> '$WORK/pgdata/postgresql.conf'"
as_pg "pg_ctl -D '$WORK/pgdata' -w -l '$WORK/pg.log' -o \"-k '$WORK/sock' -p $PORT -c listen_addresses=''\" start >/dev/null"
export PGHOST="$WORK/sock" PGPORT=$PORT PGUSER=postgres
psql -X -q -d postgres -c "select 1" >/dev/null || fail "private cluster did not start"
pass "stage 1: ephemeral PostgreSQL started (socket-only, log_statement=all as the verbose worst case)"

# ---------- 2. base: News migrations, G2 functions, 0019 and the Gate C SQL tests
./scripts/ops-health-sql-tests.sh >"$WORK/base.out" 2>&1 || { tail -20 "$WORK/base.out"; fail "base harness (ops-health-sql-tests.sh)"; }
pass "stage 2: base build and the Gate C SQL tests passed (database az_ops_health_sql, 0019 applied)"
DB=az_ops_health_sql
SU="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
AUTH="psql -X -q -tA -v ON_ERROR_STOP=1 -U authenticator -d $DB"

# ---------- 3. hosted-like fixtures (measured on the production project, 2026-11-10) and the baseline snapshots
AUTHPW=$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("hex"))')
$SU >/dev/null <<SQL
-- pg_net 0.20.4: the net schema is open to PUBLIC (by design); the Supabase default privileges in public; authenticator is NOINHERIT and member of the API roles
grant usage on schema net to public;
grant execute on all functions in schema net to public;
grant all on all tables in schema net to public;
grant all on all sequences in schema net to public;
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
create role authenticator login noinherit password '$AUTHPW';
grant anon, authenticated, service_role to authenticator;
alter role authenticator set statement_timeout = '8s';  alter role authenticator set lock_timeout = '8s';
alter role anon set statement_timeout = '3s';           alter role authenticated set statement_timeout = '8s';
create schema graphql_public;
create function graphql_public.graphql(a text, b text, c jsonb, d jsonb) returns jsonb language sql as \$\$ select '{}'::jsonb \$\$;
grant usage on schema graphql_public to anon, authenticated, service_role;
grant execute on function graphql_public.graphql(text,text,jsonb,jsonb) to anon, authenticated, service_role;
-- synthetic News data and the G6 job so the projection has something to report
insert into pub.news_sources (source_key, source_type, region, endpoint_url, last_attempt_at, last_fetch_ok_at, last_official_post_at) values
  ('h-us','bluepost','us','https://example.com/a', now()-interval '4 minutes', now()-interval '4 minutes', now()-interval '9 days'),
  ('h-eu','bluepost','eu','https://example.com/b', now()-interval '4 minutes', now()-interval '4 minutes', now()-interval '9 days') on conflict do nothing;
insert into cron.job (jobname, schedule, command, active) values ('azerdex-news-health','*/15 * * * *','select private.azerdex_news_assert_healthy()', true) on conflict do nothing;
insert into cron.job_run_details (jobid, status, start_time) select jobid, 'succeeded', now()-interval '7 minutes' from cron.job where jobname='azerdex-news-health';
SQL
unset AUTHPW

# Every privilege the API roles, the login roles and PUBLIC-derived access give, across the whole database (ACL view, one line per privilege).
snapshot() { $SU -tA <<'SQL'
with roles(r) as (values ('anon'),('authenticated'),('service_role'),('authenticator'),('azerdex_ops_reporter')),
user_ns as (select oid, nspname from pg_namespace where nspname not in ('information_schema','pg_catalog','pg_toast') and nspname !~ '^pg_(temp|toast_temp)')
select line from (
  select r.r || '|schema|' || n.nspname || '|' || p.priv as line from roles r cross join user_ns n cross join (values ('USAGE'),('CREATE')) p(priv) where has_schema_privilege(r.r, n.oid, p.priv)
  union all
  select r.r || '|relation|' || n.nspname || '.' || c.relname || '|' || p.priv from roles r cross join pg_class c join user_ns n on n.oid = c.relnamespace
    cross join (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
   where c.relkind in ('r','v','m','f','p') and has_table_privilege(r.r, c.oid, p.priv)
  union all
  select r.r || '|column|' || n.nspname || '.' || c.relname || '|' || p.priv from roles r cross join pg_class c join user_ns n on n.oid = c.relnamespace
    cross join (values ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(priv)
   where c.relkind in ('r','v','m','f','p') and has_any_column_privilege(r.r, c.oid, p.priv) and not has_table_privilege(r.r, c.oid, p.priv)
  union all
  select r.r || '|sequence|' || n.nspname || '.' || c.relname || '|' || p.priv from roles r cross join pg_sequence s join pg_class c on c.oid = s.seqrelid join user_ns n on n.oid = c.relnamespace
    cross join (values ('USAGE'),('SELECT'),('UPDATE')) p(priv) where has_sequence_privilege(r.r, s.seqrelid, p.priv)
  union all
  select r.r || '|function|' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')|EXECUTE' from roles r cross join pg_proc p join user_ns n on n.oid = p.pronamespace
   where p.prokind in ('f','p') and has_function_privilege(r.r, p.oid, 'EXECUTE')
  union all
  select r.r || '|database|' || current_database() || '|' || p.priv from roles r cross join (values ('CONNECT'),('CREATE'),('TEMPORARY')) p(priv) where has_database_privilege(r.r, current_database(), p.priv)
) s order by 1;
SQL
}
snapshot_sorted() { snapshot | LC_ALL=C sort; }
fp5() { $SU -tA <<'SQL'
select 'fingerprint cron.job|' || (select md5(coalesce(string_agg(jobid || '|' || jobname || '|' || schedule || '|' || command || '|' || active, '~' order by jobid), '')) from cron.job)
union all select 'fingerprint functions (outside ops_report and public.ops_health_report)|' || (select md5(coalesce(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || p.proowner::regrole::text || coalesce(p.proacl::text, '') || coalesce(p.proconfig::text, ''), '~' order by p.oid::regprocedure::text), ''))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema', 'ops_report') and not (n.nspname = 'public' and p.proname = 'ops_health_report'))
union all select 'fingerprint schemas+ACL (outside ops_report)|' || (select md5(coalesce(string_agg(nspname || coalesce(nspacl::text, '') || nspowner::regrole::text, '~' order by nspname), '')) from pg_namespace where nspname not in ('information_schema', 'ops_report') and nspname !~ '^pg_')
union all select 'fingerprint relations+ACL (outside ops_report)|' || (select md5(coalesce(string_agg(n.nspname || '.' || c.relname || coalesce(c.relacl::text, ''), '~' order by n.nspname, c.relname), ''))
   from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema', 'ops_report', 'pg_toast', 'pg_temp_1'))
union all select 'fingerprint roles (outside azerdex_ops_reporter)|' || (select md5(coalesce(string_agg(rolname || rolsuper::text || rolcreaterole::text || rolcanlogin::text || rolbypassrls::text, '~' order by rolname), '')) from pg_roles where rolname <> 'azerdex_ops_reporter' and rolname !~ '^pg_')
order by 1;
SQL
}
fp5_sorted() { fp5 | LC_ALL=C sort; }
snapshot_sorted >"$WORK/snap.before"; fp5_sorted >"$WORK/fp.before"
[ -s "$WORK/snap.before" ] && [ "$(wc -l <"$WORK/fp.before")" = 5 ] || fail "baseline capture"
pass "stage 3: fixtures in place; baseline effective-privilege snapshot ($(wc -l <"$WORK/snap.before") privileges) and 5 fingerprints recorded"

# ---------- 4. apply 0020 and prove it
$SU -f database/ops/0020_ops_health_gated_rpc.sql || fail "0020 did not apply"
pass "stage 4: 0020 applies"
fp5_sorted >"$WORK/fp.after"; cmp -s "$WORK/fp.before" "$WORK/fp.after" || { diff "$WORK/fp.before" "$WORK/fp.after" || true; fail "0020 changed an existing function, schema, relation ACL, role or cron job"; }
pass "fingerprints identical: jobs, every pre-existing function (body, owner, ACL, config), schemas, relations and roles are byte-for-byte unchanged"
$SU -f database/ops/0020_ops_health_gated_rpc.sql || fail "0020 is not idempotent"; fp5_sorted | cmp -s - "$WORK/fp.before" || fail "re-applying 0020 changed an existing object"
pass "0020 is idempotent"

# the verifier: exact grants, flags, owners, search_path, no dynamic SQL, key slots; its fingerprints must equal the harness's
psql -X -tA -v ON_ERROR_STOP=1 -d $DB -f database/ops/verify_ops_health_gated_rpc.sql >"$WORK/verify.out" || fail "verifier did not run"
if grep -q '^FAIL|' "$WORK/verify.out"; then grep '^FAIL|' "$WORK/verify.out"; fail "verifier reported FAIL"; fi
[ "$(grep -c '^PASS|' "$WORK/verify.out")" -ge 14 ] || { cat "$WORK/verify.out"; fail "verifier ran fewer checks than expected"; }
sed -n 's/^INFO|\(fingerprint .*\)$/\1/p' "$WORK/verify.out" | LC_ALL=C sort | cmp -s - "$WORK/fp.before" || fail "verifier fingerprints differ from the baseline"
grep -q 'CLOSED' "$WORK/verify.out" || fail "a fresh install must have the gate CLOSED until a key is created"
pass "verifier: $(grep -c '^PASS|' "$WORK/verify.out") checks PASS, 0 FAIL; its fingerprints equal the pre-0020 baseline; gate is CLOSED until a key exists"

# exact effective-privilege diff over the WHOLE database
snapshot_sorted >"$WORK/snap.after"
ADDED=$(comm -13 "$WORK/snap.before" "$WORK/snap.after"); REMOVED=$(comm -23 "$WORK/snap.before" "$WORK/snap.after")
EXPECTED=$(printf '%s\n' 'anon|function|ops_report.gated_health()|EXECUTE' 'anon|function|public.ops_health_report()|EXECUTE' 'anon|schema|ops_report|USAGE' | LC_ALL=C sort)
[ -z "$REMOVED" ] || { echo "$REMOVED"; fail "0020 removed privileges"; }
[ "$ADDED" = "$EXPECTED" ] || { echo "added:"; echo "$ADDED"; fail "effective-privilege change is not exactly the three expected grants to anon"; }
pass "effective privileges across the whole database changed by EXACTLY three grants, all to anon: USAGE ops_report, EXECUTE gated_health(), EXECUTE public.ops_health_report(); nothing for authenticated, service_role, authenticator or the reporter; nothing removed"
{ echo "## effective privilege change by 0020 (synthetic fixture; all roles)"; echo "$ADDED" | sed 's/^/+ /'; } >"$WORK/privilege-diff.txt"

KEY=$($SU -tA -c "select ops_report.rotate_gate_key()" | head -1); echo "${KEY}" >>"$WORK/keys"; [ "${#KEY}" -eq 64 ] || fail "rotate_gate_key output"
sign() { node -e 'const c=require("crypto");const [k,ts]=process.argv.slice(1);process.stdout.write(c.createHmac("sha256",Buffer.from(k,"hex")).update(ts+"\nGET\nops_health_report").digest("hex"))' "$1" "$2"; }
now_s() { date +%s; }
# One request as PostgREST would run it: login as authenticator, SET ROLE anon, request.headers / request.method set, call the wrapper. Output is never echoed (\g /dev/null) except the result.
call() { # ts sig [method]
  $AUTH -v ts="$1" -v sig="$2" -v method="${3:-GET}" 2>&1 <<'SQL'
begin; set local role anon;
select set_config('request.headers', json_build_object('x-azerdex-gate-ts', :'ts', 'x-azerdex-gate-sig', :'sig', 'user-agent', 'x')::text, true) \g /dev/null
select set_config('request.method', :'method', true) \g /dev/null
select (public.ops_health_report()->>'schemaVersion') || '|' || (public.ops_health_report()->>'overall');
rollback;
SQL
}
T=$(now_s); out=$(call "$T" "$(sign "$KEY" "$T")") || fail "valid signature refused: $out"
[ "$out" = "1|ok" ] || fail "unexpected result: $out"
pass "valid request (signature computed by an independent Node implementation) -> contract v1 report through authenticator -> SET ROLE anon -> public wrapper -> gated_health -> health()"
refused() { local name=$1; shift; local o; if o=$(call "$@" 2>&1); then fail "$name was ACCEPTED"; fi
  echo "$o" | grep -q 'ERROR:  unauthorized' || { echo "$o"; fail "$name refused for another reason"; }
  echo "$o" | grep -qE "$T|$KEY|x-azerdex|$(sign "$KEY" "$T")" && fail "$name: the error output leaks request data"; pass "refused (uniform 'unauthorized', no request data in the error): $name"; }
refused "wrong signature" "$T" "$(printf '0%.0s' $(seq 64))"
refused "signature of another timestamp" "$T" "$(sign "$KEY" "$((T-1))")"
refused "valid signature 120 s old" "$((T-120))" "$(sign "$KEY" "$((T-120))")"
refused "valid signature 120 s in the future" "$((T+120))" "$(sign "$KEY" "$((T+120))")"
refused "malformed timestamp" "12ab" "$(sign "$KEY" "$T")"
refused "malformed signature" "$T" "ZZ"
refused "uppercase-hex signature" "$T" "$(sign "$KEY" "$T" | tr a-f A-F)"
refused "unrelated key" "$T" "$(sign "$(printf 'ab%.0s' $(seq 32))" "$T")"
refused "POST with a valid signature (GET only)" "$T" "$(sign "$KEY" "$T")" POST
refused "HEAD with a valid signature" "$T" "$(sign "$KEY" "$T")" HEAD
o=$($AUTH 2>&1 <<'SQL' || true
begin; set local role anon; select public.ops_health_report(); rollback;
SQL
); echo "$o" | grep -q 'ERROR:  unauthorized' || fail "request without headers must be refused"; pass "refused: no request.headers / request.method at all"
call "$((T-55))" "$(sign "$KEY" "$((T-55))")" >/dev/null || fail "55 s old signature must still be accepted (window 60 s)"; pass "a signature 55 s old is accepted (window is 60 s)"

# bounded previous-key overlap
$SU -tA -c "select slot, expires_at is null from ops_report.gate_status()" | grep -qx 'current|t' || fail "gate_status current"
KEY2=$($SU -tA -c "select ops_report.rotate_gate_key()" | head -1); echo "${KEY2}" >>"$WORK/keys"; T=$(now_s)
call "$T" "$(sign "$KEY2" "$T")" >/dev/null || fail "new key refused after rotation"; call "$T" "$(sign "$KEY" "$T")" >/dev/null || fail "previous key refused inside the overlap"
$SU -tA -c "select abs(extract(epoch from (expires_at - created_at)) - 900) < 5 from ops_report.gate_keys where slot='previous'" >/dev/null
$SU -tA -c "select expires_at > now() + interval '14 minutes' and expires_at < now() + interval '16 minutes' from ops_report.gate_keys where slot='previous'" | grep -qx t || fail "default overlap is not 15 minutes"
pass "rotation: new key works; previous key works during the 15-minute overlap (expiry = rotation time + 15 min)"
$SU -c "update ops_report.gate_keys set expires_at = now() - interval '1 second' where slot = 'previous'"; T=$(now_s)
if call "$T" "$(sign "$KEY" "$T")" >/dev/null 2>&1; then fail "an expired previous key was accepted"; fi
call "$T" "$(sign "$KEY2" "$T")" >/dev/null || fail "current key broken by expiry of previous"
pass "the previous key stops working when its overlap ends, with NO further rotation (bounded, not 'until the next rotation')"
KEY3=$($SU -tA -c "select ops_report.rotate_gate_key('2 seconds')" | head -1); echo "${KEY3}" >>"$WORK/keys"; sleep 3; T=$(now_s)
if call "$T" "$(sign "$KEY2" "$T")" >/dev/null 2>&1; then fail "previous key survived a 2-second overlap"; fi
call "$T" "$(sign "$KEY3" "$T")" >/dev/null || fail "key3"
KEY4=$($SU -tA -c "select ops_report.rotate_gate_key(interval '0')" | head -1); echo "${KEY4}" >>"$WORK/keys"; T=$(now_s)
if call "$T" "$(sign "$KEY3" "$T")" >/dev/null 2>&1; then fail "overlap 0 must cut over immediately"; fi
call "$T" "$(sign "$KEY4" "$T")" >/dev/null || fail "key4"
for bad in "interval '-1 second'" "interval '61 minutes'" "null"; do
  if $SU -c "select ops_report.rotate_gate_key($bad)" >/dev/null 2>&1; then fail "rotate_gate_key($bad) must be rejected"; fi
done
[ "$($SU -tA -c "select count(*) from ops_report.gate_keys")" -le 2 ] || fail "more than two keys stored"
pass "overlap is configurable but bounded (0 to 1 hour; invalid values rejected); at most two keys ever exist"
$SU -c "select ops_report.revoke_gate()" >/dev/null; T=$(now_s)
if call "$T" "$(sign "$KEY4" "$T")" >/dev/null 2>&1; then fail "revoke_gate left a key valid"; fi
pass "ops_report.revoke_gate() is the instant kill switch (no key => everything refused, fail closed)"
KEY=$($SU -tA -c "select ops_report.rotate_gate_key()" | head -1); echo "${KEY}" >>"$WORK/keys"

# role isolation (SQL level), as the API roles and the login roles
for r in authenticated service_role; do
  if $AUTH -c "begin; set local role $r; select public.ops_health_report(); rollback;" >/dev/null 2>&1; then fail "$r can call the wrapper"; fi
  if $AUTH -c "begin; set local role $r; select ops_report.gated_health(); rollback;" >/dev/null 2>&1; then fail "$r can call gated_health"; fi
done
for r in anon authenticated service_role azerdex_ops_reporter; do
  for f in "select * from ops_report.gate_keys" "select ops_report.rotate_gate_key()" "select ops_report.revoke_gate()" "select * from ops_report.gate_status()"; do
    if $AUTH -c "begin; set local role $r; $f; rollback;" >/dev/null 2>&1; then fail "$r could run: $f"; fi
  done
done
if $AUTH -c "begin; set local role anon; select ops_report.health(); rollback;" >/dev/null 2>&1; then fail "anon can call the ungated health()"; fi
$SU -c "begin; set local role azerdex_ops_reporter; select ops_report.health(); rollback;" >/dev/null || fail "the existing reporter must still work until 0021"
if $SU -c "begin; set local role azerdex_ops_reporter; select ops_report.gated_health(); rollback;" >/dev/null 2>&1; then fail "the reporter can call gated_health"; fi
pass "role isolation: authenticated/service_role cannot call the wrapper or gate; only postgres can read gate_keys or call rotate/revoke/status; anon cannot call ungated health(); the existing reporter is unaffected"

# the complete chain: each link is necessary (revoke one in a rolled-back transaction and the call fails)
for stmt in "revoke usage on schema ops_report from anon" "revoke execute on function ops_report.gated_health() from anon" "revoke execute on function public.ops_health_report() from anon"; do
  o=$($SU 2>&1 <<SQL || true
begin; $stmt; set local role anon;
select set_config('request.headers', json_build_object('x-azerdex-gate-ts', '$(now_s)', 'x-azerdex-gate-sig', '$(printf '0%.0s' $(seq 64))')::text, true) \g /dev/null
select set_config('request.method', 'GET', true) \g /dev/null
select public.ops_health_report(); rollback;
SQL
  ); echo "$o" | grep -q 'permission denied' || { echo "$o"; fail "chain link not necessary: $stmt"; }
done
pass "privilege chain proved: USAGE on ops_report, EXECUTE on the wrapper and EXECUTE on gated_health are each necessary (removing any one gives 'permission denied')"

# SECURITY DEFINER hygiene: a hostile search_path in the CALLER's session must change nothing. The evil functions would turn a valid-but-hour-old signature into an
# accepted one if the definer resolved abs()/floor() through the caller's path; the definer pins pg_catalog, so the request is still refused.
T=$(now_s); OLDTS=$((T-3600)); OLDSIG=$(sign "$KEY" "$OLDTS")
$SU >/dev/null <<'SQL'
create schema evil;
create function evil.abs(bigint) returns bigint language sql as $$ select 0::bigint $$;
create function evil.abs(numeric) returns numeric language sql as $$ select 0::numeric $$;
create function evil.floor(numeric) returns numeric language sql as $$ select 0::numeric $$;
create function evil.floor(double precision) returns double precision language sql as $$ select 0::double precision $$;
grant usage on schema evil to public; grant execute on all functions in schema evil to public;
SQL
o=$($AUTH -v ts="$OLDTS" -v sig="$OLDSIG" 2>&1 <<'SQL' || true
begin;
set local search_path = evil, pg_catalog, public;
set local role anon;
select set_config('request.headers', json_build_object('x-azerdex-gate-ts', :'ts', 'x-azerdex-gate-sig', :'sig')::text, true) \g /dev/null
select set_config('request.method', 'GET', true) \g /dev/null
select ops_report.gated_health();
rollback;
SQL
)
$SU -c "drop schema evil cascade" >/dev/null
echo "$o" | grep -q 'unauthorized' || { echo "$o" | sed 's/[0-9a-f]\{40,\}/<redacted>/g' | head -5; fail "a hostile caller search_path changed the gate's behaviour"; }
pass "search_path hijack: with hostile abs()/floor() first in the caller's path, a valid but hour-old signature is still refused (definer functions pin pg_catalog and qualify every reference)"

# SQL-level secret hygiene: no key and no signature inside any function result or error; keys exist only in the table
$SU -tA -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='ops_report' and (p.prosrc ~* 'raise (notice|warning|log|info)' or p.prosrc ~* 'raise exception[^;]*(key|sig|header)')" | grep -qx 0 || fail "a function raises messages that could carry secrets"
pass "no function emits NOTICE/WARNING/LOG messages and no error message interpolates a key, signature or header"
echo "stage 4 done"

# ---------- 5. vitest: the real bot provider -> handler -> gated source -> SQL (psql shim), plus unit tests of the source
export OPS_HEALTH_GATE_E2E_DB=$DB OPS_HEALTH_GATE_E2E_KEY="$KEY"
( cd ops-bot && npx vitest run test/gate-g-source.test.ts test/gate-g-e2e.test.ts ) >"$WORK/vitest-e2e.out" 2>&1 || { tail -40 "$WORK/vitest-e2e.out"; fail "vitest source / e2e"; }
echo "INFO: e2e: $(passcount "$WORK/vitest-e2e.out")"
pass "stage 5: unit tests of the gated source and the end-to-end chain (bot provider -> handler -> source -> real SQL gate) passed"
unset OPS_HEALTH_GATE_E2E_KEY

# ---------- 6. real PostgREST over HTTP (pinned) with the abuse / load analysis
if [ "${SKIP_POSTGREST:-0}" = 1 ]; then echo "SKIPPED: stage 6 (SKIP_POSTGREST=1)"; else
  # shellcheck disable=SC1091
  . scripts/postgrest-pin.env
  DL="$WORK/postgrest-download"; BIN="$WORK/postgrest-bin"; mkdir -p "$DL" "$BIN"
  curl -fsSL --retry 3 --max-time 120 -o "$DL/$POSTGREST_ASSET" "https://github.com/PostgREST/postgrest/releases/download/$POSTGREST_VERSION/$POSTGREST_ASSET" || fail "PostgREST download"
  echo "$POSTGREST_SHA256  $DL/$POSTGREST_ASSET" | sha256sum -c --status - || fail "PostgREST asset sha256 does not match the pin in scripts/postgrest-pin.env"
  tar -xJf "$DL/$POSTGREST_ASSET" -C "$BIN"
  "$BIN/postgrest" --version | grep -q "${POSTGREST_VERSION#v}" || fail "PostgREST version is not ${POSTGREST_VERSION}"
  pass "stage 6: PostgREST $POSTGREST_VERSION downloaded and its sha256 matches the pin"
  JWTSECRET=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
  APIPORT=$((6100 + RANDOM % 500))
  export PGRST_DB_URI="postgresql://authenticator@/$DB?host=$WORK/sock&port=$PORT" PGRST_DB_SCHEMAS="public,graphql_public" PGRST_DB_ANON_ROLE=anon \
         PGRST_JWT_SECRET="$JWTSECRET" PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT=$APIPORT PGRST_DB_POOL=10 PGRST_LOG_LEVEL=info \
         PGRST_DB_EXTRA_SEARCH_PATH="public,extensions" PGRST_OPENAPI_MODE=follow-privileges PGRST_DB_CHANNEL_ENABLED=false
  "$BIN/postgrest" >"$WORK/postgrest.log" 2>&1 & PGRST_PID=$!; PIDS="$PIDS $PGRST_PID"
  for i in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$APIPORT/" && break; sleep 0.5; done
  kill -0 $PGRST_PID 2>/dev/null || { tail -20 "$WORK/postgrest.log"; fail "PostgREST did not start"; }
  export OPS_HEALTH_POSTGREST_URL="http://127.0.0.1:$APIPORT" OPS_HEALTH_POSTGREST_JWT_SECRET="$JWTSECRET" OPS_HEALTH_NEEDLES_FILE="$WORK/needles" OPS_HEALTH_KEYS_FILE="$WORK/keys" OPS_HEALTH_METRICS_FILE="$WORK/metrics" OPS_HEALTH_DB="$DB" OPS_HEALTH_POSTGREST_PID=$PGRST_PID OPS_HEALTH_LOAD_SECONDS="${OPS_HEALTH_LOAD_SECONDS:-12}"
  : >"$WORK/needles"
  ( cd ops-bot && npx vitest run --no-file-parallelism test/gate-g-http.test.ts test/gate-g-load.test.ts ) >"$WORK/vitest-http.out" 2>&1 || { tail -60 "$WORK/vitest-http.out"; fail "PostgREST HTTP tests"; }
  [ -s "$WORK/metrics" ] || fail "the load test recorded no metrics"
  sed 's/^/INFO: load: /' "$WORK/metrics"
  [ -n "$(passcount "$WORK/vitest-http.out")" ] || fail "PostgREST HTTP tests did not report a pass count"
  echo "INFO: http+load: $(passcount "$WORK/vitest-http.out")"
  pass "stage 6: real PostgREST HTTP contract, role isolation, negative cases, abuse and load tests passed"
  # stage 6b: the SAME HTTP suite again under the HOSTED logging profile (Supabase documents log_statement=ddl, log_min_error_statement=error, log_duration=off,
  # log_min_duration_statement=-1). Every refusal is an ERROR, so this shows whether a refused request's statement or signature is written to the log. Only the NEW log
  # content is scanned, and here NOTHING may match: no key, no signature, no header value.
  psql -X -q -d postgres -c "alter system set log_statement = 'ddl'" -c "alter system set log_min_error_statement = 'error'" -c "alter system set log_error_verbosity = 'default'" -c "select pg_reload_conf()" >/dev/null
  sleep 1; LOGOFF=$(stat -c %s "$WORK/pg.log")
  : >"$WORK/needles-hosted"; : >"$WORK/keys-hosted"
  ( cd ops-bot && OPS_HEALTH_NEEDLES_FILE="$WORK/needles-hosted" OPS_HEALTH_KEYS_FILE="$WORK/keys-hosted" npx vitest run test/gate-g-http.test.ts ) >"$WORK/vitest-http-hosted.out" 2>&1 || { tail -30 "$WORK/vitest-http-hosted.out"; fail "HTTP suite under the hosted logging profile"; }
  tail -c +$((LOGOFF + 1)) "$WORK/pg.log" >"$WORK/pg.hosted.log"; sed -i '/^$/d' "$WORK/needles-hosted" "$WORK/keys-hosted"
  [ -s "$WORK/pg.hosted.log" ] && [ -s "$WORK/needles-hosted" ] || fail "hosted-profile capture is empty"
  grep -F -q "ERROR:  unauthorized" "$WORK/pg.hosted.log" || fail "the hosted-profile log should contain the refusals (ERROR lines)"
  if grep -F -q -f "$WORK/keys-hosted" "$WORK/pg.hosted.log"; then fail "a gate KEY appears in the PostgreSQL log under the hosted profile"; fi
  if grep -F -q -f "$WORK/needles-hosted" "$WORK/pg.hosted.log"; then echo "--- hosted-profile log lines that contain a signature (signature redacted):"; grep -F -f "$WORK/needles-hosted" "$WORK/pg.hosted.log" | sed -E 's/[0-9a-f]{64}/<64hex>/g' | cut -c1-300 | head -5 || true; fail "a request signature appears in the PostgreSQL log under the hosted logging profile"; fi
  HOSTED_ERRORS=$(grep -c "ERROR:" "$WORK/pg.hosted.log" || true)
  pass "stage 6b: under the hosted logging profile the same suite produced $HOSTED_ERRORS ERROR log entries (refusals and permission errors) and NOT ONE key, signature or header value reached the PostgreSQL log"
  # stage 7: secret scan of every log produced while the tests ran. KEYS must appear in NO log; request signatures (valid 60 s, read-only report) are tolerated only in the
  # PostgreSQL log under the verbose log_statement=all worst case, and are reported, never silently accepted.
  sed -i '/^$/d' "$WORK/needles" "$WORK/keys"; [ -s "$WORK/needles" ] && [ -s "$WORK/keys" ] || fail "the tests recorded no keys/signatures to scan for"
  NKEYS=$(wc -l <"$WORK/keys"); NSIGS=$(wc -l <"$WORK/needles")
  kill $PGRST_PID 2>/dev/null || true; sleep 1
  for logf in "$WORK/postgrest.log" "$WORK/pg.log" "$WORK/vitest-e2e.out" "$WORK/vitest-http.out" "$WORK/verify.out" "$WORK/base.out"; do
    grep -F -q -f "$WORK/keys" "$logf" && fail "a gate KEY appears in $(basename "$logf")"
    grep -F -q "$JWTSECRET" "$logf" && fail "the JWT secret appears in $(basename "$logf")"
    if grep -F -q -f "$WORK/needles" "$logf"; then
      if [ "$(basename "$logf")" = pg.log ]; then
        SIGLINES=$(grep -F -c -f "$WORK/needles" "$logf" || true)
        echo "WARN: $SIGLINES lines of the PostgreSQL log contain a request signature (statement text/parameters under log_statement=all). The key never appears. Hosted default logging is log_statement=ddl (no DML)."
      else fail "a request signature appears in $(basename "$logf")"; fi
    fi
  done
  pass "stage 7: scanned $NKEYS gate keys and $NSIGS request signatures and the JWT secret against PostgREST, PostgreSQL and all test output: no key and no JWT secret appears anywhere; no signature appears in PostgREST or test output"
  unset JWTSECRET OPS_HEALTH_POSTGREST_JWT_SECRET PGRST_JWT_SECRET
fi

# ---------- 8. destructive last: rollback, ordering with the 0019 rollback, re-apply, 0021
$SU -f database/ops/0020_ops_health_gated_rpc_rollback.sql || fail "rollback did not run"
fp5_sorted | cmp -s - "$WORK/fp.before" || fail "rollback changed an object that 0020 did not create"
snapshot_sorted >"$WORK/snap.rolledback"; cmp -s "$WORK/snap.before" "$WORK/snap.rolledback" || { diff "$WORK/snap.before" "$WORK/snap.rolledback" || true; fail "after rollback the effective privileges differ from the original"; }
$SU -tA -c "select to_regclass('ops_report.gate_keys') is null and to_regprocedure('public.ops_health_report()') is null and to_regprocedure('ops_report.gated_health()') is null and to_regprocedure('ops_report.rotate_gate_key(interval)') is null and to_regprocedure('ops_report.health()') is not null" | grep -qx t || fail "rollback left objects or removed health()"
$SU -f database/ops/0020_ops_health_gated_rpc_rollback.sql || fail "rollback is not idempotent"
pass "stage 8: rollback removes exactly what 0020 added; the whole-database effective-privilege snapshot equals the original; fingerprints equal; idempotent; ops_report.health() and the existing reporter untouched"
$SU -f database/ops/0020_ops_health_gated_rpc.sql || fail "re-apply after rollback"
if $SU -f database/ops/0019_ops_health_report_rollback.sql >"$WORK/wrongorder.out" 2>&1; then fail "the 0019 rollback ran while gate_keys exists (it must refuse)"; fi
$SU -tA -c "select to_regclass('ops_report.gate_keys') is not null and to_regprocedure('ops_report.health()') is not null" | grep -qx t || fail "the refused 0019 rollback left a partial change"
pass "running the 0019 rollback BEFORE the 0020 rollback is refused and changes nothing (the documented order is enforced by PostgreSQL)"
$SU -f database/ops/0020_ops_health_gated_rpc_rollback.sql
$SU -f database/ops/0019_ops_health_report_rollback.sql || fail "0019 rollback in the right order"
$SU -f database/ops/0019_ops_health_report.sql || fail "re-apply 0019"; $SU -f database/ops/0020_ops_health_gated_rpc.sql || fail "re-apply 0020 after a full unwind"
pass "full unwind in the documented order (0020 rollback, then 0019 rollback) and a complete re-apply of 0019 then 0020 both work"
KEY=$($SU -tA -c "select ops_report.rotate_gate_key()" | head -1); echo "${KEY}" >>"$WORK/keys"
$SU -f database/ops/0021_drop_ops_reporter_login.sql || fail "0021 did not apply"
$SU -tA -c "select not exists (select 1 from pg_roles where rolname = 'azerdex_ops_reporter')" | grep -qx t || fail "0021 left the login role"
fp5_sorted | cmp -s - "$WORK/fp.before" || fail "0021 changed an existing object"
T=$(now_s); call "$T" "$(sign "$KEY" "$T")" >/dev/null || fail "the gated RPC broke after 0021"
$SU -f database/ops/0021_drop_ops_reporter_login.sql || fail "0021 is not idempotent"
psql -X -tA -v ON_ERROR_STOP=1 -d $DB -f database/ops/verify_ops_health_gated_rpc.sql | grep -q '^FAIL|' && fail "verifier fails after 0021"
pass "0021 removes the direct LOGIN role, is idempotent, changes no other object, leaves the gated RPC working, and the verifier still passes"
echo "OPS HEALTH GATED RPC CHECKS PASSED"
