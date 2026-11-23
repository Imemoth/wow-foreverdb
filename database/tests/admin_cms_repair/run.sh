#!/usr/bin/env bash
# ADM-03B/03C backend hotfix (migration 0028) against a DISPOSABLE PostgreSQL 16/17 cluster, a real PostgREST binary and the real delivery worker.
#
#   1. build the private + public databases exactly like database/tests/admin_cms_delivery/run.sh (migrations 0020-0026, synthetic Auth, MAC keys)
#   2. load the ADM-03B lifecycle fixtures, then REPRODUCE both defects on that populated database (before.sql)
#   3. apply migration 0028 as the non-superuser operator (a second apply must be refused)
#   4. SQL assertions (after.sql), a real two-session race, a real PostgREST regression, worker tests on the repaired database
#
# Required env: FDB_CMS_DISPOSABLE=1.  PG connection: PGHOST/PGPORT/PGPASSWORD (default 127.0.0.1:5432, password local-test-only, superuser postgres).
# FDB_POSTGREST_BIN = the pinned PostgREST v12.2.12 binary (the script downloads and checksum-verifies it when unset or missing).
set -euo pipefail
[ "${FDB_CMS_DISPOSABLE:-}" = 1 ] || exit 2
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}" PGPASSWORD="${PGPASSWORD:-local-test-only}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
here="$repo/database/tests/admin_cms_repair"
cd "$repo"
priv=fdb_admin_it; pubdb=cms_public_it
root=(psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$priv")
migrator=(psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d "$priv")
pub=(psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$pubdb")

# A re-run on the same cluster must start clean: cluster-level roles of the Admin migrations can only be dropped after their databases.
for d in "$priv" "$pubdb"; do dropdb -U postgres --if-exists --force "$d"; done
for r in admin_executor azerdex_cms_dispatch azerdex_cms_delivery; do psql -X -q -U postgres -d postgres -c "drop role if exists $r"; done
psql -X -qAt -U postgres -d postgres -c "select 1 from pg_roles where rolname='fdb_migrator'" | grep -qx 1 \
  || psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f database/tests/admin_private/bootstrap_roles.sql
createdb -U postgres "$priv"; createdb -U postgres "$pubdb"
"${root[@]}" -f database/tests/admin_private/bootstrap_db.sql
"${root[@]}" -f database/tests/admin_authorization/bootstrap_auth.sql
"${root[@]}" -f database/tests/admin_auth/bootstrap_mfa.sql
"${root[@]}" -c 'alter table auth.users add column email_confirmed_at timestamptz; alter table auth.users add column phone_confirmed_at timestamptz'
for n in 0020_admin_private_authorization 0021_admin_private_evaluator 0022_admin_auth_handoff 0023_admin_staff_lifecycle \
  0024_admin_editorial_boundary 0025_editorial_private_cms 0026_editorial_delivery_control; do
  "${migrator[@]}" -f "database/migrations/$n.sql"
done
for n in 0001_public_read_model 0002_news_model 0008_news_ingest_role 0013_cms_projection; do
  "${pub[@]}" -f "database/public-read/migrations/$n.sql"
done
# Synthetic, fixed, public test key (never a real key).
"${root[@]}" -c "insert into editorial_private.delivery_mac_key(secret) values(pg_catalog.decode(pg_catalog.repeat('4a',32),'hex'))"
"${pub[@]}" -c "insert into cms_pub.delivery_mac_key(secret) values(pg_catalog.decode(pg_catalog.repeat('4a',32),'hex'))"
"${root[@]}" -f database/tests/admin_cms/lifecycle.sql >/tmp/fdb-repair-lifecycle.log

"${root[@]}" -f "$here/before.sql"

# ---- migration 0028 as the reviewed non-superuser operator; applying it twice is refused
"${migrator[@]}" -f database/migrations/0028_editorial_hotfix_stale_and_highlighted.sql
if "${migrator[@]}" -f database/migrations/0028_editorial_hotfix_stale_and_highlighted.sql >/dev/null 2>&1; then
  echo '0028 was applied twice' >&2; exit 1; fi

"${root[@]}" -f "$here/after.sql"
echo 'ADM-03B/03C hotfix SQL: PASS'

# ---- a REAL PostgREST (pinned v12.2.12, checksum verified) in front of the repaired database
jwt_secret=local-test-only-jwt-secret-0123456789abcdef0123456789abcdef   # public test value
rest_bin="${FDB_POSTGREST_BIN:-/tmp/fdb-postgrest-v12.2.12}"
if [ ! -x "$rest_bin" ]; then
  archive="$(mktemp)"
  curl -fsSL --max-time 120 -o "$archive" 'https://github.com/PostgREST/postgrest/releases/download/v12.2.12/postgrest-v12.2.12-linux-static-x86-64.tar.xz'
  echo "5de4092f1719da3353c40bf96c8dec6913f2254a7cd0b61cc05f233153b557d5  $archive" | sha256sum -c - >/dev/null
  tar -xJOf "$archive" postgrest > "$rest_bin"; chmod 700 "$rest_bin"; rm -f "$archive"
fi
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'; }
rest_port="$(free_port)"; rest_admin_port="$(free_port)"
env -i PATH="$PATH" HOME="${TMPDIR:-/tmp}" \
  PGRST_DB_URI="postgres://authenticator:local-test-only@$PGHOST:$PGPORT/$priv" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
  PGRST_JWT_SECRET="$jwt_secret" PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT="$rest_port" PGRST_ADMIN_SERVER_PORT="$rest_admin_port" \
  PGRST_DB_TX_END=commit PGRST_DB_POOL=10 "$rest_bin" >/tmp/fdb-repair-postgrest.log 2>&1 &
rest_pid=$!
trap 'kill "$rest_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -fsS --max-time 1 "http://127.0.0.1:$rest_admin_port/ready" >/dev/null 2>&1 && break
  kill -0 "$rest_pid" 2>/dev/null || { tail -20 /tmp/fdb-repair-postgrest.log >&2; exit 1; }
  sleep 1
done
[ -d cms-delivery/node_modules ] || { echo "run: npm ci --prefix cms-delivery --ignore-scripts" >&2; exit 1; }
FDB_REPAIR_PG_URL="postgres://postgres:$PGPASSWORD@$PGHOST:$PGPORT/$priv" FDB_REPAIR_REST_URL="http://127.0.0.1:$rest_port" FDB_REPAIR_JWT_SECRET="$jwt_secret" \
  node cms-delivery/test/repair-postgrest.mjs

# ---- the REAL delivery worker on the repaired databases (highlighted publication, forged receipts, failure isolation, retry state, idempotency)
"${root[@]}" -f "$here/worker-fixtures.sql"
FDB_CMS_DISPOSABLE=1 FOREVERDB_DEPLOYMENT=local FDB_CMS_TEST_SET_ROLE=1 \
FDB_CMS_PRIVATE_URL="postgres://postgres:$PGPASSWORD@$PGHOST:$PGPORT/$priv" FDB_CMS_PUBLIC_URL="postgres://postgres:$PGPASSWORD@$PGHOST:$PGPORT/$pubdb" \
  node cms-delivery/test/repair-worker.mjs
if [ "${FDB_REPAIR_HTTP:-}" = 1 ]; then
  bash "$here/http.sh"
fi
echo 'ADM-03B/03C hotfix: PASS'
