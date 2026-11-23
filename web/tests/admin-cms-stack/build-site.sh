#!/usr/bin/env bash
# ADM-04: builds the website used by the Admin CMS end-to-end run into $STACK_DIR/site.
#
# With FDB_ADM03C_DIR (a checkout of ADM-03C / PR #206, a DEVELOPMENT DEPENDENCY) the files that PR owns are overlaid onto a COPY of web/ so the
# public pages can show delivered articles. The overlay exists only inside $STACK_DIR (git-ignored): nothing of ADM-03C is ever copied into this
# repository, and the list below is the complete set of web files PR #206 adds or changes.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
STACK_DIR="${STACK_DIR:-$HERE/.stack}"; COPY="$STACK_DIR/repo"; SITE="$COPY/web"
# A COPY of the whole repository (minus VCS and installed packages): web/ imports from ../scripts, ../supabase etc. and is type-checked in place.
rm -rf "$COPY"; mkdir -p "$COPY"
tar -C "$REPO" --exclude=.git --exclude=node_modules --exclude=.next --exclude=test-results --exclude=.stack -cf - . | tar -C "$COPY" -xf -
ln -s "$REPO/web/node_modules" "$SITE/node_modules"
if [ -n "${FDB_ADM03C_DIR:-}" ]; then
  for f in src/app/news/rss.xml/route.ts src/app/sitemap.ts src/components/ArticleViews.tsx src/components/NewsArchive.tsx src/components/content/ArticleReader.tsx src/lib/content/cms-public.ts; do
    mkdir -p "$SITE/$(dirname "$f")"; cp "$FDB_ADM03C_DIR/web/$f" "$SITE/$f"
  done
  # The worker (one-shot dispatcher) is also a 03C artifact. Its only dependency (pg 8.23.1) is the website's own.
  rm -rf "$STACK_DIR/cms-delivery"; mkdir -p "$STACK_DIR/cms-delivery"
  cp -r "$FDB_ADM03C_DIR/cms-delivery/src" "$STACK_DIR/cms-delivery/src"
  ln -sfn "$REPO/web/node_modules" "$STACK_DIR/cms-delivery/node_modules"
  printf '{"private":true,"type":"module"}\n' >"$STACK_DIR/cms-delivery/package.json"
fi
cd "$SITE"
. "$STACK_DIR/env"
export FOREVERDB_DEPLOYMENT=local ACCOUNT_AUTH_MODE=local ACCOUNT_AUTH_URL="$ACCOUNT_STACK_URL" ACCOUNT_AUTH_PUBLISHABLE_KEY="$ACCOUNT_STACK_ANON_KEY" \
  ACCOUNT_CSRF_SECRET="acceptance-csrf-secret-0123456789abcdefghijklmnop" SITE_URL="http://localhost:3220" NEXT_TELEMETRY_DISABLED=1 FOREVERDB_DATA_SOURCE=fixture
# Newer Next.js CLIs print a one-time advisory about the pinned Next.js version and stop; the build itself is unchanged by it, so retry once.
npx next build >"$STACK_DIR/build.log" 2>&1 || { tail -5 "$STACK_DIR/build.log"; echo "build stopped once; retrying" >&2; npx next build >"$STACK_DIR/build.log" 2>&1; }
tail -3 "$STACK_DIR/build.log"; test -f "$SITE/.next/BUILD_ID"
