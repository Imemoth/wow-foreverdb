#!/usr/bin/env bash
# Applies the public-read migrations the way Supabase's hosted `postgres` role does: as a NON-superuser with CREATEROLE,
# on a database that already has `anon`/`authenticated`/`service_role`, an `extensions` schema owned by that admin, and
# stand-ins for vault/pg_cron/pg_net. Catches privilege problems a superuser-only run hides (role ownership, ADMIN OPTION,
# GRANT ... WITH SET, extension schema placement). EPHEMERAL SERVER ONLY.
#
# Env: PGHOST PGPORT PGUSER (superuser of the throwaway server; must be a FRESH cluster: roles are cluster-wide).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}"
case "${PGHOST}" in localhost|127.0.0.1|/tmp|/var/run/postgresql) ;; *) echo "Refusing non-local PGHOST=${PGHOST}"; exit 2;; esac
DB=${HOSTED_DB:-az_hosted_pub}
S="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
$S -c "drop database if exists $DB" >/dev/null
for r in anon authenticated service_role; do psql -X -q -d postgres -c "create role $r nologin" 2>/dev/null || true; done
psql -X -q -d postgres -c "create role sbadmin login createrole createdb bypassrls inherit" 2>/dev/null || true
$S -c "create database $DB owner sbadmin" >/dev/null
SU="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
$SU -f database/public-read/tests/hosted-stubs/supabase_stubs.sql >/dev/null
$SU -c "alter schema extensions owner to sbadmin" \
    -c "grant usage on schema vault, cron, net to sbadmin" \
    -c "grant select on vault.decrypted_secrets to sbadmin" -c "grant select, insert, update on vault.secrets to sbadmin" \
    -c "grant execute on all functions in schema vault, cron, net to sbadmin" \
    -c "grant select, insert, update, delete on all tables in schema cron to sbadmin" \
    -c "grant select, insert on all tables in schema net to sbadmin" \
    -c "grant usage on all sequences in schema cron, net to sbadmin" >/dev/null
A="psql -X -q -v ON_ERROR_STOP=1 -U sbadmin -d $DB"
$A -c "select 'admin is superuser: ' || rolsuper from pg_roles where rolname = current_user" -t | grep -q "false" || { echo "FAIL: admin must not be superuser"; exit 1; }
$A -f database/public-read/migrations/0001_public_read_model.sql >/dev/null
$A -f database/public-read/migrations/0002_zone_map_points.sql >/dev/null
$A -f database/public-read/migrations/0003_publication_operations.sql >/dev/null
$A -f database/public-read/migrations/0005_source_map_points.sql >/dev/null
# pg_cron / pg_net are real extensions on Supabase; here their schemas are stubs.
sed -e '/^create extension if not exists pg_cron;/d' -e '/^create extension if not exists pg_net/d' \
    database/public-read/migrations/0004_publisher_schedule.sql | $A >/dev/null
echo "PASS: migrations 0001-0005 applied as a non-superuser admin"
# One real publication (synthetic fixture export) through the shared core + Node CLI as the dedicated login role.
# (the admin may SET ROLE to the web reader only for tests: the migrations never grant that)
$A -c "grant foreverdb_web_reader to current_user with set true, inherit false"
$A -c "alter role foreverdb_publisher login password 'it-only'" -c "alter role foreverdb_web_reader login password 'it-only'"
H=${PGHOST}; [ "${H#/}" != "$H" ] && H=localhost
export PUBLIC_PUBLISHER_DATABASE_URL="postgresql://foreverdb_publisher:it-only@${H}:${PGPORT}/${DB}"
out=$(cd publisher && npx tsx src/cli.ts publish --from-export ../database/tests/fixtures/synthetic_private_export.json)
echo "$out" | grep -q '"outcome":"activated"' || { echo "FAIL: first publication: $out"; exit 1; }
echo "PASS: first publication activated through the shared core"
$A -f database/public-read/tests/public_read_model_security.sql 2>&1 | grep -E "PASS|FAIL" || { echo "FAIL: security test"; exit 1; }
$A -f database/public-read/tests/public_read_operations.sql 2>&1 | grep -E "PASS|FAIL" || { echo "FAIL: operations test"; exit 1; }
echo "HOSTED COMPAT CHECKS PASSED"
