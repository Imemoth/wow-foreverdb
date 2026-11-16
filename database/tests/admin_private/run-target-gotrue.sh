#!/usr/bin/env bash
# Disposable PostgreSQL 17 + pinned real GoTrue compatibility check.
# Uses the repository's Supabase-like role/privilege fixture; never connects to hosted services.
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
gotrue_image=ghcr.io/supabase/gotrue@sha256:1736a63078f5922b198c4cbe50f80ab9a2d3b54fe8b7b6cfb2e9dc5dbbc12c6b
db_name=fdb_adm_target_it
pg_name=fdb_adm_target_pg_$$
auth_name=fdb_adm_target_auth_$$
net_name=fdb_adm_target_net_$$
cleanup() {
  docker rm -f "$auth_name" "$pg_name" >/dev/null 2>&1 || true
  docker network rm "$net_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create --internal "$net_name" >/dev/null
docker run --rm -d --name "$pg_name" --network "$net_name" \
  -e POSTGRES_PASSWORD=local-test-only postgres:17 >/dev/null
for _ in $(seq 1 60); do
  # The image entrypoint briefly runs a socket-only init server before starting
  # PostgreSQL normally. Require TCP readiness so createdb cannot race that server.
  if docker exec "$pg_name" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$pg_name" createdb -U postgres "$db_name"
docker exec -i "$pg_name" psql -X -q -v ON_ERROR_STOP=1 -v db="$db_name" -U postgres -d "$db_name" \
  < "$repo/database/tests/account/00_bootstrap_roles.sql"
docker exec -i "$pg_name" psql -X -q -v ON_ERROR_STOP=1 -v db="$db_name" -U postgres -d "$db_name" \
  < "$repo/database/tests/account/01_bootstrap_db.sql"
docker run --rm -d --name "$auth_name" --network "$net_name" \
  -e GOTRUE_DB_DRIVER=postgres \
  -e DATABASE_URL="postgres://supabase_auth_admin:local-test-password@$pg_name:5432/$db_name?search_path=auth" \
  -e GOTRUE_DB_AUTOMIGRATE=true \
  -e GOTRUE_API_HOST=0.0.0.0 -e GOTRUE_API_PORT=9999 \
  -e API_EXTERNAL_URL=http://127.0.0.1:9999 -e GOTRUE_SITE_URL=http://127.0.0.1:3000 \
  -e GOTRUE_JWT_SECRET=local-test-only-jwt-secret-0123456789abcdef0123456789abcdef \
  -e GOTRUE_JWT_EXP=3600 -e GOTRUE_JWT_AUD=authenticated \
  -e GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated \
  -e GOTRUE_DISABLE_SIGNUP=false -e GOTRUE_EXTERNAL_EMAIL_ENABLED=true \
  -e GOTRUE_MAILER_AUTOCONFIRM=false -e GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED=true \
  -e GOTRUE_SMTP_HOST=127.0.0.1 -e GOTRUE_SMTP_PORT=1 \
  -e GOTRUE_SMTP_ADMIN_EMAIL=noreply@example.invalid \
  "$gotrue_image" >/dev/null
ready=0
for _ in $(seq 1 90); do
  present=$(docker exec "$pg_name" psql -X -At -U postgres -d "$db_name" \
    -c "select to_regclass('auth.users') is not null" 2>/dev/null || true)
  health=$(docker exec "$pg_name" bash -c \
    "exec 3<>/dev/tcp/$auth_name/9999; printf 'GET /health HTTP/1.0\\r\\nHost: localhost\\r\\n\\r\\n' >&3; head -1 <&3" \
    2>/dev/null || true)
  if [ "$present" = t ] && [[ "$health" == *' 200 '* ]]; then ready=1; break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$auth_name" 2>/dev/null || true)" != true ]; then
    docker logs "$auth_name" 2>&1 | tail -25
    exit 1
  fi
  sleep 1
done
[ "$ready" = 1 ] || { docker logs "$auth_name" 2>&1 | tail -25; exit 1; }
docker exec "$pg_name" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db_name" \
  -c "create schema supabase_migrations; create table supabase_migrations.schema_migrations(name text primary key); grant usage on schema supabase_migrations to fdb_migrator; grant select on supabase_migrations.schema_migrations to fdb_migrator" >/dev/null
operator_ok=$(docker exec "$pg_name" psql -X -At -U postgres -d "$db_name" \
  -c "select current_setting('server_version_num')::integer / 10000 = 17
    and (select rolcreaterole and rolbypassrls and not rolsuper from pg_roles where rolname='fdb_migrator')
    and has_table_privilege('fdb_migrator','auth.users','REFERENCES')
    and (select count(*) from information_schema.columns where table_schema='auth' and table_name='users') >= 30")
[ "$operator_ok" = t ] || { echo "GoTrue/Auth schema or migration operator preflight failed" >&2; exit 1; }
docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
  psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
  < "$repo/database/migrations/0020_admin_private_authorization.sql"
migration_ok=$(docker exec "$pg_name" psql -X -At -U postgres -d "$db_name" \
  -c "select (select count(*) from admin_private.permission_catalog) = 22
    and (select version_id from admin_private.active_policy) = 0
    and (select count(*) from admin_private.staff_subjects) = 0
    and (select count(*) from admin_private.role_permissions where version_id=1) = 30
    and (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
         where relnamespace='admin_private'::regnamespace and relkind='r')
    and not has_schema_privilege('authenticated','admin_private','USAGE')
    and not has_table_privilege('service_role','admin_private.staff_subjects','SELECT')
    and exists (select 1 from pg_constraint where conrelid='admin_private.staff_subjects'::regclass
                and confrelid='auth.users'::regclass and confdeltype='r')")
[ "$migration_ok" = t ] || { echo "GoTrue/Auth migration security assertions failed" >&2; exit 1; }
if [ "${FDB_ADMIN_EVALUATOR:-}" = 1 ]; then
  docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
    psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
    < "$repo/database/migrations/0021_admin_private_evaluator.sql"
  evaluator_ok=$(docker exec "$pg_name" psql -X -At -U postgres -d "$db_name" \
    -c "select pg_get_userbyid(proowner)='admin_executor' and prosecdef
      and not has_function_privilege('authenticated',oid,'EXECUTE')
      and not has_function_privilege('anon',oid,'EXECUTE')
      and (select version_id from admin_private.active_policy)=0
      and (select count(*) from admin_private.staff_subjects)=0
      from pg_proc where oid='admin_private.authorize_action(text,text,text,text)'::regprocedure")
  [ "$evaluator_ok" = t ] || { echo "real-GoTrue evaluator boundary failed" >&2; exit 1; }
  auth_probe=$(docker exec "$pg_name" psql -X -At -U postgres -d "$db_name" \
    -c "set role admin_executor;
        select admin_private.live_auth_session(
          '00000000-0000-0000-0000-000000000101',
          '00000000-0000-0000-0000-000000000201')")
  [ "${auth_probe##*$'\n'}" = f ] || { echo "real-GoTrue private Auth helper did not fail closed" >&2; exit 1; }
  if [ "${FDB_ADMIN_AUTH:-}" = 1 ]; then
    docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
      psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
      < "$repo/database/migrations/0022_admin_auth_handoff.sql"
    auth_ok=$(docker exec "$pg_name" psql -X -At -U postgres -d "$db_name" \
      -c "select (select version_id from admin_private.active_policy)=0
         and (select count(*) from admin_private.staff_subjects)=0
         and (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
              where relnamespace='admin_private'::regnamespace and relname in ('handoff_tokens','session_revocations'))
         and not has_table_privilege('authenticated','admin_private.handoff_tokens','SELECT')
         and not has_function_privilege('anon','public.fdb_admin_entry_ready()','EXECUTE')")
    [ "$auth_ok" = t ] || { echo "real-GoTrue ADM-01B-3 boundary failed" >&2; exit 1; }
    if [ "${FDB_ADMIN_STAFF:-}" = 1 ]; then
      docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
        psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
        < "$repo/database/migrations/0023_admin_staff_lifecycle.sql"
      staff_ok=$(docker exec "$pg_name" psql -X -At -U postgres -d "$db_name" \
        -c "select (select version_id from admin_private.active_policy)=0
          and (select count(*) from admin_private.staff_subjects)=0
          and (select event_no from admin_private.staff_audit_head)=0
          and (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
               where relnamespace='admin_private'::regnamespace
                 and relname in ('bootstrap_control','staff_action_approvals',
                   'staff_audit_head','staff_audit_events'))
          and not has_schema_privilege('authenticated','admin_private','USAGE')
          and not has_function_privilege('anon','public.fdb_admin_role_propose(uuid,text,integer,text)','EXECUTE')
          and not has_function_privilege('authenticated','admin_private.bootstrap_initial_owner(uuid,uuid,bytea,uuid,uuid,text)','EXECUTE')
          and admin_private.eligible_staff_identity('00000000-0000-0000-0000-000000000101')=false")
      [ "$staff_ok" = t ] || { echo "real-GoTrue ADM-01B-4 boundary failed" >&2; exit 1; }
      if [ "${FDB_ADMIN_EDITORIAL:-}" = 1 ]; then
        docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
          psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
          < "$repo/database/migrations/0024_admin_editorial_boundary.sql"
        editorial_ok=$(docker exec "$pg_name" psql -X -At -U postgres -d "$db_name" \
          -c "select (select version_id from admin_private.active_policy)=0
            and (select count(*) from admin_private.staff_subjects)=0
            and not has_schema_privilege('authenticated','admin_private','USAGE')
            and not has_function_privilege('authenticated',
              'admin_private.editorial_actor(text,text)','EXECUTE')
            and not has_function_privilege('service_role',
              'admin_private.append_editorial_audit(text,text,uuid,uuid,jsonb,jsonb)','EXECUTE')")
        [ "$editorial_ok" = t ] || { echo "real-GoTrue ADM-01B-5 boundary failed" >&2; exit 1; }
        if [ "${FDB_ADMIN_CMS:-}" = 1 ]; then
          docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
            psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
            < "$repo/database/migrations/0025_editorial_private_cms.sql"
          cms_ok=$(docker exec "$pg_name" psql -X -At -U postgres -d "$db_name" \
            -c "select (select version_id from admin_private.active_policy)=0
              and (select count(*) from editorial_private.articles)=0
              and not has_schema_privilege('authenticated','editorial_private','USAGE')
              and not has_function_privilege('anon','public.fdb_cms_create_draft(uuid,text,jsonb,uuid)','EXECUTE')")
          [ "$cms_ok" = t ] || { echo 'real-GoTrue ADM-03B private CMS boundary failed' >&2; exit 1; }
          docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
            psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
            < "$repo/database/rollback/0025_editorial_private_cms_rollback.sql"
        fi
        docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
          psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
          < "$repo/database/rollback/0024_admin_editorial_boundary_rollback.sql"
      fi
      docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
        psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
        < "$repo/database/rollback/0023_admin_staff_lifecycle_rollback.sql"
    fi
    docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
      psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
      < "$repo/database/rollback/0022_admin_auth_handoff_rollback.sql"
  fi
  docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
    psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
    < "$repo/database/rollback/0021_admin_private_evaluator_rollback.sql"
fi
docker exec -i -e PGPASSWORD=local-test-password "$pg_name" \
  psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U fdb_migrator -d "$db_name" \
  < "$repo/database/rollback/0020_admin_private_authorization_rollback.sql"
rollback_ok=$(docker exec "$pg_name" psql -X -At -U postgres -d "$db_name" \
  -c "select to_regnamespace('admin_private') is null and not exists (select 1 from pg_roles where rolname='admin_executor')" \
)
[ "$rollback_ok" = t ] || { echo "GoTrue/Auth rollback left Admin objects" >&2; exit 1; }
echo "PASS: real GoTrue v2.197.0 Auth schema, non-superuser operator, PostgreSQL 17 migration and rollback"
