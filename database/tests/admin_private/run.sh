#!/usr/bin/env bash
# Run only inside the disposable PostgreSQL container created by run-docker.sh.
set -euo pipefail
[ "${FDB_ADMIN_DISPOSABLE:-}" = 1 ] || { echo "disposable container marker missing" >&2; exit 2; }
export PGHOST=127.0.0.1 PGPORT=5432 PGPASSWORD=local-test-only
db=fdb_admin_it
root=(psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$db")
migrator=(psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d "$db")
api=(psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -U authenticator -d "$db")

psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -f database/tests/admin_private/bootstrap_roles.sql
createdb -U postgres "$db"
"${root[@]}" -f database/tests/admin_private/bootstrap_db.sql
"${migrator[@]}" -f database/migrations/0020_admin_private_authorization.sql
"${root[@]}" -f database/tests/admin_private/assertions.sql

expect_denied() {
    local label="$1" sql="$2" result
    if result=$("${api[@]}" -c "$sql" 2>&1); then
        echo "FAIL: $label unexpectedly succeeded" >&2
        exit 1
    fi
    if [[ "$result" != *42501* ]]; then
        echo "FAIL: $label did not fail with insufficient_privilege: $result" >&2
        exit 1
    fi
}
for role in anon authenticated service_role; do
    expect_denied "$role direct table read"         "set role $role; select * from admin_private.permission_catalog limit 1"
    expect_denied "$role direct table write"         "set role $role; insert into admin_private.role_catalog values ('Owner')"
done
expect_denied "API role assuming executor"     "set role authenticated; set role admin_executor"

# The dedicated executor alone can read through its SELECT policies.
executor_count=$("${root[@]}" -At -c     "set role admin_executor; select count(*) from admin_private.permission_catalog" | tail -1)
[ "$executor_count" = 22 ] || { echo "executor RLS read failed" >&2; exit 1; }

# A rollback must refuse to discard staff data.
"${root[@]}" -c     "insert into auth.users values ('00000000-0000-0000-0000-000000000002');
     insert into admin_private.staff_subjects (user_id,status)
     values ('00000000-0000-0000-0000-000000000002','active')"
if "${migrator[@]}" -f database/rollback/0020_admin_private_authorization_rollback.sql     > /tmp/admin_rollback_refusal.log 2>&1; then
    echo "FAIL: rollback discarded staff data" >&2
    exit 1
fi
grep -q 'preserve and escalate' /tmp/admin_rollback_refusal.log || {
    cat /tmp/admin_rollback_refusal.log >&2
    exit 1
}
"${root[@]}" -c     "delete from admin_private.staff_subjects
     where user_id = '00000000-0000-0000-0000-000000000002';
     delete from auth.users where id = '00000000-0000-0000-0000-000000000002'"

# A policy epoch change must also block rollback, even if deny-all remains active.
"${root[@]}" -c "alter table admin_private.active_policy disable trigger active_policy_immutable;
    update admin_private.active_policy set epoch = 1 where singleton;
    alter table admin_private.active_policy enable trigger active_policy_immutable"
if "${migrator[@]}" -f database/rollback/0020_admin_private_authorization_rollback.sql \
    > /tmp/admin_rollback_epoch_refusal.log 2>&1; then
    echo "FAIL: rollback discarded changed policy epoch" >&2
    exit 1
fi
grep -q 'preserve and escalate' /tmp/admin_rollback_epoch_refusal.log || {
    cat /tmp/admin_rollback_epoch_refusal.log >&2
    exit 1
}
"${root[@]}" -c "alter table admin_private.active_policy disable trigger active_policy_immutable;
    update admin_private.active_policy set epoch = 0 where singleton;
    alter table admin_private.active_policy enable trigger active_policy_immutable"

# Preserve a policy whose activation timestamp changed outside this slice.
"${root[@]}" -c "alter table admin_private.active_policy disable trigger active_policy_immutable;
    update admin_private.active_policy set activated_at = clock_timestamp() + interval '1 second' where singleton;
    alter table admin_private.active_policy enable trigger active_policy_immutable"
if "${migrator[@]}" -f database/rollback/0020_admin_private_authorization_rollback.sql \
    > /tmp/admin_rollback_timestamp_refusal.log 2>&1; then
    echo "FAIL: rollback discarded changed policy timestamp" >&2
    exit 1
fi
grep -q 'preserve and escalate' /tmp/admin_rollback_timestamp_refusal.log || {
    cat /tmp/admin_rollback_timestamp_refusal.log >&2
    exit 1
}
"${root[@]}" -c "alter table admin_private.active_policy disable trigger active_policy_immutable;
    update admin_private.active_policy set activated_at =
        (select created_at from admin_private.policy_versions where version_id = 0) where singleton;
    alter table admin_private.active_policy enable trigger active_policy_immutable"

# Even a privileged, out-of-band switch to the proposed version must not be discarded.
"${root[@]}" -c "alter table admin_private.active_policy disable trigger active_policy_immutable;
    update admin_private.active_policy set version_id = 1 where singleton;
    alter table admin_private.active_policy enable trigger active_policy_immutable"
if "${migrator[@]}" -f database/rollback/0020_admin_private_authorization_rollback.sql \
    > /tmp/admin_rollback_version_refusal.log 2>&1; then
    echo "FAIL: rollback discarded proposed policy activation" >&2
    exit 1
fi
grep -q 'preserve and escalate' /tmp/admin_rollback_version_refusal.log || {
    cat /tmp/admin_rollback_version_refusal.log >&2
    exit 1
}
"${root[@]}" -c "alter table admin_private.active_policy disable trigger active_policy_immutable;
    update admin_private.active_policy set version_id = 0 where singleton;
    alter table admin_private.active_policy enable trigger active_policy_immutable"
"${migrator[@]}" -f database/rollback/0020_admin_private_authorization_rollback.sql
gone=$("${root[@]}" -At -c     "select to_regnamespace('admin_private') is null
     and not exists (select 1 from pg_roles where rolname = 'admin_executor')")
[ "$gone" = t ] || { echo "rollback left Admin objects" >&2; exit 1; }

# Reapplication on the disposable database proves rollback did not leave a partial state.
"${migrator[@]}" -f database/migrations/0020_admin_private_authorization.sql
"${root[@]}" -f database/tests/admin_private/assertions.sql
echo "ADM-01B-1 disposable PostgreSQL security, isolation and rollback tests: PASS"
