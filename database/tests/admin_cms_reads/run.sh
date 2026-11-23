#!/usr/bin/env bash
# ADM-04 read RPCs (0027) against a DISPOSABLE PostgreSQL cluster. Same bootstrap as database/tests/admin_cms/run.sh.
# Optional: FDB_ADMIN_WITH_DELIVERY=1 applies the ADM-03C delivery ledger (database/migrations/0026) first, so the delivery-status read is exercised
# against its real schema. Without it the inactive boundary is tested: every intent reads "blocked" and nothing can become public.
# Migration 0028 (ADM-03B/03C backend hotfix, merged) is part of the native stack and is applied here too. Default order: 0027 then 0028 (registry order).
# FDB_ADMIN_0028_FIRST=1 applies 0028 BEFORE 0027, proving the two additive migrations are order independent.
set -euo pipefail
[ "${FDB_ADMIN_DISPOSABLE:-}" = 1 ] || exit 2
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGPASSWORD="${PGPASSWORD:-local-test-only}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
db=fdb_admin_it   # bootstrap_db.sql is bound to this database name
root=(psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db")
migrator=(psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d "$db")
# The role bootstrap is not idempotent: run it only on a fresh cluster (CI) and reuse the roles on a local cluster.
psql -X -qAt -U postgres -d postgres -c "select 1 from pg_roles where rolname='fdb_migrator'" | grep -qx 1 \
  || psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f "$repo/database/tests/admin_private/bootstrap_roles.sql"
dropdb -U postgres --if-exists --force "$db"
dropdb -U postgres --if-exists --force "${db}_rollback"
# The Admin migrations create CLUSTER-level roles. A second run on the same disposable cluster (CI runs this suite with and without the delivery
# ledger) must start without the previous run's roles; they can only be dropped after the databases that hold their objects.
for r in admin_executor azerdex_cms_dispatch azerdex_cms_delivery; do
  psql -X -q -U postgres -d postgres -c "drop role if exists $r"
done
createdb -U postgres "$db"
"${root[@]}" -f "$repo/database/tests/admin_private/bootstrap_db.sql"
"${root[@]}" -f "$repo/database/tests/admin_authorization/bootstrap_auth.sql"
"${root[@]}" -f "$repo/database/tests/admin_auth/bootstrap_mfa.sql"
"${root[@]}" -c "alter table auth.users add column email_confirmed_at timestamptz;
  alter table auth.users add column phone_confirmed_at timestamptz"
for n in 0020_admin_private_authorization 0021_admin_private_evaluator \
  0022_admin_auth_handoff 0023_admin_staff_lifecycle 0024_admin_editorial_boundary \
  0025_editorial_private_cms; do
  "${migrator[@]}" -f "$repo/database/migrations/$n.sql"
done
delivery=0
if [ "${FDB_ADMIN_WITH_DELIVERY:-}" = 1 ]; then
  "${migrator[@]}" -f "$repo/database/migrations/0026_editorial_delivery_control.sql"
  delivery=1
fi
m0028="$repo/database/migrations/0028_editorial_hotfix_stale_and_highlighted.sql"
[ "${FDB_ADMIN_0028_FIRST:-}" = 1 ] && "${migrator[@]}" -f "$m0028"
"${migrator[@]}" -f "$repo/database/migrations/0027_editorial_admin_reads.sql"
[ "${FDB_ADMIN_0028_FIRST:-}" = 1 ] || "${migrator[@]}" -f "$m0028"
# 0028 is refused a second time too (pre-flight), whatever the order.
if "${migrator[@]}" -f "$m0028" >/dev/null 2>&1; then echo '0028 was applied twice' >&2; exit 1; fi
# Applying twice is refused (pre-flight), and the guarded rollback leaves the 0025 boundary intact.
if "${migrator[@]}" -f "$repo/database/migrations/0027_editorial_admin_reads.sql" >/dev/null 2>&1; then
  echo '0027 was applied twice' >&2; exit 1; fi
"${root[@]}" -v delivery="$delivery" -f "$here/reads.sql"
createdb -U postgres -T "$db" "${db}_rollback" 2>/dev/null || { dropdb -U postgres "${db}_rollback"; createdb -U postgres -T "$db" "${db}_rollback"; }
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "grant create on database ${db}_rollback to fdb_migrator"
psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d "${db}_rollback" -f "$repo/database/rollback/0027_editorial_admin_reads_rollback.sql"
psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d "${db}_rollback" \
  -c "select to_regprocedure('public.fdb_cms_articles(integer)') is null and to_regprocedure('public.fdb_cms_create_draft(uuid,text,jsonb,uuid)') is not null and to_regprocedure('public.fdb_cms_article(uuid)') is not null" | grep -qx t
dropdb -U postgres "${db}_rollback"
# Both migrations together: a stale revision is PT409 (not the retried 40001), through the very functions the Admin UI calls.
"${root[@]}" -v delivery="$delivery" -f "$here/combined_0027_0028.sql"
echo "ADM-04 read RPCs + 0028: PASS (delivery ledger present: $delivery, 0028 first: ${FDB_ADMIN_0028_FIRST:-0})"
