#!/usr/bin/env bash
# Runs ONE pass of the real ADM-03C delivery worker (separate process, its own database roles) against the disposable stack. Run it after you
# press Publish or Unpublish in Admin to see the real delivery receipt arrive; then reload the article page.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="${STACK_DIR:-$HERE/.stack}"
. "$STACK_DIR/env"
[ "$E2E_DELIVERY" = 1 ] || { echo "this stack was started without the ADM-03C overlay (no delivery ledger)" >&2; exit 1; }
cd "$STACK_DIR/repo"
FDB_CMS_DISPOSABLE=1 FOREVERDB_DEPLOYMENT=local FDB_CMS_TEST_SET_ROLE=1 \
FDB_CMS_PRIVATE_URL="postgres://$E2E_PG_USER:$E2E_PG_PASSWORD@$E2E_PG_HOST:$E2E_PG_PORT/$E2E_DB" \
FDB_CMS_PUBLIC_URL="postgres://$E2E_PG_USER:$E2E_PG_PASSWORD@$E2E_PG_HOST:$E2E_PG_PORT/$E2E_PUBDB" \
FDB_CMS_ASSET_ROOT="$STACK_DIR/repo/web/public" \
  node "$STACK_DIR/cms-delivery/src/once.mjs"
