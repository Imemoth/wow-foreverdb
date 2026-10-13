#!/usr/bin/env bash
# Disposable stack for the AzerDex welcome outbox suite: the Account System V1 stack (PostgreSQL + REAL GoTrue, migrations through 0012) with
# GoTrue's SMTP pointed at the in-process sink (smtp-sink.mjs, port 2525), then migration 0015. NEVER a real Supabase project.
#   stack.sh up      create the database + GoTrue, apply 0012 (account ownership; a realistic neighbour) and 0015
#   stack.sh down
# Requires the same env as database/tests/account/stack.sh (PGHOST/PGPORT/PGUSER/PGPASSWORD of a disposable superuser, built GoTrue).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
ACC="$REPO/database/tests/account/stack.sh"
export FDB_GOTRUE_ENV_FILE="$HERE/gotrue-sink.env"
DB="${FDB_IT_DB:-fdb_account_it}"
case "${1:-}" in
  up)
    "$ACC" up
    "$ACC" apply
    PGPASSWORD=local-test-password psql -X -q -v ON_ERROR_STOP=1 -h "${PGHOST:-127.0.0.1}" -p "${PGPORT:-5432}" -U fdb_migrator -d "$DB" \
      -f "$REPO/database/migrations/0015_azerdex_welcome_outbox.sql" 2>&1 | grep -v NOTICE || true
    echo "welcome stack up: 0012 + 0015 applied"
    ;;
  down) "$ACC" down ;;
  *) echo "usage: $0 up|down" >&2; exit 64 ;;
esac
