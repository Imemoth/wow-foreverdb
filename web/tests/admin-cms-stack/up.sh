#!/usr/bin/env bash
# ADM-04: the DISPOSABLE real-backend stack for the Admin CMS UI.
#
#   PostgreSQL 16  +  REAL GoTrue (pinned supabase/auth)  +  REAL PostgREST (pinned release)  +  the gateway shim (/auth/v1, /rest/v1)
#   private DB (migrations 0001-0012, 0018 history, then 0020-0025, [0026 overlay], 0027)  -> the staff Admin and the ADM-03B CMS
#   public-read DB (optional, only with the ADM-03C overlay)                              -> what the public website reads
#
# Nothing here touches Supabase or any hosted service: every credential is a public test constant of a throw-away cluster.
# ADM-03C (PR #206, unmerged) is a DEVELOPMENT DEPENDENCY: set FDB_ADM03C_DIR to a checkout of it (pinned by the CI workflow). Without it the
# stack still runs; the delivery ledger is absent so every publish intent reads "blocked" and nothing can become public (fail closed).
#
# Required env: PGHOST PGPORT PGUSER PGPASSWORD (SUPERUSER of the DISPOSABLE cluster), GOTRUE_BIN, POSTGREST_BIN
# Optional:     STACK_DIR (default ./.stack), FDB_ADM03C_DIR, NODE
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
STACK_DIR="${STACK_DIR:-$HERE/.stack}"; mkdir -p "$STACK_DIR"
: "${PGUSER:?}" "${PGPASSWORD:?}" "${GOTRUE_BIN:?}" "${POSTGREST_BIN:?}"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}"
case "$PGHOST" in 127.0.0.1|localhost|::1|/*) ;; *) echo "refusing PGHOST=$PGHOST: only a loopback/socket cluster is allowed" >&2; exit 1 ;; esac
NODE="${NODE:-node}"
JWT_SECRET="local-test-only-jwt-secret-0123456789abcdef0123456789abcdef"   # public test constant
DB="${FDB_IT_DB:-fdb_account_it}"; PUBDB=cms_public_it
GW=54321; REST=54323; REST_ADMIN=54327; TPL=54326
for p in 9999 $GW $REST $REST_ADMIN $TPL; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "port $p is in use: run down.sh first" >&2; exit 1; fi
done
# The admin migrations create CLUSTER-level roles (admin_executor, the 03C worker roles). A previous disposable run leaves them behind, and a
# role cannot be dropped while a database still holds its objects, so a re-run first drops the databases of every disposable suite.
for d in fdb_admin_it fdb_admin_it_rollback $PUBDB $DB; do psql -X -q -d postgres -c "drop database if exists $d with (force)" 2>/dev/null; done
for r in admin_executor azerdex_cms_dispatch azerdex_cms_delivery; do psql -X -q -d postgres -c "drop role if exists $r" 2>/dev/null; done
ANON_KEY="$("$NODE" "$REPO/web/tests/auth-stack/anon-key.mjs" "$JWT_SECRET")"

STACK_GATEWAY_PORT=$GW STACK_TEMPLATE_PORT=$TPL STACK_POSTGREST_URL="http://127.0.0.1:$REST" STACK_ANON_KEY="$ANON_KEY" \
  nohup "$NODE" "$REPO/web/tests/auth-stack/stack-server.mjs" >"$STACK_DIR/gateway.log" 2>&1 </dev/null & echo $! >"$STACK_DIR/gateway.pid"

# GoTrue: e-mail auto-confirm (no mail server in this stack), TOTP enrol/verify ON, refresh-token rotation ON.
cat >"$STACK_DIR/gotrue.env" <<ENV
API_EXTERNAL_URL=http://127.0.0.1:$GW/auth/v1
GOTRUE_SITE_URL=http://localhost:3220
GOTRUE_MAILER_AUTOCONFIRM=true
GOTRUE_JWT_EXP=3600
GOTRUE_RATE_LIMIT_SIGN_IN_SIGN_UPS=1000
GOTRUE_RATE_LIMIT_VERIFY=1000
GOTRUE_MFA_TOTP_ENROLL_ENABLED=true
GOTRUE_MFA_TOTP_VERIFY_ENABLED=true
GOTRUE_PASSWORD_MIN_LENGTH=8
ENV
export GOTRUE_BIN GOTRUE_JWT_SECRET="$JWT_SECRET" FDB_IT_RUN_DIR="$STACK_DIR/run" FDB_GOTRUE_ENV_FILE="$STACK_DIR/gotrue.env" FDB_IT_DB="$DB"
mkdir -p "$FDB_IT_RUN_DIR"
"$REPO/database/tests/account/stack.sh" up          # database, roles, REAL GoTrue (runs its own auth migrations), migrations 0001..0011
"$REPO/database/tests/account/stack.sh" apply       # 0012
"$REPO/database/tests/account/stack.sh" apply18     # 0018

migrator() { PGPASSWORD=local-test-password psql -X -q -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U fdb_migrator -d "$DB" "$@"; }
for n in 0020_admin_private_authorization 0021_admin_private_evaluator 0022_admin_auth_handoff 0023_admin_staff_lifecycle 0024_admin_editorial_boundary 0025_editorial_private_cms; do
  migrator -f "$REPO/database/migrations/$n.sql" >/dev/null
done
DELIVERY=0
if [ -n "${FDB_ADM03C_DIR:-}" ]; then
  migrator -f "$FDB_ADM03C_DIR/database/migrations/0026_editorial_delivery_control.sql" >/dev/null
  DELIVERY=1
fi
migrator -f "$REPO/database/migrations/0027_editorial_admin_reads.sql" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$HERE/activate-policy.sql"

if [ "$DELIVERY" = 1 ]; then
  # Separate public-read database for the website (what a real deployment keeps apart from the private CMS).
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $PUBDB with (force)" -c "create database $PUBDB"
  for n in 0001_public_read_model 0002_news_model 0008_news_ingest_role 0013_cms_projection; do
    if [ "$n" = 0013_cms_projection ]; then f="$FDB_ADM03C_DIR/database/public-read/migrations/$n.sql"; else f="$REPO/database/public-read/migrations/$n.sql"; fi
    psql -X -q -v ON_ERROR_STOP=1 -d "$PUBDB" -f "$f" >/dev/null
  done
  # A synthetic, fixed, public test key. Hosted activation provisions a random key out of band; this value must never be reused.
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "insert into editorial_private.delivery_mac_key(secret) values(pg_catalog.decode(pg_catalog.repeat('4a',32),'hex'))"
  psql -X -q -v ON_ERROR_STOP=1 -d "$PUBDB" -c "insert into cms_pub.delivery_mac_key(secret) values(pg_catalog.decode(pg_catalog.repeat('4a',32),'hex'))"
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -c "update editorial_private.delivery_control set enabled=true, reviewed_config_id='00000000-0000-0000-0000-000000000901' where singleton"
  psql -X -q -v ON_ERROR_STOP=1 -d "$PUBDB" -c "alter role foreverdb_web_reader login password 'local-test-only'" 2>/dev/null || true
fi

env -i PATH="$PATH" HOME="$STACK_DIR" \
  PGRST_DB_URI="postgres://authenticator:local-test-password@$PGHOST:$PGPORT/$DB" \
  PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$JWT_SECRET" \
  PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT=$REST PGRST_ADMIN_SERVER_PORT=$REST_ADMIN \
  PGRST_DB_MAX_ROWS=1000 PGRST_DB_POOL=10 PGRST_DB_TX_END=commit PGRST_LOG_LEVEL=info \
  "$POSTGREST_BIN" >"$STACK_DIR/postgrest.log" 2>&1 </dev/null & echo $! >"$STACK_DIR/postgrest.pid"
for i in $(seq 1 60); do curl -fsS -m 2 "http://127.0.0.1:$REST_ADMIN/ready" >/dev/null 2>&1 && break
  kill -0 "$(cat "$STACK_DIR/postgrest.pid")" 2>/dev/null || { echo "PostgREST exited" >&2; tail -30 "$STACK_DIR/postgrest.log" >&2; exit 1; }; sleep 1; done
curl -fsS -m 2 "http://127.0.0.1:$REST_ADMIN/ready" >/dev/null

cat >"$STACK_DIR/env" <<ENV
ACCOUNT_STACK_URL=http://127.0.0.1:$GW
ACCOUNT_STACK_ANON_KEY=$ANON_KEY
E2E_POSTGREST_URL=http://127.0.0.1:$REST
E2E_JWT_SECRET=$JWT_SECRET
E2E_DB=$DB
E2E_PUBDB=$PUBDB
E2E_DELIVERY=$DELIVERY
E2E_PG_HOST=$PGHOST
E2E_PG_PORT=$PGPORT
E2E_PG_USER=$PGUSER
E2E_PG_PASSWORD=$PGPASSWORD
E2E_STACK_DIR=$STACK_DIR
ENV
echo "admin CMS stack ready: gateway :$GW (auth+rest), PostgREST :$REST, database $DB, delivery ledger: $DELIVERY"
