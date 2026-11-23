#!/usr/bin/env bash
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
image="${FDB_CMS_PG_IMAGE:-postgres:16}"
case "$image" in postgres:16|postgres:17) ;; *) exit 2;; esac
name="fdb-cms-delivery-$$"
docker run --rm -d --name "$name" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=local-test-only \
  -v "$repo:/src:ro" -w /src "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    fixture_mode="${FDB_CMS_WORKER_TEST:-0}"
    if [ "${FDB_CMS_HTTP_TEST:-}" = 1 ]; then fixture_mode=1; fi
    docker exec -e FDB_CMS_DISPOSABLE=1 -e FDB_CMS_WORKER_TEST="$fixture_mode" \
      -w /src "$name" bash database/tests/admin_cms_delivery/run.sh
    if [ "$fixture_mode" = 1 ]; then
      port="$(docker port "$name" 5432/tcp | sed -n 's/.*://p' | head -1)"
      export FDB_CMS_DISPOSABLE=1 FOREVERDB_DEPLOYMENT=local FDB_CMS_TEST_SET_ROLE=1
      export FDB_CMS_PRIVATE_URL="postgres://postgres:local-test-only@127.0.0.1:$port/fdb_admin_it"
      export FDB_CMS_PUBLIC_URL="postgres://postgres:local-test-only@127.0.0.1:$port/cms_public_it"
      if [ "${FDB_CMS_HTTP_TEST:-}" = 1 ]; then
        docker exec "$name" psql -U postgres -d cms_public_it \
          -c "alter role foreverdb_web_reader login password 'local-test-only'" >/dev/null
        FDB_CMS_CONTAINER="$name" FDB_CMS_PUBLIC_PORT="$port" \
          bash database/tests/admin_cms_delivery/http.sh
      else
        node cms-delivery/test/integration.mjs
      fi
    fi
    exit
  fi
  sleep 1
done
exit 1
