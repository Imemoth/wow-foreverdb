#!/usr/bin/env bash
# Builds the REAL GoTrue (github.com/supabase/auth) from the pinned upstream RELEASE TAG for the disposable integration stack.
#
# The pin is the same tag the web-auth suite (PR #49, .github/workflows/account-web-auth.yml GOTRUE_TAG) is verified against, so both
# real-GoTrue checks exercise one upstream revision. Override with GOTRUE_TAG only deliberately, and change BOTH workflows together.
# Usage: build-gotrue.sh [output-path]   (default .run/gotrue next to this script)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${GOTRUE_TAG:-v2.197.0}"
SHA="${GOTRUE_SHA:-4eee58f296d9698a1c2c0ae14d7a0b379c7622d3}"   # commit the tag must resolve to (a moved tag is refused)
OUT="${1:-$HERE/.run/gotrue}"
mkdir -p "$(dirname "$OUT")"
WORK="$(mktemp -d)"
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT
git clone -q --depth 1 --branch "$TAG" https://github.com/supabase/auth "$WORK/src"
test "$(git -C "$WORK/src" rev-parse HEAD)" = "$SHA" || { echo "tag $TAG no longer resolves to the pinned commit $SHA" >&2; exit 3; }
( cd "$WORK/src" && go build -o "$OUT" . )
echo "built GoTrue $TAG -> $OUT"
