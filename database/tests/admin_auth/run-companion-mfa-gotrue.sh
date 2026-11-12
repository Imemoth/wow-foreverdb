#!/usr/bin/env bash
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
pg_name="fdb_mfa_pg_$$"
auth_name="fdb_mfa_auth_$$"
net_name="fdb_mfa_net_$$"
db=fdb_mfa_it
image=ghcr.io/supabase/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b
cleanup() { [ -z "${rest_pid:-}" ] || kill "$rest_pid" >/dev/null 2>&1 || true; docker rm -f "$auth_name" "$pg_name" >/dev/null 2>&1 || true; docker network rm "$net_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$net_name" >/dev/null
docker run --rm -d --name "$pg_name" --network "$net_name" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=local-test-only postgres:17 >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$pg_name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$pg_name" createdb -U postgres "$db"
docker exec -i "$pg_name" psql -X -q -v ON_ERROR_STOP=1 -v db="$db" -U postgres -d "$db" < "$repo/database/tests/account/00_bootstrap_roles.sql"
docker exec -i "$pg_name" psql -X -q -v ON_ERROR_STOP=1 -v db="$db" -U postgres -d "$db" < "$repo/database/tests/account/01_bootstrap_db.sql"
docker run --rm -d --name "$auth_name" --network "$net_name" -p 127.0.0.1::9999 \
  -e GOTRUE_DB_DRIVER=postgres \
  -e DATABASE_URL="postgres://supabase_auth_admin:local-test-password@$pg_name:5432/$db?search_path=auth" \
  -e GOTRUE_DB_AUTOMIGRATE=true \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 \
  -e API_EXTERNAL_URL=http://127.0.0.1:9999 -e GOTRUE_SITE_URL=http://127.0.0.1:3000 \
  -e GOTRUE_JWT_SECRET=local-test-only-jwt-secret-0123456789abcdef0123456789abcdef \
  -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_DISABLE_SIGNUP=false -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
  -e GOTRUE_MAILER_AUTOCONFIRM=true -e GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=true \
  -e GOTRUE_MFA_TOTP_ENROLL_ENABLED=true -e GOTRUE_MFA_TOTP_VERIFY_ENABLED=true \
  -e GOTRUE_SMTP_HOST=127.0.0.1 -e GOTRUE_SMTP_PORT=1 -e GOTRUE_SMTP_ADMIN_EMAIL=noreply@example.invalid \
  "$image" >/dev/null
port=$(docker port "$auth_name" 9999/tcp | head -1 | awk -F: '{print $NF}')
[ -n "$port" ]
for _ in $(seq 1 90); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then break; fi
  sleep 1
done

# Rehearse the inactive Admin migrations on the same disposable real Auth schema.
docker exec "$pg_name" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db" \
  -c 'create schema supabase_migrations; create table supabase_migrations.schema_migrations(name text primary key);
      grant usage on schema supabase_migrations to fdb_migrator;
      grant select on supabase_migrations.schema_migrations to fdb_migrator' >/dev/null
for n in 0020_admin_private_authorization 0021_admin_private_evaluator 0022_admin_auth_handoff; do
  docker exec -i -e PGPASSWORD=local-test-password "$pg_name" psql -X -q -v ON_ERROR_STOP=1 \
    -h 127.0.0.1 -U fdb_migrator -d "$db" < "$repo/database/migrations/$n.sql"
done
if [ "${FDB_ADMIN_EDITORIAL:-}" = 1 ]; then
  for n in 0023_admin_staff_lifecycle 0024_admin_editorial_boundary; do
    docker exec -i -e PGPASSWORD=local-test-password "$pg_name" psql -X -q -v ON_ERROR_STOP=1 \
      -h 127.0.0.1 -U fdb_migrator -d "$db" < "$repo/database/migrations/$n.sql"
  done
fi

# Pin the real PostgREST version/checksum used by the repository's Account E2E stack.
rest_bin="${FDB_POSTGREST_BIN:-/tmp/fdb-admin-postgrest-v12.2.12}"
if [ ! -x "$rest_bin" ]; then
  archive=$(mktemp)
  curl -fsSL --max-time 60 -o "$archive" \
    'https://github.com/PostgREST/postgrest/releases/download/v12.2.12/postgrest-v12.2.12-linux-static-x86-64.tar.xz'
  echo "5de4092f1719da3353c40bf96c8dec6913f2254a7cd0b61cc05f233153b557d5  $archive" | sha256sum -c - >/dev/null
  tar -xJOf "$archive" postgrest > "$rest_bin"
  chmod 700 "$rest_bin"
  rm -f "$archive"
fi
pg_port=$(docker port "$pg_name" 5432/tcp | head -1 | awk -F: '{print $NF}')
rest_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
rest_admin_port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
PGRST_DB_URI="postgres://authenticator:local-test-password@127.0.0.1:$pg_port/$db" \
PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
PGRST_JWT_SECRET=local-test-only-jwt-secret-0123456789abcdef0123456789abcdef \
PGRST_SERVER_HOST=127.0.0.1 PGRST_SERVER_PORT="$rest_port" PGRST_ADMIN_SERVER_PORT="$rest_admin_port" \
PGRST_DB_TX_END=commit "$rest_bin" >/tmp/fdb-admin-postgrest.log 2>&1 &
rest_pid=$!
for _ in $(seq 1 60); do
  if curl -fsS --max-time 1 "http://127.0.0.1:$rest_admin_port/ready" >/dev/null 2>&1; then break; fi
  kill -0 "$rest_pid" || { tail -20 /tmp/fdb-admin-postgrest.log >&2; exit 1; }
  sleep 1
done
FDB_LOCAL_GOTRUE_URL="http://127.0.0.1:$port" FDB_LOCAL_REST_URL="http://127.0.0.1:$rest_port" \
FDB_LOCAL_PG_CONTAINER="$pg_name" FDB_LOCAL_PG_DATABASE="$db" \
  node "$repo/database/tests/admin_auth/companion-mfa-gotrue.mjs"
