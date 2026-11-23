#!/usr/bin/env bash
# Exports the pinned ADM-03C paths (see adm03c.pin) from git into <outdir>. Refuses a moved ref: the commit must equal the pin.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
OUT="${1:?usage: fetch-adm03c.sh <outdir>}"
# shellcheck disable=SC1091
. "$HERE/adm03c.pin"
cd "$REPO"
git cat-file -e "$ADM03C_SHA^{commit}" 2>/dev/null || git fetch --no-tags --depth=1 origin "$ADM03C_SHA" 2>/dev/null || git fetch --no-tags origin "$ADM03C_REF"
[ "$(git rev-parse "$ADM03C_SHA^{commit}")" = "$ADM03C_SHA" ] || { echo "ADM-03C pin $ADM03C_SHA is not available" >&2; exit 1; }
rm -rf "$OUT"; mkdir -p "$OUT"
git archive "$ADM03C_SHA" \
  database/migrations/0026_editorial_delivery_control.sql \
  database/public-read/migrations/0013_cms_projection.sql \
  cms-delivery/src/once.mjs \
  web/src/app/news/rss.xml/route.ts web/src/app/sitemap.ts web/src/components/ArticleViews.tsx web/src/components/NewsArchive.tsx \
  web/src/components/content/ArticleReader.tsx web/src/lib/content/cms-public.ts | tar -x -C "$OUT"
echo "ADM-03C development dependency exported at $ADM03C_SHA into $OUT"
