#!/usr/bin/env bash
set -euo pipefail
[ "${FDB_CMS_DISPOSABLE:-}" = 1 ] || exit 2
[ -n "${FDB_CMS_CONTAINER:-}" ] && [ -n "${FDB_CMS_PUBLIC_PORT:-}" ] || exit 2

web_port="$(node -e 'const s=require("node:net").createServer(); s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
web_base="http://127.0.0.1:$web_port"
had_agents=0
[ -e web/AGENTS.md ] && had_agents=1
web_pid=''
cleanup() {
  if [ -n "$web_pid" ]; then kill -- -"$web_pid" 2>/dev/null || true; fi
  if [ "$had_agents" = 0 ] && [ -f web/AGENTS.md ] &&
     rg -q 'BEGIN:nextjs-agent-rules' web/AGENTS.md; then rm web/AGENTS.md; fi
}
trap cleanup EXIT

node --input-type=module -e "import {main} from './cms-delivery/src/once.mjs'; const r=await main(); if(r.delivered<1) process.exit(1)"
AZERDEX_READ_DB_URL="postgres://foreverdb_web_reader:local-test-only@127.0.0.1:$FDB_CMS_PUBLIC_PORT/cms_public_it" \
FOREVERDB_DATA_SOURCE=postgres SITE_URL="$web_base" \
  setsid npm run dev --prefix web -- --port "$web_port" >/tmp/adm03c-http-web.log 2>&1 &
web_pid=$!
ready=0
for _ in $(seq 1 60); do
  if curl -fsS "$web_base/news/cms-test-article" -o /tmp/adm03c-http-article.html 2>/dev/null; then
    ready=1; break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { tail -30 /tmp/adm03c-http-web.log; exit 1; }
rg -q 'A test article' /tmp/adm03c-http-article.html
curl -fsS "$web_base/news" -o /tmp/adm03c-http-archive.html
rg -q '/news/cms-test-article' /tmp/adm03c-http-archive.html
curl -fsS -D /tmp/adm03c-http-rss-headers.txt "$web_base/news/rss.xml" -o /tmp/adm03c-http-rss.xml
rg -q '/news/cms-test-article' /tmp/adm03c-http-rss.xml
rg -qi '^cache-control: .*no-store' /tmp/adm03c-http-rss-headers.txt
curl -fsS "$web_base/sitemap.xml" -o /tmp/adm03c-http-sitemap.xml
rg -q '/news/cms-test-article' /tmp/adm03c-http-sitemap.xml

docker exec "$FDB_CMS_CONTAINER" psql -U postgres -d fdb_admin_it -c \
  "update admin_private.direct_grants set status='revoked',revoked_at=clock_timestamp() where user_id='00000000-0000-0000-0000-000000000101' and permission_key='news.article.publish' and scope_id='00000000-0000-0000-0000-000000000401'" >/dev/null
node --input-type=module -e "import {main} from './cms-delivery/src/once.mjs'; const a=await main(); const b=await main(); if(a.compensated<1||b.delivered<1) process.exit(1)"
status="$(curl -sS -o /tmp/adm03c-http-after.html -w '%{http_code}' "$web_base/news/cms-test-article")"
[ "$status" = 404 ]
curl -fsS "$web_base/news" -o /tmp/adm03c-http-archive-after.html
! rg -q '/news/cms-test-article' /tmp/adm03c-http-archive-after.html
curl -fsS "$web_base/news/rss.xml" -o /tmp/adm03c-http-rss-after.xml
! rg -q '/news/cms-test-article' /tmp/adm03c-http-rss-after.xml
curl -fsS "$web_base/sitemap.xml" -o /tmp/adm03c-http-sitemap-after.xml
! rg -q '/news/cms-test-article' /tmp/adm03c-http-sitemap-after.xml
printf 'ADM-03C disposable HTTP article/archive/RSS/sitemap: PASS\n'
