#!/usr/bin/env bash
set -euo pipefail
[ "${FDB_CMS_DISPOSABLE:-}" = 1 ] || exit 2
export PGHOST=127.0.0.1 PGPORT=5432 PGPASSWORD=local-test-only
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f database/tests/admin_private/bootstrap_roles.sql
createdb -U postgres fdb_admin_it
createdb -U postgres cms_public_it
root=(psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fdb_admin_it)
migrator=(psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d fdb_admin_it)
"${root[@]}" -f database/tests/admin_private/bootstrap_db.sql
"${root[@]}" -f database/tests/admin_authorization/bootstrap_auth.sql
"${root[@]}" -f database/tests/admin_auth/bootstrap_mfa.sql
"${root[@]}" -c 'alter table auth.users add column email_confirmed_at timestamptz; alter table auth.users add column phone_confirmed_at timestamptz'
for n in 0020_admin_private_authorization 0021_admin_private_evaluator \
  0022_admin_auth_handoff 0023_admin_staff_lifecycle 0024_admin_editorial_boundary \
  0025_editorial_private_cms 0026_editorial_delivery_control; do
  "${migrator[@]}" -f "database/migrations/$n.sql"
done
pub=(psql -X -q -v ON_ERROR_STOP=1 -U postgres -d cms_public_it)
for n in 0001_public_read_model 0002_news_model 0008_news_ingest_role \
  0013_cms_projection; do
  "${pub[@]}" -f "database/public-read/migrations/$n.sql"
done
"${root[@]}" -c "insert into editorial_private.delivery_mac_key(secret) values(pg_catalog.decode(pg_catalog.repeat('4a',32),'hex'))"
"${pub[@]}" -c "insert into cms_pub.delivery_mac_key(secret) values(pg_catalog.decode(pg_catalog.repeat('4a',32),'hex'))"
"${root[@]}" -f database/tests/admin_cms_delivery/private.sql
"${root[@]}" -f database/tests/admin_cms/lifecycle.sql >/tmp/cms03c-private-fixtures.log
if [ "${FDB_CMS_WORKER_TEST:-}" = 1 ]; then
  "${root[@]}" -c "update editorial_private.delivery_control set enabled=true, reviewed_config_id='00000000-0000-0000-0000-000000000901' where singleton"
else
  "${root[@]}" -f database/tests/admin_cms_delivery/private-flow.sql
fi
"${pub[@]}" -f database/tests/admin_cms_delivery/public.sql
echo 'ADM-03C disposable SQL: PASS'
