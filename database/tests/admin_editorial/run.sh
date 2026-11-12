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
  0022_admin_auth_handoff 0023_admin_staff_lifecycle 0024_admin_editorial_boundary; do
  "${migrator[@]}" -f "database/migrations/$n.sql"
done
"${root[@]}" -f database/tests/admin_editorial/assertions.sql

# The failure occurs after the synthetic write and must roll back both the
# write and any audit-head change. No test fixture is a CMS article.
if "${root[@]}" > /tmp/admin_editorial_audit_failure.log 2>&1 <<'SQL'
begin;
delete from admin_private.staff_audit_head;
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
insert into public.editorial_probe(id) select 3
 where admin_private.editorial_actor('news.draft.write','article-1') is not null;
select admin_private.append_editorial_audit('news.draft.write','article-1',
 '00000000-0000-0000-0000-000000000101',gen_random_uuid(),
 '{"rev":2}'::jsonb,'{"rev":3}'::jsonb);
commit;
SQL
then echo 'audit failure allowed protected write' >&2; exit 1; fi
grep -q 'staff audit head missing' /tmp/admin_editorial_audit_failure.log
"${root[@]}" -At -c "select count(*) from public.editorial_probe where id=3" | grep -qx 0

"${root[@]}" -c "update auth.mfa_amr_claims
 set updated_at=clock_timestamp()-interval '14 minutes 54 seconds'
 where session_id='00000000-0000-0000-0000-000000000201'" >/dev/null
mfa_marker=$(mktemp)
"${root[@]}" -At > "$mfa_marker" 2>&1 <<'SQL' &
begin;
update auth.mfa_factors set status=status
 where id='00000000-0000-0000-0000-000000000301';
select 'locked';
select pg_sleep(8);
commit;
SQL
locker=$!
for _ in $(seq 1 50); do grep -qx locked "$mfa_marker" && break; sleep 0.1; done
grep -qx locked "$mfa_marker" || { cat "$mfa_marker" >&2; exit 1; }
"${root[@]}" -At -c "set role admin_executor;
 set request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"00000000-0000-0000-0000-000000000101\",\"session_id\":\"00000000-0000-0000-0000-000000000201\",\"aal\":\"aal2\",\"exp\":4102444800}';
 select admin_private.editorial_actor('news.draft.write','article-1') is null" | tail -1 | grep -qx t
wait "$locker"; rm -f "$mfa_marker"
"${root[@]}" -c "update auth.mfa_amr_claims set updated_at=clock_timestamp()
 where session_id='00000000-0000-0000-0000-000000000201'" >/dev/null

# An assignment expiry during a lock wait must fail closed.
"${root[@]}" -c "update admin_private.role_assignments
 set expires_at=clock_timestamp()+interval '6 seconds'
 where user_id='00000000-0000-0000-0000-000000000101'" >/dev/null
expiry_marker=$(mktemp)
"${root[@]}" -At > "$expiry_marker" 2>&1 <<'SQL' &
begin;
update admin_private.role_assignments set role_name=role_name
 where user_id='00000000-0000-0000-0000-000000000101';
select 'locked';
select pg_sleep(8);
commit;
SQL
locker=$!
for _ in $(seq 1 50); do grep -qx locked "$expiry_marker" && break; sleep 0.1; done
grep -qx locked "$expiry_marker" || { cat "$expiry_marker" >&2; exit 1; }
"${root[@]}" -At -c "set role admin_executor;
 set request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"00000000-0000-0000-0000-000000000101\",\"session_id\":\"00000000-0000-0000-0000-000000000201\",\"aal\":\"aal2\",\"exp\":4102444800}';
 select admin_private.editorial_actor('news.draft.write','article-1') is null" | tail -1 | grep -qx t
wait "$locker"; rm -f "$expiry_marker"
"${root[@]}" -c "update admin_private.role_assignments
 set expires_at=clock_timestamp()+interval '29 days'
 where user_id='00000000-0000-0000-0000-000000000101'" >/dev/null

# A pending revoke must serialize after a protected write. Subsequent actions
# must be denied; a forced audit failure must roll back the write.
marker=$(mktemp)
"${root[@]}" -At > "$marker" 2>&1 <<'SQL' &
begin;
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
insert into public.editorial_probe(id) select 2
 where admin_private.editorial_actor('news.draft.write','article-1') is not null;
select 'locked';
select pg_sleep(4);
select admin_private.append_editorial_audit('news.draft.write','article-1',
 '00000000-0000-0000-0000-000000000101',gen_random_uuid(),
 '{"rev":1}'::jsonb,'{"rev":2}'::jsonb);
commit;
SQL
writer=$!
for _ in $(seq 1 50); do grep -qx locked "$marker" && break; sleep 0.1; done
grep -qx locked "$marker" || { cat "$marker" >&2; exit 1; }
start=$(date +%s)
"${root[@]}" -c "update admin_private.staff_subjects set status='suspended'
 where user_id='00000000-0000-0000-0000-000000000101'" >/dev/null
elapsed=$(( $(date +%s)-start ))
wait "$writer"
rm -f "$marker"
[ "$elapsed" -ge 2 ] || { echo 'revocation did not serialize' >&2; exit 1; }
"${root[@]}" -At -c "select count(*) from public.editorial_probe where id=2" | grep -qx 1
"${root[@]}" -At -c "set role admin_executor;
 set request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"00000000-0000-0000-0000-000000000101\",\"session_id\":\"00000000-0000-0000-0000-000000000201\",\"aal\":\"aal2\",\"exp\":4102444800}';
 select admin_private.editorial_actor('news.draft.write','article-1') is null" | tail -1 | grep -qx t

# A paired Admin logout cannot commit a session revocation in the middle of
# a protected transaction. The next authorization after logout must deny.
"${root[@]}" -c "update admin_private.staff_subjects set status='active'
 where user_id='00000000-0000-0000-0000-000000000101'" >/dev/null
logout_marker=$(mktemp)
"${root[@]}" -At > "$logout_marker" 2>&1 <<'SQL' &
begin;
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
insert into public.editorial_probe(id) select 4
 where admin_private.editorial_actor('news.draft.write','article-1') is not null;
select 'locked';
select pg_sleep(4);
select admin_private.append_editorial_audit('news.draft.write','article-1',
 '00000000-0000-0000-0000-000000000101',gen_random_uuid(),
 '{"rev":3}'::jsonb,'{"rev":4}'::jsonb);
commit;
SQL
writer=$!
for _ in $(seq 1 50); do grep -qx locked "$logout_marker" && break; sleep 0.1; done
grep -qx locked "$logout_marker" || { cat "$logout_marker" >&2; exit 1; }
start=$(date +%s)
"${root[@]}" -At -c "set role authenticated;
 set request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"00000000-0000-0000-0000-000000000101\",\"session_id\":\"00000000-0000-0000-0000-000000000201\",\"aal\":\"aal2\",\"exp\":4102444800}';
 select public.fdb_admin_session_revoke()" | tail -1 | grep -qx t
elapsed=$(( $(date +%s)-start ))
wait "$writer"; rm -f "$logout_marker"
[ "$elapsed" -ge 2 ] || { echo 'logout bypassed protected transaction lock' >&2; exit 1; }
"${root[@]}" -At -c "select count(*) from public.editorial_probe where id=4" | grep -qx 1
"${root[@]}" -At -c "set role admin_executor;
 set request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"00000000-0000-0000-0000-000000000101\",\"session_id\":\"00000000-0000-0000-0000-000000000201\",\"aal\":\"aal2\",\"exp\":4102444800}';
 select admin_private.editorial_actor('news.draft.write','article-1') is null" | tail -1 | grep -qx t

if "${migrator[@]}" -f database/rollback/0024_admin_editorial_boundary_rollback.sql > /tmp/admin_editorial_rollback.log 2>&1; then
  echo 'rollback erased editorial audit contract' >&2; exit 1
fi
grep -q 'preserve and escalate' /tmp/admin_editorial_rollback.log
echo 'ADM-01B-5 inactive editorial boundary: PASS'
