#!/usr/bin/env bash
# Runs only in run-docker.sh's network-isolated disposable database.
set -euo pipefail
[ "${FDB_ADMIN_DISPOSABLE:-}" = 1 ] || { echo "disposable marker missing" >&2; exit 2; }
export PGHOST=127.0.0.1 PGPORT=5432 PGPASSWORD=local-test-only
db=fdb_admin_it
root=(psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db")
migrator=(psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d "$db")
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f database/tests/admin_private/bootstrap_roles.sql
createdb -U postgres "$db"
"${root[@]}" -f database/tests/admin_private/bootstrap_db.sql
"${root[@]}" -f database/tests/admin_authorization/bootstrap_auth.sql
"${migrator[@]}" -f database/migrations/0020_admin_private_authorization.sql
"${migrator[@]}" -f database/migrations/0021_admin_private_evaluator.sql
"${root[@]}" -f database/tests/admin_authorization/assertions.sql

claims='{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}'
decision="select admin_private.authorize_action('news.article.publish','staging','article','story-1')"
run_decision() {
    "${root[@]}" -At -c "set role admin_executor; set request.jwt.claims = '$claims'; $decision" | tail -1
}
[ "$(run_decision)" = t ] || { echo "active scoped Editor publishing grant denied" >&2; exit 1; }

# An authorization read holds FOR SHARE until its transaction finishes. A
# concurrent controlled revocation must wait for that decision/write boundary.
"${root[@]}" -At > /tmp/admin_evaluator_action.log 2>&1 <<SQL &
begin;
set local role admin_executor;
set local request.jwt.claims = '$claims';
$decision;
select pg_sleep(6);
commit;
SQL
action_pid=$!
ready=0
for _ in $(seq 1 40); do
    if grep -qx t /tmp/admin_evaluator_action.log 2>/dev/null; then ready=1; break; fi
    sleep 0.1
done
[ "$ready" = 1 ] || { cat /tmp/admin_evaluator_action.log >&2; echo "action did not reach lock" >&2; exit 1; }
kill -0 "$action_pid" || { echo "action committed before race began" >&2; exit 1; }
if "${root[@]}" -v VERBOSITY=verbose -c "set lock_timeout = '250ms';
    update admin_private.direct_grants set status='revoked', revoked_at=clock_timestamp()
    where permission_key='news.article.publish'" > /tmp/admin_evaluator_lock.log 2>&1; then
    echo "revocation bypassed authorization lock" >&2; exit 1
fi
grep -q 55P03 /tmp/admin_evaluator_lock.log || { cat /tmp/admin_evaluator_lock.log >&2; exit 1; }
wait "$action_pid"
"${root[@]}" -c "update admin_private.direct_grants set status='revoked', revoked_at=clock_timestamp()
    where permission_key='news.article.publish'"
[ "$(run_decision)" = f ] || { echo "committed revocation did not deny next action" >&2; exit 1; }

# The rollback must preserve any real staff/policy state. After explicit
# disposable-only cleanup it must remove the evaluator and lock grants.
if "${migrator[@]}" -f database/rollback/0021_admin_private_evaluator_rollback.sql \
    > /tmp/admin_evaluator_rollback_refusal.log 2>&1; then
    echo "rollback discarded staff/policy state" >&2; exit 1
fi
grep -q 'preserve and escalate' /tmp/admin_evaluator_rollback_refusal.log || {
    cat /tmp/admin_evaluator_rollback_refusal.log >&2; exit 1;
}
"${root[@]}" -c "delete from admin_private.direct_grants;
    delete from admin_private.role_assignments;
    delete from admin_private.staff_subjects;
    delete from auth.refresh_tokens;
    delete from auth.sessions;
    delete from auth.users;
    alter table admin_private.active_policy disable trigger active_policy_immutable;
    update admin_private.active_policy set version_id=0, epoch=0 where singleton;
    alter table admin_private.active_policy enable trigger active_policy_immutable"
"${migrator[@]}" -f database/rollback/0021_admin_private_evaluator_rollback.sql
gone=$("${root[@]}" -At -c "select to_regprocedure('admin_private.authorize_action(text,text,text,text)') is null
    and to_regprocedure('admin_private.live_auth_session(uuid,uuid)') is null
    and not has_column_privilege('admin_executor','admin_private.direct_grants','grant_id','UPDATE')")
[ "$gone" = t ] || { echo "0021 rollback left evaluator privileges" >&2; exit 1; }
echo "ADM-01B-2 disposable evaluator, denial and revocation race tests: PASS"
