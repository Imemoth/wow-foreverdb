#!/usr/bin/env bash
set -euo pipefail
[ "${FDB_ADMIN_DISPOSABLE:-}" = 1 ] || exit 2
export PGHOST=127.0.0.1 PGPORT=5432 PGPASSWORD=local-test-only
article=00000000-0000-0000-0000-000000000406
uid=00000000-0000-0000-0000-000000000101
claims='{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}'
revision() { psql -X -At -U postgres -d fdb_admin_it -c "select current_revision_id from editorial_private.articles where article_id='$article'"; }
try_edit() {
  local rev="$1" req="$2"
  psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fdb_admin_it -c \
    "set role authenticated; set request.jwt.claims='$claims';
     select public.fdb_cms_edit_draft('$article','$rev',
     '{\"title\":\"Concurrent revision\",\"summary\":\"A synthetic concurrent edit summary today.\",\"body_markdown\":\"A body.\",\"classification\":\"normal\"}',
     '$req')" >/tmp/fdb-cms-concurrent-action.log 2>&1
}
lock_article() {
  psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fdb_admin_it -c \
    "begin; select article_id from editorial_private.articles where article_id='$article' for update; select pg_sleep(3); commit" >/tmp/fdb-cms-lock.log 2>&1
}
lock_audit_head() {
  psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fdb_admin_it -c \
    "begin; select singleton from admin_private.staff_audit_head where singleton for update;
     select pg_sleep(3); commit" >/tmp/fdb-cms-audit-lock.log 2>&1
}
# Evaluator lock precedes article lock. A revoke queued after authorization
# cannot commit first; the action commits, then the revoke takes effect.
rev=$(revision)
lock_article & locker=$!
sleep 0.3
try_edit "$rev" 00000000-0000-0000-0000-000000000530 & action=$!
sleep 0.5
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fdb_admin_it -c \
  "update admin_private.role_assignments set status='revoked',revoked_at=clock_timestamp()
   where user_id='$uid' and role_name='Editor' and status='active'" >/tmp/fdb-cms-revoke.log 2>&1 & revoker=$!
wait "$locker"
wait "$action"
wait "$revoker"
count=$(psql -X -At -U postgres -d fdb_admin_it -c "select count(*) from editorial_private.revisions where article_id='$article'")
[ "$count" = 2 ] || { echo 'serialized edit did not commit before revoke' >&2; exit 1; }
rev=$(revision)
if try_edit "$rev" 00000000-0000-0000-0000-000000000531; then
  echo 'committed revoke permitted a later edit' >&2; exit 1
fi
grep -q 'editorial action denied' /tmp/fdb-cms-concurrent-action.log
# Re-enable the fixture role with one second left. The second action starts
# authorized, waits on the article, then fails the database-clock recheck.
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fdb_admin_it -c \
  "update admin_private.role_assignments set status='active',revoked_at=null,
   expires_at=clock_timestamp()+interval '1 second'
   where user_id='$uid' and role_name='Editor' and status='revoked'" >/dev/null
lock_article & locker=$!
sleep 0.3
try_edit "$rev" 00000000-0000-0000-0000-000000000532 & action=$!
wait "$locker"
if wait "$action"; then echo 'expired role permitted edit' >&2; exit 1; fi
grep -q 'editorial action denied' /tmp/fdb-cms-concurrent-action.log
count=$(psql -X -At -U postgres -d fdb_admin_it -c "select count(*) from editorial_private.revisions where article_id='$article'")
[ "$count" = 2 ] || { echo 'failed action left an immutable revision' >&2; exit 1; }
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d fdb_admin_it -c \
  "update admin_private.role_assignments set expires_at=clock_timestamp()+interval '1 second'
   where user_id='$uid' and role_name='Editor' and status='active'" >/dev/null
lock_audit_head & locker=$!
sleep 0.3
try_edit "$rev" 00000000-0000-0000-0000-000000000540 & action=$!
seen_wait=0
for _ in $(seq 1 20); do
  waiting=$(psql -X -At -U postgres -d fdb_admin_it -c \
    "select count(*) from pg_stat_activity where wait_event_type='Lock'
      and query like '%fdb_cms_edit_draft%'")
  if [ "$waiting" -gt 0 ]; then seen_wait=1; break; fi
  sleep 0.1
done
[ "$seen_wait" = 1 ] || { echo 'audit-head wait not observed' >&2; exit 1; }
wait "$locker"
if wait "$action"; then echo 'audit-head wait bypassed fresh authorization' >&2; exit 1; fi
if ! grep -q 'editorial action denied' /tmp/fdb-cms-concurrent-action.log \
   || ! grep -q 'lock_audit_and_recheck' /tmp/fdb-cms-concurrent-action.log; then
  cat /tmp/fdb-cms-concurrent-action.log >&2
  exit 1
fi
count=$(psql -X -At -U postgres -d fdb_admin_it -c "select count(*) from editorial_private.revisions where article_id='$article'")
[ "$count" = 2 ] || { echo 'audit-head wait left a revision' >&2; exit 1; }
echo 'ADM-03B concurrent revoke and expiry: PASS'
