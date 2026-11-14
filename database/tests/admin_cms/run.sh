#!/usr/bin/env bash
set -euo pipefail
[ "${FDB_ADMIN_DISPOSABLE:-}" = 1 ] || exit 2
export PGHOST=127.0.0.1 PGPORT=5432 PGPASSWORD=local-test-only
db=fdb_admin_it
root=(psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db")
migrator=(psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d "$db")
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f database/tests/admin_private/bootstrap_roles.sql
createdb -U postgres "$db"
"${root[@]}" -f database/tests/admin_private/bootstrap_db.sql
"${root[@]}" -f database/tests/admin_authorization/bootstrap_auth.sql
"${root[@]}" -f database/tests/admin_auth/bootstrap_mfa.sql
"${root[@]}" -c "alter table auth.users add column email_confirmed_at timestamptz;
  alter table auth.users add column phone_confirmed_at timestamptz"
for n in 0020_admin_private_authorization 0021_admin_private_evaluator \
  0022_admin_auth_handoff 0023_admin_staff_lifecycle 0024_admin_editorial_boundary \
  0025_editorial_private_cms; do
  "${migrator[@]}" -f "database/migrations/$n.sql"
done
"${root[@]}" -f database/tests/admin_cms/assertions.sql
createdb -U postgres -T "$db" fdb_admin_rollback
createdb -U postgres -T "$db" fdb_admin_asset_rollback
psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d fdb_admin_rollback \
  -f database/rollback/0025_editorial_private_cms_rollback.sql
psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d fdb_admin_rollback \
  -c "select to_regnamespace('editorial_private') is null and to_regprocedure('admin_private.editorial_actor(text,text)') is not null" \
  | grep -qx t
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fdb_admin_asset_rollback \
  -c "insert into editorial_private.media_assets(asset_version,path,content_sha256,rights_source,rights_license,attribution,verified_by,verified_at)
      values(1,'/content-images/asset-only.png',pg_catalog.sha256(pg_catalog.convert_to('synthetic bytes','UTF8')),
        'synthetic source','test-only license','Synthetic author',
        '00000000-0000-0000-0000-000000000101',clock_timestamp())"
if psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d fdb_admin_asset_rollback \
   -f database/rollback/0025_editorial_private_cms_rollback.sql >/dev/null 2>&1; then
  echo 'rollback discarded verified media evidence' >&2; exit 1
fi
"${root[@]}" -f database/tests/admin_cms/lifecycle.sql
if "${migrator[@]}" -f database/rollback/0025_editorial_private_cms_rollback.sql \
   >/dev/null 2>&1; then echo 'rollback accepted live CMS data' >&2; exit 1; fi
bash database/tests/admin_cms/concurrency.sh
echo 'ADM-03B private CMS: PASS'
