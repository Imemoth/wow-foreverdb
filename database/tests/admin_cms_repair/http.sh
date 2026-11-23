#!/usr/bin/env bash
# Public visibility over real HTTP for the hotfix scenarios (run by run.sh when FDB_REPAIR_HTTP=1, after cms-delivery/test/repair-worker.mjs):
#   highlighted article delivered by the real worker -> /news/<slug>, archive, RSS and sitemap; the unrelated article likewise;
#   the article whose delivery FAILED is not public anywhere. The website reads ONLY the separate public-read database as foreverdb_web_reader.
set -euo pipefail
[ "${FDB_CMS_DISPOSABLE:-}" = 1 ] || exit 2
: "${PGHOST:?}" "${PGPORT:?}" "${PGPASSWORD:?}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$repo"
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d cms_public_it -c "alter role foreverdb_web_reader login password 'local-test-only'"
web_port="$(node -e 'const s=require("node:net").createServer(); s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
base="http://127.0.0.1:$web_port"
had_agents=0; [ -e web/AGENTS.md ] && had_agents=1
web_pid=''
cleanup() {
  if [ -n "$web_pid" ]; then kill -- -"$web_pid" 2>/dev/null || true; fi
  if [ "$had_agents" = 0 ] && [ -f web/AGENTS.md ] && grep -q 'BEGIN:nextjs-agent-rules' web/AGENTS.md; then rm web/AGENTS.md; fi
}
trap cleanup EXIT
AZERDEX_READ_DB_URL="postgres://foreverdb_web_reader:local-test-only@$PGHOST:$PGPORT/cms_public_it" \
FOREVERDB_DATA_SOURCE=postgres FDB_CMS_DISPOSABLE=1 FOREVERDB_DEPLOYMENT=local SITE_URL="$base" NEXT_TELEMETRY_DISABLED=1 \
  setsid npm run dev --prefix web -- --port "$web_port" >/tmp/fdb-repair-http-web.log 2>&1 &
web_pid=$!
ready=0
for _ in $(seq 1 90); do
  if curl -fsS "$base/news/repair-highlighted" -o /tmp/fdb-repair-highlighted.html 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || { tail -30 /tmp/fdb-repair-http-web.log; exit 1; }
grep -q 'Repair highlighted article' /tmp/fdb-repair-highlighted.html
curl -fsS "$base/news/repair-unrelated-delivery" | grep -q 'Unrelated delivery article'
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$base/news/repair-failing-delivery")" = 404 ]
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$base/news/repair-forged-receipt")" = 404 ]
curl -fsS "$base/news" -o /tmp/fdb-repair-archive.html
grep -q '/news/repair-highlighted' /tmp/fdb-repair-archive.html
grep -q '/news/repair-unrelated-delivery' /tmp/fdb-repair-archive.html
! grep -q '/news/repair-failing-delivery' /tmp/fdb-repair-archive.html
curl -fsS -D /tmp/fdb-repair-rss-headers.txt "$base/news/rss.xml" -o /tmp/fdb-repair-rss.xml
grep -q '/news/repair-highlighted' /tmp/fdb-repair-rss.xml
! grep -q '/news/repair-failing-delivery' /tmp/fdb-repair-rss.xml
grep -Eiq '^cache-control: .*no-store' /tmp/fdb-repair-rss-headers.txt
curl -fsS "$base/sitemap.xml" -o /tmp/fdb-repair-sitemap.xml
grep -q '/news/repair-highlighted' /tmp/fdb-repair-sitemap.xml
! grep -q '/news/repair-failing-delivery' /tmp/fdb-repair-sitemap.xml
echo 'highlighted publication over HTTP (article, archive, RSS, sitemap): PASS'
