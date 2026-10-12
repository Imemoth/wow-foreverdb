#!/usr/bin/env bash
# Stops the disposable end-to-end stack and drops its database.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
STACK_DIR="${STACK_DIR:-$HERE/.stack}"
for f in "$STACK_DIR"/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; rm -f "$f"; done
FDB_IT_RUN_DIR="$STACK_DIR/run" "$REPO/database/tests/account/stack.sh" down 2>/dev/null || true
