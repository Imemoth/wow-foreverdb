#!/usr/bin/env bash
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; STACK_DIR="${STACK_DIR:-$here/.stack}"
for n in gotrue gateway mailpit; do [ -f "$STACK_DIR/$n.pid" ] && kill "$(cat "$STACK_DIR/$n.pid")" 2>/dev/null; done; true
