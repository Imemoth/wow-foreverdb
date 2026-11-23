#!/usr/bin/env bash
# ADM-04: builds the website under test (a production build of this checkout, in place) with the disposable stack's coordinates, and makes the
# native ADM-03C worker (cms-delivery/) runnable. Run after up.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
STACK_DIR="${STACK_DIR:-$HERE/.stack}"
# The worker's only dependency (pg) is also the website's. CI installs it with `npm ci --prefix cms-delivery`; locally reuse web/node_modules.
if [ ! -d "$REPO/cms-delivery/node_modules" ]; then ln -s ../web/node_modules "$REPO/cms-delivery/node_modules"; fi
cd "$REPO/web"
. "$STACK_DIR/env"
export FOREVERDB_DEPLOYMENT=local ACCOUNT_AUTH_MODE=local ACCOUNT_AUTH_URL="$ACCOUNT_STACK_URL" ACCOUNT_AUTH_PUBLISHABLE_KEY="$ACCOUNT_STACK_ANON_KEY" \
  ACCOUNT_CSRF_SECRET="acceptance-csrf-secret-0123456789abcdefghijklmnop" SITE_URL="http://localhost:3220" NEXT_TELEMETRY_DISABLED=1 FOREVERDB_DATA_SOURCE=fixture
# Newer Next.js CLIs may print a one-time advisory and stop; the build itself is unchanged by it, so retry once.
npx next build >"$STACK_DIR/build.log" 2>&1 || { tail -5 "$STACK_DIR/build.log"; echo "build stopped once; retrying" >&2; npx next build >"$STACK_DIR/build.log" 2>&1; }
tail -3 "$STACK_DIR/build.log"; test -f "$REPO/web/.next/BUILD_ID"
