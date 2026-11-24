#!/usr/bin/env bash
# Starts the website built by build-site.sh on http://localhost:3220 against the running disposable stack (foreground; Ctrl-C stops it).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="${STACK_DIR:-$HERE/.stack}"
. "$STACK_DIR/env"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../.."
export FOREVERDB_DEPLOYMENT=local RATE_LIMIT_BACKEND=memory TRUSTED_IP_HEADER=x-forwarded-for NEXT_TELEMETRY_DISABLED=1 SITE_URL=http://localhost:3220 \
  ACCOUNT_AUTH_MODE=local ACCOUNT_AUTH_URL="$ACCOUNT_STACK_URL" ACCOUNT_AUTH_PUBLISHABLE_KEY="$ACCOUNT_STACK_ANON_KEY" \
  ACCOUNT_CSRF_SECRET="acceptance-csrf-secret-0123456789abcdefghijklmnop" FOREVERDB_DATA_SOURCE=fixture
export FOREVERDB_DATA_SOURCE=postgres FDB_CMS_DISPOSABLE=1 \
  AZERDEX_READ_DB_URL="postgres://foreverdb_web_reader:local-test-only@$E2E_PG_HOST:$E2E_PG_PORT/$E2E_PUBDB"
exec npx next start -p 3220
