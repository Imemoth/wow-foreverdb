#!/usr/bin/env bash
# Disposable integration stack for Account System V1 (migration 0012): PostgreSQL + REAL GoTrue (supabase/auth).
# NEVER point this at a real Supabase project. All credentials below are test-container-only.
#
#   stack.sh up        create the database, bootstrap roles, start GoTrue (it runs its own Auth migrations),
#                      then apply repository migrations 0001..0011 as the non-superuser migration role
#   stack.sh apply     apply 0012 as the migration role
#   stack.sh apply14   apply 0014 (zero-touch enrollment) as the migration role; requires `apply` first
#   stack.sh apply15   apply 0015 (account-scoped Guildbook) as the migration role; requires `apply14` first
#   stack.sh down      stop GoTrue and drop the database
#
# Required env: PGHOST PGPORT PGUSER PGPASSWORD of a SUPERUSER on a disposable cluster; GOTRUE_BIN = built GoTrue binary.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5432}"
: "${PGUSER:?superuser role of the disposable cluster}" "${PGPASSWORD:?}"
DB="${FDB_IT_DB:-fdb_account_it}"
GOTRUE_BIN="${GOTRUE_BIN:-$HERE/.run/gotrue}"   # build-gotrue.sh output
GOTRUE_PORT="${GOTRUE_PORT:-9999}"
RUN="${FDB_IT_RUN_DIR:-$HERE/.run}"; mkdir -p "$RUN"   # pid file, GoTrue log and the pre-0012 function baseline
JWT_SECRET="${GOTRUE_JWT_SECRET:-local-test-only-jwt-secret-0123456789abcdef0123456789abcdef}"
MIGRATOR_URL="postgres://fdb_migrator:local-test-password@$PGHOST:$PGPORT/$DB"

su_psql() { psql -X -q -v ON_ERROR_STOP=1 -d "$1" "${@:2}"; }
as_migrator() { PGPASSWORD=local-test-password psql -X -q -v ON_ERROR_STOP=1 -h "$PGHOST" -p "$PGPORT" -U fdb_migrator -d "$DB" "$@"; }

# Optional extra GoTrue settings (KEY=VALUE lines) that OVERRIDE the defaults below: the end-to-end stack (web/tests/e2e-stack) uses it to
# add mail capture, the Site URL and the callback allow list. Unset = this suite is byte-for-byte what it was.
gotrue_start() {
  EXTRA=()
  if [ -n "${FDB_GOTRUE_ENV_FILE:-}" ]; then mapfile -t EXTRA < <(grep -E '^[A-Z_0-9]+=' "$FDB_GOTRUE_ENV_FILE"); fi
  [ -x "$GOTRUE_BIN" ] || { echo "GoTrue binary not found: $GOTRUE_BIN (see build-gotrue.sh)" >&2; exit 2; }
  env -i PATH="$PATH" HOME="$RUN" \
    GOTRUE_DB_DRIVER=postgres \
    DATABASE_URL="postgres://supabase_auth_admin:local-test-password@$PGHOST:$PGPORT/$DB?search_path=auth" \
    GOTRUE_DB_AUTOMIGRATE=true \
    GOTRUE_API_HOST=127.0.0.1 GOTRUE_API_PORT="$GOTRUE_PORT" PORT="$GOTRUE_PORT" \
    API_EXTERNAL_URL="http://127.0.0.1:$GOTRUE_PORT" GOTRUE_SITE_URL="http://127.0.0.1:3000" \
    GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
    GOTRUE_DISABLE_SIGNUP=false GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=false \
    GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=true \
    GOTRUE_SMTP_HOST=127.0.0.1 GOTRUE_SMTP_PORT=1 GOTRUE_SMTP_ADMIN_EMAIL=noreply@example.invalid \
    GOTRUE_RATE_LIMIT_ANONYMOUS_USERS=1000 GOTRUE_RATE_LIMIT_EMAIL_SENT=1000 GOTRUE_RATE_LIMIT_TOKEN_REFRESH=1000 \
    GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true \
    LOG_LEVEL=info \
    ${EXTRA[@]+"${EXTRA[@]}"} \
    "$GOTRUE_BIN" > "$RUN/gotrue.log" 2>&1 &
  echo $! > "$RUN/gotrue.pid"
  for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:$GOTRUE_PORT/health" > /dev/null 2>&1; then return 0; fi
    kill -0 "$(cat "$RUN/gotrue.pid")" 2>/dev/null || { echo "GoTrue exited:" >&2; tail -30 "$RUN/gotrue.log" >&2; exit 3; }
    sleep 1
  done
  echo "GoTrue did not become healthy" >&2; tail -30 "$RUN/gotrue.log" >&2; exit 3
}

gotrue_stop() { [ -f "$RUN/gotrue.pid" ] && kill "$(cat "$RUN/gotrue.pid")" 2>/dev/null || true; rm -f "$RUN/gotrue.pid"; }

case "${1:-}" in
  up)
    gotrue_stop
    su_psql postgres -c "drop database if exists $DB with (force)"
    su_psql postgres -f "$HERE/00_bootstrap_roles.sql"
    su_psql postgres -c "create database $DB"
    su_psql "$DB" -v db="$DB" -f "$HERE/01_bootstrap_db.sql"
    gotrue_start
    su_psql "$DB" -f "$HERE/02_auth_functions.sql"
    # Realistic Supabase migration ledger (schema/table as the platform creates them) holding the entries production has through 0011.
    # 0012 is deliberately NOT recorded here; the ledger-backed rollback/restore tests record it on clones.
    su_psql "$DB" -f "$HERE/04_migration_ledger.sql"
    as_migrator -f "$HERE/03_historical_stubs.sql" > /dev/null
    for m in 0001_initial_schema 0002_sync_safety 0003_companion_auth 0004_remove_legacy_ingest 0005_guildbook_v1 0006_companion_search_zone; do
      as_migrator -f "$REPO/database/migrations/$m.sql" > /dev/null
    done
    as_migrator -f "$REPO/database/sql/search_location_api.sql" > /dev/null
    for m in 0008_zone_catalog_browse 0008a_close_unused_private_rpcs 0008b_prepare_authenticated_global_search 0009_api_security_rate_limits 0011_fix_observed_drop_rate_denominator; do
      as_migrator -f "$REPO/database/migrations/$m.sql" > /dev/null
    done
    # Baseline for the "existing functions are byte-identical" assertion: owner, ACL, config and md5(prosrc) of every
    # function in public/private BEFORE 0012 (the suite compares it with the database after 0012).
    as_migrator -At -c "select coalesce(json_agg(json_build_object('sig', p.oid::regprocedure::text, 'owner', pg_get_userbyid(p.proowner), 'acl', coalesce(p.proacl::text, ''), 'config', coalesce(p.proconfig, '{}'::text[]), 'md5', md5(p.prosrc)) order by p.oid::regprocedure::text), '[]'::json) from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)" > "$RUN/functions_before_0012.json"
    echo "stack up: database=$DB gotrue=http://127.0.0.1:$GOTRUE_PORT (history applied through 0011; 0012 NOT applied)"
    ;;
  apply)
    as_migrator -f "$REPO/database/migrations/0012_account_ownership_claims.sql"
    ;;
  apply14)
    as_migrator -f "$REPO/database/migrations/0014_zero_touch_enrollment.sql"
    ;;
  apply15)
    as_migrator -f "$REPO/database/migrations/0015_account_scoped_guildbook.sql"
    ;;
  down)
    gotrue_stop
    su_psql postgres -c "drop database if exists $DB with (force)"
    ;;
  *) echo "usage: $0 up|apply|apply14|down" >&2; exit 64 ;;
esac
