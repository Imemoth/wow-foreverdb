#!/usr/bin/env bash
# Stops the disposable Admin CMS stack and drops its databases.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
STACK_DIR="${STACK_DIR:-$HERE/.stack}"
for f in "$STACK_DIR"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
FDB_IT_RUN_DIR="$STACK_DIR/run" "$REPO/database/tests/account/stack.sh" down 2>/dev/null || true
psql -X -q -d postgres -c "drop database if exists cms_public_it with (force)" 2>/dev/null || true
for r in admin_executor azerdex_cms_dispatch azerdex_cms_delivery; do psql -X -q -d postgres -c "drop role if exists $r" 2>/dev/null || true; done
