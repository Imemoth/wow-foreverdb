#!/usr/bin/env bash
# Builds the REAL GoTrue (github.com/supabase/auth) from source for the disposable integration stack.
#
# Why from source: the CI Supabase local stack is only a set of Docker images; this suite needs just GoTrue + PostgreSQL, and building
# the pinned upstream commit keeps the version explicit and reproducible without a container runtime.
#   * Pinned to upstream master commit ce9a8eee0cc0 (2026-09-22) through its Go pseudo-version. Upstream's module path is
#     `github.com/supabase/auth` (no /v2 suffix), so release tags like v2.x are not resolvable by the Go tooling.
#   * Upstream go.mod carries a `replace` for a vendored fork of godotenv that is excluded from the module zip; it is removed and the
#     upstream godotenv version from go.sum/tidy is used. This does not touch session or token logic.
# Usage: build-gotrue.sh [output-path]   (default .run/gotrue next to this script)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${GOTRUE_VERSION:-v1.11.1-0.20260922104245-ce9a8eee0cc0}"
OUT="${1:-$HERE/.run/gotrue}"
mkdir -p "$(dirname "$OUT")"
WORK="$(mktemp -d)"
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

DIR="$(cd "$WORK" && go mod download -json "github.com/supabase/auth@$VERSION" | sed -n 's/.*"Dir": "\(.*\)",/\1/p')"
test -d "$DIR" || { echo "could not download github.com/supabase/auth@$VERSION" >&2; exit 2; }
cp -r "$DIR/." "$WORK/src"
chmod -R u+w "$WORK/src"
cd "$WORK/src"
sed -i '/^replace github.com\/joho\/godotenv/d' go.mod
go mod tidy
go build -o "$OUT" .
echo "built GoTrue $VERSION -> $OUT"
