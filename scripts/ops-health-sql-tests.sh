#!/usr/bin/env bash
# Gate C: validates database/ops/0019_ops_health_report.sql (the read-only health projection and its least-privilege role) on a DISPOSABLE PostgreSQL:
# builds the same hosted-like database as news-sql-tests.sh (non-superuser admin, cron/net/vault stand-ins, News migrations, the G2 monitoring
# functions), seeds look-alikes of cron jobs 3 to 7, applies 0019, proves it changed NOTHING that already existed (functions, ACLs, schemas, roles,
# cron jobs), runs the projection / security assertions, proves idempotency, rolls it back and re-applies it.
# It leaves the database in the APPLIED state (named below) so test/gate-c-e2e.test.ts can drive the real function.
# EPHEMERAL SERVER ONLY. Env: PGHOST PGPORT PGUSER (superuser of a FRESH throwaway cluster: roles are cluster-wide).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}"
case "${PGHOST}" in localhost|127.0.0.1|/tmp|/var/run/postgresql|/var/tmp/*) ;; *) echo "Refusing non-local PGHOST=${PGHOST}"; exit 2;; esac
DB=${OPS_HEALTH_TEST_DB:-az_ops_health_sql}
for r in anon authenticated service_role; do psql -X -q -d postgres -c "create role $r nologin" 2>/dev/null || true; done
ADMIN_PW=${ADMIN_PW:-it-only-admin}
psql -X -q -d postgres -c "create role sbadmin login createrole createdb bypassrls inherit" 2>/dev/null || true
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "alter role sbadmin password '$ADMIN_PW'"
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $DB" -c "create database $DB owner sbadmin" >/dev/null
SU="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
$SU -f database/public-read/tests/hosted-stubs/supabase_stubs.sql >/dev/null
$SU -c "alter schema extensions owner to sbadmin" \
    -c "grant usage on schema vault, cron, net to sbadmin" \
    -c "grant select on vault.decrypted_secrets to sbadmin" -c "grant select, insert, update on vault.secrets to sbadmin" \
    -c "grant execute on all functions in schema vault, cron, net to sbadmin" \
    -c "grant select, insert, update, delete on all tables in schema cron to sbadmin" \
    -c "grant select, insert, update, delete on all tables in schema net to sbadmin" \
    -c "grant usage on all sequences in schema cron, net to sbadmin" >/dev/null
A="env PGPASSWORD=$ADMIN_PW psql -X -q -v ON_ERROR_STOP=1 -U sbadmin -d $DB"
for m in 0001_public_read_model 0002_news_model 0008_news_ingest_role 0009_news_ingest_search_path 0010_news_bluepost_suppression 0011_news_collector_v2 0012_news_revision_due_tolerance; do
  $A -f "database/public-read/migrations/$m.sql" >/dev/null 2>&1 || { echo "FAIL: migration $m"; $A -f "database/public-read/migrations/$m.sql" 2>&1 | tail -5; exit 1; }
done
# On Supabase the monitoring scripts are run by the platform `postgres` admin; the throwaway cluster's equivalent is its superuser.
$SU -f database/ops/0018_news_health_monitoring.sql >/dev/null 2>&1 || { echo "FAIL: 0018 monitoring did not apply"; exit 1; }
echo "PASS: News migrations and the G2 monitoring functions applied (hosted-like)"

# Look-alikes of the production cron jobs 3 to 7: they must be byte-identical before and after.
$SU >/dev/null <<'SQL'
insert into cron.job (jobid, jobname, schedule, command, active) values
  (3, 'azerdex-welcome-worker', '* * * * *', 'select net.http_post(url := ''https://example.invalid/w'')', true),
  (4, 'azerdex-retention-cleanup', '17 3 * * *', 'select 1', true),
  (5, 'azerdex-news-official', '*/30 * * * *', 'select net.http_post(url := ''https://example.invalid/o'')', true),
  (6, 'azerdex-news-blueposts', '*/10 * * * *', 'select net.http_post(url := ''https://example.invalid/b'')', true),
  (7, 'azerdex-news-health', '*/15 * * * *', 'select private.azerdex_news_assert_healthy()', true);
SQL

# Fingerprint of EVERYTHING that exists outside what 0019 adds: cron jobs, every function (body, owner, ACL, config) outside ops_report, every schema
# and relation ACL outside ops_report, and every role except the reporting role.
fp() { $SU -tA <<'SQL'
select md5(concat_ws('#',
  (select coalesce(string_agg(jobid || '|' || jobname || '|' || schedule || '|' || command || '|' || active, ';' order by jobid), '') from cron.job),
  (select coalesce(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || p.proowner::regrole::text || coalesce(p.proacl::text, '') || coalesce(p.proconfig::text, ''), ';' order by p.oid::regprocedure::text), '')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema', 'ops_report')),
  (select coalesce(string_agg(nspname || coalesce(nspacl::text, '') || nspowner::regrole::text, ';' order by nspname), '') from pg_namespace where nspname not in ('information_schema', 'ops_report') and nspname !~ '^pg_'),
  (select coalesce(string_agg(n.nspname || '.' || c.relname || coalesce(c.relacl::text, ''), ';' order by n.nspname, c.relname), '')
     from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema', 'ops_report', 'pg_toast', 'pg_temp_1')),
  (select coalesce(string_agg(rolname || rolsuper::text || rolcreaterole::text || rolcanlogin::text || rolbypassrls::text, ';' order by rolname), '') from pg_roles where rolname <> 'azerdex_ops_reporter' and rolname !~ '^pg_')
));
SQL
}
BEFORE=$(fp)
$SU -tAc "select (select count(*) from cron.job where jobid between 3 and 7) = 5" | grep -qx t || { echo "FAIL: cron job look-alikes missing"; exit 1; }

$SU -f database/ops/0019_ops_health_report.sql >/dev/null 2>&1 || { echo "FAIL: 0019 did not apply"; $SU -f database/ops/0019_ops_health_report.sql 2>&1 | tail -5; exit 1; }
[ "$(fp)" = "$BEFORE" ] || { echo "FAIL: 0019 changed something that existed before (functions, ACLs, schemas, roles or cron jobs)"; exit 1; }
echo "PASS: 0019 applies and changes no existing function, ACL, schema, role or cron job (jobs 3-7 and the G2 functions are byte-identical)"
$SU -f database/ops/0019_ops_health_report.sql >/dev/null 2>&1 || { echo "FAIL: 0019 is not idempotent"; exit 1; }
[ "$(fp)" = "$BEFORE" ] || { echo "FAIL: re-applying 0019 changed an existing object"; exit 1; }
echo "PASS: 0019 is idempotent"

out=$($SU -f database/public-read/tests/ops_health_report.sql 2>&1) || { echo "FAIL: ops_health_report"; echo "$out" | tail -12; exit 1; }
groups=$(echo "$out" | grep -c "NOTICE:  PASS" || true)
[ "$groups" -eq 12 ] || { echo "FAIL: ops_health_report ran $groups assertion groups (expected exactly 12)"; echo "$out" | tail -5; exit 1; }
echo "PASS: ops_health_report ($groups assertion groups: projection states, fail-closed, allow-list, privilege model, behaviour as the reporting role)"
[ "$(fp)" = "$BEFORE" ] || { echo "FAIL: the tests left a change behind"; exit 1; }

# Rollback: removes ONLY what 0019 added, is idempotent, and 0019 can be applied again.
$SU -f database/ops/0019_ops_health_report_rollback.sql >/dev/null 2>&1 || { echo "FAIL: 0019 rollback did not run"; $SU -f database/ops/0019_ops_health_report_rollback.sql 2>&1 | tail -5; exit 1; }
$SU -tAc "select not exists (select 1 from pg_namespace where nspname = 'ops_report') and not exists (select 1 from pg_roles where rolname = 'azerdex_ops_reporter')" | grep -qx t || { echo "FAIL: the rollback left the schema or the role behind"; exit 1; }
[ "$(fp)" = "$BEFORE" ] || { echo "FAIL: the rollback changed an object that 0019 did not create"; exit 1; }
$SU -f database/ops/0019_ops_health_report_rollback.sql >/dev/null 2>&1 || { echo "FAIL: the rollback is not idempotent"; exit 1; }
$SU -f database/ops/0019_ops_health_report.sql >/dev/null 2>&1 || { echo "FAIL: 0019 does not re-apply after the rollback"; exit 1; }
[ "$(fp)" = "$BEFORE" ] || { echo "FAIL: re-applying after the rollback changed an existing object"; exit 1; }
$SU -tAc "select has_function_privilege('azerdex_ops_reporter', 'ops_report.health()', 'execute')" | grep -qx t || { echo "FAIL: privileges missing after the re-apply"; exit 1; }
echo "PASS: rollback removes only the function, the schema and the role; it is idempotent; 0019 re-applies"
echo "OPS HEALTH SQL CHECKS PASSED (database $DB left in the applied state)"
