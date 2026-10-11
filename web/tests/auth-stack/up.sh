#!/usr/bin/env bash
# Starts an EPHEMERAL Auth stack for the account acceptance suite: real GoTrue (built from a pinned supabase/auth tag),
# real PostgreSQL (already running; connection from PG* variables), Mailpit (captured mail) and the gateway shim.
# NEVER point this at a real Supabase project. All values below are public test constants.
#
#   required env: GOTRUE_BIN, MAILPIT_BIN, PGHOST, PGPORT, PGUSER (+ PGPASSWORD if the server asks for one), GOTRUE_DIR (supabase/auth checkout: migrations)
#   writes:       $STACK_DIR/env  (ACCOUNT_STACK_URL, ACCOUNT_STACK_ANON_KEY, MAILPIT_URL), logs and pid files in $STACK_DIR
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="${STACK_DIR:-$here/.stack}"; mkdir -p "$STACK_DIR"
NODE="${NODE:-node}"
JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"   # public test constant
DB="fdb_auth_$(date +%s)"
SITE="${STACK_SITE_URL:-http://localhost:3210}"
# Every website instance the acceptance suite starts has its own exact callback URL (no wildcards, no external domains).
ALLOW="$SITE/account/auth/confirm,http://localhost:3211/account/auth/confirm,https://localhost:3216/account/auth/confirm"

psql -v ON_ERROR_STOP=1 -q -d postgres -c "create database $DB"
psql -v ON_ERROR_STOP=1 -q -d "$DB" -v dbname="$DB" -f "$here/setup-db.sql"

export GOTRUE_API_HOST=127.0.0.1 PORT=9999 API_EXTERNAL_URL=http://127.0.0.1:54321/auth/v1
export GOTRUE_DB_DRIVER=postgres DB_NAMESPACE=auth
export GOTRUE_DB_DATABASE_URL="postgres://supabase_auth_admin:authpw@${PGHOST}:${PGPORT}/${DB}"
export GOTRUE_SITE_URL="$SITE" GOTRUE_URI_ALLOW_LIST="$ALLOW"
export GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP="${STACK_JWT_EXP:-25}" GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated GOTRUE_JWT_ADMIN_ROLES=service_role
# Settings the product REQUIRES (docs/account-v1/security.md 3.2) and the ones it FORBIDS (pr-obligations B8):
export GOTRUE_DISABLE_SIGNUP=false GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=false     # confirm e-mail ON
export GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=true                                                      # the Companion needs anonymous sign-in
export GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10
# (unset on purpose = off: CAPTCHA, single-session-per-user, session time-box, inactivity timeout)
export GOTRUE_SMTP_HOST=127.0.0.1 GOTRUE_SMTP_PORT=54325 GOTRUE_SMTP_USER=ci GOTRUE_SMTP_PASS=ci GOTRUE_SMTP_ADMIN_EMAIL=noreply@foreverdb.test GOTRUE_SMTP_MAX_FREQUENCY=1s
export GOTRUE_MAILER_TEMPLATES_CONFIRMATION=http://127.0.0.1:54326/confirmation.html GOTRUE_MAILER_TEMPLATES_RECOVERY=http://127.0.0.1:54326/recovery.html
export GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify
export GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 GOTRUE_RATE_LIMIT_ANONYMOUS_USERS=1000 GOTRUE_RATE_LIMIT_TOKEN_REFRESH=1000 GOTRUE_RATE_LIMIT_VERIFY=1000 GOTRUE_RATE_LIMIT_SIGN_IN_SIGN_UPS=1000
export GOTRUE_PASSWORD_MIN_LENGTH=8 GOTRUE_LOG_LEVEL=info

nohup "$MAILPIT_BIN" --smtp 127.0.0.1:54325 --listen 127.0.0.1:54324 --database "$STACK_DIR/mailpit.db" >"$STACK_DIR/mailpit.log" 2>&1 </dev/null & echo $! >"$STACK_DIR/mailpit.pid"
nohup "$NODE" "$here/stack-server.mjs" >"$STACK_DIR/gateway.log" 2>&1 </dev/null & echo $! >"$STACK_DIR/gateway.pid"
( cd "${GOTRUE_DIR:-.}" && nohup "$GOTRUE_BIN" >"$STACK_DIR/gotrue.log" 2>&1 </dev/null & echo $! >"$STACK_DIR/gotrue.pid" )

for i in $(seq 1 90); do
  if curl -fsS -m 2 -H "apikey: x" http://127.0.0.1:54321/auth/v1/health >/dev/null 2>&1 && curl -fsS -m 2 http://127.0.0.1:54324/api/v1/info >/dev/null 2>&1; then
    {
      echo "ACCOUNT_STACK_URL=http://127.0.0.1:54321"
      echo "ACCOUNT_STACK_ANON_KEY=$("$NODE" "$here/anon-key.mjs" "$JWT_SECRET")"
      echo "MAILPIT_URL=http://127.0.0.1:54324"
      echo "STACK_JWT_EXP=${STACK_JWT_EXP:-25}"
    } >"$STACK_DIR/env"
    echo "auth stack ready (database $DB); env in $STACK_DIR/env"; exit 0
  fi
  sleep 1
done
echo "auth stack failed to start; GoTrue log:"; tail -40 "$STACK_DIR/gotrue.log"; exit 1
