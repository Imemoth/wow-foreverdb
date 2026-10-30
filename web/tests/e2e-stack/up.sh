#!/usr/bin/env bash
# Account System V1, PR E: the DISPOSABLE end-to-end stack.
#
#   PostgreSQL 16  +  REAL GoTrue (pinned supabase/auth tag)  +  REAL PostgREST (pinned release)  +  Mailpit (captured mail)
#   + a small gateway shim in the place of Kong (web/tests/auth-stack/stack-server.mjs, /auth/v1 and /rest/v1 pass-through)
#
# It never talks to a real Supabase project: every credential is a public test constant of a throw-away cluster. Nothing is
# emulated: the database is reached ONLY through PostgREST (JWT verification, role switch, transaction handling are PostgREST's own).
#
# Required env: PGHOST PGPORT PGUSER PGPASSWORD (superuser of the DISPOSABLE cluster, with track_commit_timestamp not required),
#               GOTRUE_BIN POSTGREST_BIN MAILPIT_BIN
# Optional:     STACK_DIR (default .stack), E2E_SITE_URL (default http://localhost:3210)
# Writes:       $STACK_DIR/env (coordinates), $STACK_DIR/versions.json (what was really started), $STACK_DIR/schema-cache.json
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
STACK_DIR="${STACK_DIR:-$HERE/.stack}"; mkdir -p "$STACK_DIR"
: "${PGUSER:?}" "${PGPASSWORD:?}" "${GOTRUE_BIN:?}" "${POSTGREST_BIN:?}" "${MAILPIT_BIN:?}"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}"
# The stack DROPS and recreates a database and creates roles: only ever against a disposable local cluster.
case "$PGHOST" in 127.0.0.1|localhost|::1|/*) ;; *) [ "${FDB_DISPOSABLE_CLUSTER:-}" = 1 ] || { echo "refusing PGHOST=$PGHOST: not a loopback/socket host (set FDB_DISPOSABLE_CLUSTER=1 only for a throw-away cluster)" >&2; exit 1; } ;; esac
NODE="${NODE:-node}"
SITE="${E2E_SITE_URL:-http://localhost:3210}"
JWT_SECRET="local-test-only-jwt-secret-0123456789abcdef0123456789abcdef"   # public test constant (same as database/tests/account)
DB="${FDB_IT_DB:-fdb_account_it}"
GW=54321; MAIL_HTTP=54324; MAIL_SMTP=54325; TPL=54326; REST=54323; REST_ADMIN=54327; REST_OVERRIDE=54328; REST_OVERRIDE_ADMIN=54329
# A leftover process from an earlier run on one of our ports would silently answer in place of the component under test (and sign tokens
# with another secret): refuse to start instead.
for p in 9999 $GW $MAIL_HTTP $MAIL_SMTP $TPL $REST $REST_ADMIN $REST_OVERRIDE $REST_OVERRIDE_ADMIN 54330; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "port $p is already in use: stop the previous stack first (tests/e2e-stack/down.sh)" >&2; exit 1; fi
done
ANON_KEY="$("$NODE" "$REPO/web/tests/auth-stack/anon-key.mjs" "$JWT_SECRET")"

# 1. Mailpit + the gateway (so GoTrue's mail and the website's /rest/v1 calls have somewhere to go from the first second).
nohup "$MAILPIT_BIN" --smtp 127.0.0.1:$MAIL_SMTP --listen 127.0.0.1:$MAIL_HTTP --database "$STACK_DIR/mailpit.db" >"$STACK_DIR/mailpit.log" 2>&1 </dev/null & echo $! >"$STACK_DIR/mailpit.pid"
STACK_GATEWAY_PORT=$GW STACK_TEMPLATE_PORT=$TPL STACK_POSTGREST_URL="http://127.0.0.1:$REST" STACK_ANON_KEY="$ANON_KEY" \
  nohup "$NODE" "$REPO/web/tests/auth-stack/stack-server.mjs" >"$STACK_DIR/gateway.log" 2>&1 </dev/null & echo $! >"$STACK_DIR/gateway.pid"

# The fault injector (chaos proxy): forwards untouched unless a TEST switches a mode (lost redemption reply, failing logout).
CHAOS_PORT=54330 CHAOS_UPSTREAM="http://127.0.0.1:$GW" nohup "$NODE" "$REPO/web/tests/e2e-stack/chaos-proxy.mjs" >"$STACK_DIR/chaos.log" 2>&1 </dev/null & echo $! >"$STACK_DIR/chaos.pid"

# 2. Database + real GoTrue + migrations 0001..0011 (the same bootstrap the SQL suite uses), with the settings of the product:
#    confirm e-mail ON, anonymous sign-in ON, refresh-token rotation ON, CAPTCHA / single-session / time-box / inactivity OFF.
cat >"$STACK_DIR/gotrue.env" <<ENV
API_EXTERNAL_URL=http://127.0.0.1:$GW/auth/v1
GOTRUE_SITE_URL=$SITE
GOTRUE_URI_ALLOW_LIST=$SITE/account/auth/confirm
GOTRUE_JWT_EXP=${E2E_JWT_EXP:-3600}
GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10
GOTRUE_SMTP_HOST=127.0.0.1
GOTRUE_SMTP_PORT=$MAIL_SMTP
GOTRUE_SMTP_USER=ci
GOTRUE_SMTP_PASS=ci
GOTRUE_SMTP_ADMIN_EMAIL=noreply@foreverdb.test
GOTRUE_SMTP_MAX_FREQUENCY=1s
GOTRUE_MAILER_TEMPLATES_CONFIRMATION=http://127.0.0.1:$TPL/confirmation.html
GOTRUE_MAILER_TEMPLATES_RECOVERY=http://127.0.0.1:$TPL/recovery.html
GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify
GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify
GOTRUE_RATE_LIMIT_SIGN_IN_SIGN_UPS=1000
GOTRUE_RATE_LIMIT_VERIFY=1000
GOTRUE_PASSWORD_MIN_LENGTH=8
ENV
export GOTRUE_BIN GOTRUE_JWT_SECRET="$JWT_SECRET" FDB_IT_RUN_DIR="$STACK_DIR/run" FDB_GOTRUE_ENV_FILE="$STACK_DIR/gotrue.env"
mkdir -p "$FDB_IT_RUN_DIR"
"$REPO/database/tests/account/stack.sh" up

# 3. REAL PostgREST, started BEFORE migration 0012 so the schema-cache reload after the migration is observed for real.
start_postgrest() { # name port admin_port tx_end
  env -i PATH="$PATH" HOME="$STACK_DIR" \
    PGRST_DB_URI="postgres://authenticator:local-test-password@$PGHOST:$PGPORT/$DB" \
    PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon PGRST_JWT_SECRET="$JWT_SECRET" \
    PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT="$2" PGRST_ADMIN_SERVER_PORT="$3" \
    PGRST_DB_MAX_ROWS=1000 PGRST_DB_POOL=10 PGRST_DB_TX_END="$4" PGRST_LOG_LEVEL=info \
    "$POSTGREST_BIN" >"$STACK_DIR/postgrest-$1.log" 2>&1 </dev/null &
  echo $! >"$STACK_DIR/postgrest-$1.pid"
}
start_postgrest main $REST $REST_ADMIN commit
# A SECOND instance with the DANGEROUS setting, used only by the test that proves why `db-tx-end` must stay `commit`.
start_postgrest override $REST_OVERRIDE $REST_OVERRIDE_ADMIN commit-allow-override
for port in $REST_ADMIN $REST_OVERRIDE_ADMIN; do
  for i in $(seq 1 60); do curl -fsS -m 2 "http://127.0.0.1:$port/ready" >/dev/null 2>&1 && break || sleep 1; [ "$i" = 60 ] && { echo "PostgREST on $port did not become ready"; tail -30 "$STACK_DIR"/postgrest-*.log; exit 1; }; done
done

probe() { curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$GW/rest/v1/rpc/fdb_account_installations"; }
BEFORE="$(probe)"

# 4. Migration 0012 (pre-flight inside), then wait for PostgREST to pick the new functions up: the migration ends with `notify pgrst, 'reload schema'`.
"$REPO/database/tests/account/stack.sh" apply
T0=$(date +%s%3N); AFTER=""
for i in $(seq 1 100); do AFTER="$(probe)"; [ "$AFTER" != "$BEFORE" ] && break; sleep 0.2; done
T1=$(date +%s%3N)
echo "{\"function_status_before_0012\": $BEFORE, \"function_status_after_0012\": $AFTER, \"reload_observed_ms\": $((T1-T0))}" >"$STACK_DIR/schema-cache.json"
[ "$BEFORE" = 404 ] && [ "$AFTER" != 404 ] || { echo "schema cache did not reload after 0012 (before=$BEFORE after=$AFTER)"; exit 1; }

# 4b. 0018 is deliberately part of this disposable acceptance environment: the cloud Guildbook RPCs must be unavailable, and a legacy
# payload that still carries guilds must store none, before the browser/API isolation tests start.
"$REPO/database/tests/account/stack.sh" apply18
GUILDBOOK_AFTER=""
for i in $(seq 1 100); do
  GUILDBOOK_AFTER="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" -H 'content-type: application/json' -d '{"p_installation_id":"x"}' "http://127.0.0.1:$GW/rest/v1/rpc/fdb_account_guildbook_guilds")"
  # PostgREST may keep the function in its schema cache while the ACL change lands: 401/403 (known RPC, no EXECUTE) and 404 (cache
  # omission) are all blocked cloud paths.
  { [ "$GUILDBOOK_AFTER" = 401 ] || [ "$GUILDBOOK_AFTER" = 403 ] || [ "$GUILDBOOK_AFTER" = 404 ]; } && break
  sleep 0.2
done
[ "$GUILDBOOK_AFTER" = 401 ] || [ "$GUILDBOOK_AFTER" = 403 ] || [ "$GUILDBOOK_AFTER" = 404 ] || { echo "cloud Guildbook revocation not effective after 0018 (status=$GUILDBOOK_AFTER)"; exit 1; }

# 5. What was REALLY started (recorded, not assumed).
GOTRUE_VERSION="$(curl -fsS "http://127.0.0.1:9999/health" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("unknown")}})')"
PGRST_VERSION="$("$POSTGREST_BIN" --version | head -1)"
PG_VERSION="$(psql -X -Atc 'show server_version')"
GOTRUE_COMMIT="$(grep -oE '4eee58f2[0-9a-f]*' "$REPO/database/tests/account/build-gotrue.sh" | head -1)"
cat >"$STACK_DIR/versions.json" <<JSON
{"gotrue": {"tag": "${GOTRUE_TAG:-v2.197.0}", "reported": "$GOTRUE_VERSION", "commit_prefix": "$GOTRUE_COMMIT"},
 "postgrest": "$PGRST_VERSION", "postgres": "$PG_VERSION", "mailpit": "${MAILPIT_TAG:-v1.31.5}",
 "postgrest_settings": {"db-tx-end": "commit (main) / commit-allow-override (override instance, negative test only)", "db-schemas": "public", "db-anon-role": "anon", "db-max-rows": 1000, "jwt": "HS256 shared secret with GoTrue"}}
JSON
cat >"$STACK_DIR/env" <<ENV
ACCOUNT_STACK_URL=http://127.0.0.1:$GW
ACCOUNT_STACK_ANON_KEY=$ANON_KEY
MAILPIT_URL=http://127.0.0.1:$MAIL_HTTP
STACK_JWT_EXP=${E2E_JWT_EXP:-3600}
E2E_GOTRUE_URL=http://127.0.0.1:9999
E2E_CHAOS_URL=http://127.0.0.1:54330
E2E_POSTGREST_URL=http://127.0.0.1:$REST
E2E_POSTGREST_OVERRIDE_URL=http://127.0.0.1:$REST_OVERRIDE
E2E_JWT_SECRET=$JWT_SECRET
E2E_DB=$DB
E2E_STACK_DIR=$STACK_DIR
ENV
echo "e2e stack ready: gateway :$GW (auth + rest), mailpit :$MAIL_HTTP, PostgREST :$REST ($PGRST_VERSION), schema reload after 0012 observed (status $BEFORE -> $AFTER)"
