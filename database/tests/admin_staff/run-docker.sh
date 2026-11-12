#!/usr/bin/env bash
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
name="fdb-admin-staff-it-$$"
image="${FDB_ADMIN_PG_IMAGE:-postgres:16}"
case "$image" in postgres:16|postgres:17) ;; *) echo 'unsupported disposable image' >&2; exit 2;; esac
docker run --rm -d --name "$name" --network none -e POSTGRES_PASSWORD=local-test-only \
  -v "$repo:/src:ro" -w /src "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    docker exec -e FDB_ADMIN_DISPOSABLE=1 -w /src "$name" bash database/tests/admin_staff/run.sh
    exit
  fi
  sleep 1
done
echo 'disposable PostgreSQL did not become ready' >&2
exit 1
