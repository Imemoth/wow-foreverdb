#!/usr/bin/env bash
set -euo pipefail
[ "${FDB_ADMIN_DISPOSABLE:-}" = 1 ] || { echo 'disposable marker missing' >&2; exit 2; }
export PGHOST=127.0.0.1 PGPORT=5432 PGPASSWORD=local-test-only
db=fdb_admin_it
root=(psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db")
migrator=(psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d "$db")
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f database/tests/admin_private/bootstrap_roles.sql
createdb -U postgres "$db"
"${root[@]}" -f database/tests/admin_private/bootstrap_db.sql
"${root[@]}" -f database/tests/admin_authorization/bootstrap_auth.sql
"${root[@]}" -f database/tests/admin_auth/bootstrap_mfa.sql
for n in 0020_admin_private_authorization 0021_admin_private_evaluator 0022_admin_auth_handoff; do
  "${migrator[@]}" -f "database/migrations/$n.sql"
done
"${root[@]}" -f database/tests/admin_auth/assertions.sql

# The same token cannot win two concurrent updates. Fixture policy is active
# only in this disposable container; one winner and one denied reply are required.
"${root[@]}" -c "delete from admin_private.session_revocations; update auth.mfa_amr_claims set updated_at=clock_timestamp()" >/dev/null
claims='{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}'
token='1234567890abcdefghijklmnopqrstuvwxyzABCDEFG'
"${root[@]}" -At -c "set role authenticated; set request.jwt.claims='$claims'; select public.fdb_admin_handoff_start('$token')" | tail -1 | grep -qx t
race_one=$(mktemp); race_two=$(mktemp)
trap 'rm -f "$race_one" "$race_two"' EXIT
"${root[@]}" -At -c "set role authenticated; set request.jwt.claims='$claims'; select public.fdb_admin_handoff_redeem('$token')" | tail -1 > "$race_one" &
p1=$!
"${root[@]}" -At -c "set role authenticated; set request.jwt.claims='$claims'; select public.fdb_admin_handoff_redeem('$token')" | tail -1 > "$race_two" &
p2=$!
wait "$p1"; wait "$p2"
[ "$(cat "$race_one")$(cat "$race_two")" = tf ] || [ "$(cat "$race_one")$(cat "$race_two")" = ft ] || {
  echo 'concurrent handoff was not single-use' >&2; exit 1;
}

# Force the MFA row lock to wait across both the 15-minute AMR boundary and
# (separately) the staff review deadline. Both decisions must fail closed.
lock_and_decide() {
  local marker result pid start elapsed
  marker=$(mktemp); result=$(mktemp)
  "${root[@]}" -At > "$marker" 2>&1 <<'SQL' &
begin;
update auth.mfa_factors set status=status where id='00000000-0000-0000-0000-000000000301';
select 'locked';
select pg_sleep(8);
commit;
SQL
  pid=$!
  for _ in $(seq 1 50); do grep -qx locked "$marker" && break; sleep 0.1; done
  grep -qx locked "$marker" || { cat "$marker" >&2; echo 'MFA lock holder not ready' >&2; exit 1; }
  start=$(date +%s)
  "${root[@]}" -At -c "set role authenticated; set request.jwt.claims='$claims'; select public.fdb_admin_entry_ready()" | tail -1 > "$result"
  elapsed=$(( $(date +%s) - start ))
  wait "$pid"
  [ "$(cat "$result")" = f ] && [ "$elapsed" -ge 6 ] || {
    echo "stale authorization after MFA lock wait (result $(cat "$result"), wait ${elapsed}s)" >&2; exit 1;
  }
  rm -f "$marker" "$result"
}
"${root[@]}" -c "update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '14 minutes 54 seconds'
  where session_id='00000000-0000-0000-0000-000000000202'" >/dev/null
lock_and_decide
"${root[@]}" -c "update auth.mfa_amr_claims set updated_at=clock_timestamp()
  where session_id='00000000-0000-0000-0000-000000000202';
  update admin_private.role_assignments set review_due_at=clock_timestamp()+interval '6 seconds'
  where user_id='00000000-0000-0000-0000-000000000101'" >/dev/null
lock_and_decide

if "${migrator[@]}" -f database/rollback/0022_admin_auth_handoff_rollback.sql > /tmp/admin_auth_rollback_refusal.log 2>&1; then
  echo 'rollback discarded active Admin state' >&2; exit 1
fi
grep -q 'preserve and escalate' /tmp/admin_auth_rollback_refusal.log
"${root[@]}" -c "delete from admin_private.handoff_tokens; delete from admin_private.session_revocations;
 delete from admin_private.role_assignments; delete from admin_private.staff_subjects;
 alter table admin_private.active_policy disable trigger active_policy_immutable;
 update admin_private.active_policy set version_id=0,epoch=0 where singleton;
 alter table admin_private.active_policy enable trigger active_policy_immutable" >/dev/null
"${migrator[@]}" -f database/rollback/0022_admin_auth_handoff_rollback.sql
echo 'ADM-01B-3 disposable Admin auth boundary: PASS'
