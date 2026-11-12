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
"${root[@]}" -c "alter table auth.users add column email_confirmed_at timestamptz;
  alter table auth.users add column phone_confirmed_at timestamptz"
for n in 0020_admin_private_authorization 0021_admin_private_evaluator 0022_admin_auth_handoff 0023_admin_staff_lifecycle; do
  "${migrator[@]}" -f "database/migrations/$n.sql"
done
"${root[@]}" -f database/tests/admin_staff/assertions.sql
"${root[@]}" -f database/tests/admin_staff/negative.sql
if "${migrator[@]}" -f database/rollback/0023_admin_staff_lifecycle_rollback.sql > /tmp/admin_staff_rollback_refusal.log 2>&1; then
  echo 'rollback discarded protected staff or audit state' >&2; exit 1
fi
grep -q 'preserve and escalate' /tmp/admin_staff_rollback_refusal.log

# An MFA lock wait crossing the 15-minute boundary must deny the final write.
"${root[@]}" -c "update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '14 minutes 54 seconds'
  where session_id='00000000-0000-0000-0000-000000000202'" >/dev/null
lock_marker=$(mktemp)
"${root[@]}" -At > "$lock_marker" 2>&1 <<'SQL' &
begin;
update auth.mfa_factors set status=status
 where id='00000000-0000-0000-0000-000000000302';
select 'locked';
select pg_sleep(8);
commit;
SQL
locker=$!
for _ in $(seq 1 50); do grep -qx locked "$lock_marker" && break; sleep 0.1; done
grep -qx locked "$lock_marker" || { cat "$lock_marker" >&2; exit 1; }
mfa_result=$("${root[@]}" -At -c "set role authenticated;
  set request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"00000000-0000-0000-0000-000000000102\",\"session_id\":\"00000000-0000-0000-0000-000000000202\",\"aal\":\"aal2\",\"exp\":4102444800}';
  select public.fdb_admin_staff_prepare('00000000-0000-0000-0000-000000000105','staff_onboarding')" | tail -1)
wait "$locker"; rm -f "$lock_marker"
[ "$mfa_result" = f ] || { echo 'MFA expired during staff lock wait' >&2; exit 1; }
"${root[@]}" -c "update auth.mfa_amr_claims set updated_at=clock_timestamp()
  where session_id='00000000-0000-0000-0000-000000000202'" >/dev/null

# A delegated Administrator's approval grant expiring while its row is locked
# must not authorize a late decision.
"${root[@]}" -c "insert into admin_private.role_assignments(user_id,role_name,
  policy_version_id,environment_scope,scope_kind,starts_at,expires_at,
  review_due_at,status,approved_by,reason)
  values('00000000-0000-0000-0000-000000000103','Administrator',1,
  'staging','global',clock_timestamp()-interval '1 minute',
  clock_timestamp()+interval '89 days',clock_timestamp()+interval '90 days',
  'active','00000000-0000-0000-0000-000000000102','synthetic lock test');
  insert into admin_private.direct_grants(user_id,permission_key,
  policy_version_id,environment_scope,scope_kind,starts_at,expires_at,
  status,approved_by,reason)
  values('00000000-0000-0000-0000-000000000103','staff.role.approve',1,
  'staging','global',clock_timestamp()-interval '1 minute',
  clock_timestamp()+interval '6 seconds','active',
  '00000000-0000-0000-0000-000000000102','synthetic lock test')" >/dev/null
grant_marker=$(mktemp)
"${root[@]}" -At > "$grant_marker" 2>&1 <<'SQL' &
begin;
update admin_private.direct_grants set permission_key=permission_key
 where user_id='00000000-0000-0000-0000-000000000103'
   and permission_key='staff.role.approve' and status='active';
select 'locked';
select pg_sleep(8);
commit;
SQL
locker=$!
for _ in $(seq 1 50); do grep -qx locked "$grant_marker" && break; sleep 0.1; done
grep -qx locked "$grant_marker" || { cat "$grant_marker" >&2; exit 1; }
grant_result=$("${root[@]}" -At -c "set role admin_executor;
  set request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"00000000-0000-0000-0000-000000000103\",\"session_id\":\"00000000-0000-0000-0000-000000000203\",\"aal\":\"aal2\",\"exp\":4102444800}';
  select admin_private.staff_actor('staff.role.approve') is null" | tail -1)
wait "$locker"; rm -f "$grant_marker"
[ "$grant_result" = t ] || { echo 'delegated grant expired during lock wait' >&2; exit 1; }

# A missing audit head must abort the entire prepared-subject write.
if "${root[@]}" > /tmp/admin_staff_audit_failure.log 2>&1 <<'SQL'
begin;
delete from admin_private.staff_audit_head;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_admin_staff_prepare('00000000-0000-0000-0000-000000000105','staff_onboarding');
commit;
SQL
then echo 'audit failure allowed a staff write' >&2; exit 1; fi
grep -q 'staff audit head missing' /tmp/admin_staff_audit_failure.log
[ "$("${root[@]}" -At -c "select count(*) from admin_private.staff_subjects where user_id='00000000-0000-0000-0000-000000000105'")" = 0 ] ||
  { echo 'audit failure left partial staff state' >&2; exit 1; }

# A database-owner rewrite is detected locally by the payload/hash check.
# External immutable daily head anchoring remains an activation gate.
tampered=$("${root[@]}" -At -c "begin;
  update admin_private.staff_audit_events set reason='recovery' where event_no=1;
  select sha256(previous_hash || convert_to(jsonb_build_object(
    'n',event_no,'at',occurred_at,'actor',actor_id,'sid',session_id,
    'target',target_id,'action',action_key,'resource',resource_key,
    'policy',policy_version_id,'decision',decision,'outcome',outcome,
    'request',request_id,'before',before_state,'after',after_state,
    'reason',reason)::text,'UTF8'))<>event_hash
    from admin_private.staff_audit_events where event_no=1;
  rollback;")
[[ "$tampered" == *t* ]] || { echo 'audit tamper was not detected' >&2; exit 1; }

# A protected synthetic write commits before a competing revocation; every
# subsequent decision sees the committed suspension. The same row-lock order
# applies to later real protected writes.
"${root[@]}" -c "create table public.staff_race_writes(id integer primary key);
  grant insert on public.staff_race_writes to admin_executor" >/dev/null
marker=$(mktemp)
"${root[@]}" -At > "$marker" 2>&1 <<'SQL' &
begin;
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
insert into public.staff_race_writes(id)
  select 1 where admin_private.authorize_action('staff.role.propose','staging','global',null);
select 'locked';
select pg_sleep(5);
commit;
SQL
writer=$!
for _ in $(seq 1 50); do grep -qx locked "$marker" && break; sleep 0.1; done
grep -qx locked "$marker" || { cat "$marker" >&2; exit 1; }
start=$(date +%s)
"${root[@]}" -c "update admin_private.staff_subjects set status='suspended'
  where user_id='00000000-0000-0000-0000-000000000101'" >/dev/null
elapsed=$(( $(date +%s) - start ))
wait "$writer"
rm -f "$marker"
[ "$elapsed" -ge 3 ] && [ "$("${root[@]}" -At -c "select count(*) from public.staff_race_writes")" = 1 ] ||
  { echo 'protected write/revoke commit order failed' >&2; exit 1; }
after_revoke=$("${root[@]}" -At -c "set role admin_executor;
  set request.jwt.claims = '{\"role\":\"authenticated\",\"sub\":\"00000000-0000-0000-0000-000000000101\",\"session_id\":\"00000000-0000-0000-0000-000000000201\",\"aal\":\"aal2\",\"exp\":4102444800}';
  select admin_private.authorize_action('staff.role.propose','staging','global',null)" | tail -1)
[ "$after_revoke" = f ] || { echo 'revoked staff retained next-decision authority' >&2; exit 1; }

# Rehearse a clean 0023 rollback and two concurrent first-Owner attempts in a
# second disposable database with a distinct synthetic identity.
race_db=fdb_admin_race
dropdb -U postgres "$db"
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "drop role admin_executor"
createdb -U postgres "$db"
createdb -U postgres "$race_db"
psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres -c "grant create on database $race_db to fdb_migrator"
race_root=(psql -X -q -v ON_ERROR_STOP=1 -U postgres -d "$race_db")
race_migrator=(psql -X -q -v ON_ERROR_STOP=1 -U fdb_migrator -d "$race_db")
"${race_root[@]}" -f database/tests/admin_private/bootstrap_db.sql
"${race_root[@]}" -f database/tests/admin_authorization/bootstrap_auth.sql
"${race_root[@]}" -f database/tests/admin_auth/bootstrap_mfa.sql
"${race_root[@]}" -c "alter table auth.users add column email_confirmed_at timestamptz;
  alter table auth.users add column phone_confirmed_at timestamptz"
for n in 0020_admin_private_authorization 0021_admin_private_evaluator 0022_admin_auth_handoff 0023_admin_staff_lifecycle; do
  "${race_migrator[@]}" -f "database/migrations/$n.sql"
done
"${race_migrator[@]}" -f database/rollback/0023_admin_staff_lifecycle_rollback.sql
"${race_migrator[@]}" -f database/migrations/0023_admin_staff_lifecycle.sql
"${race_root[@]}" -c "insert into auth.users(id,email_confirmed_at)
  values('00000000-0000-0000-0000-000000000104',clock_timestamp());
  insert into auth.mfa_factors(id,user_id,factor_type,status) values
  ('00000000-0000-0000-0000-000000000304',
   '00000000-0000-0000-0000-000000000104','totp','verified');
  insert into auth.sessions(id,user_id,factor_id,aal) values
  ('00000000-0000-0000-0000-000000000204',
   '00000000-0000-0000-0000-000000000104',
   '00000000-0000-0000-0000-000000000304','aal2');
  insert into auth.refresh_tokens(session_id) values
  ('00000000-0000-0000-0000-000000000204');
  insert into auth.mfa_amr_claims(session_id,authentication_method,updated_at)
  values('00000000-0000-0000-0000-000000000204','totp',clock_timestamp())"
"${race_migrator[@]}" -At -c "select admin_private.arm_initial_owner(
  '00000000-0000-0000-0000-000000000104',decode(repeat('ab',32),'hex'),
  clock_timestamp()+interval '10 minutes',
  '00000000-0000-0000-0000-000000000105',
  '00000000-0000-0000-0000-000000000106')" | tail -1 | grep -qx t
first=$(mktemp); second=$(mktemp)
race_sql="select admin_private.bootstrap_initial_owner(
  '00000000-0000-0000-0000-000000000104',
  '00000000-0000-0000-0000-000000000204',
  decode(repeat('ab',32),'hex'),
  '00000000-0000-0000-0000-000000000106',
  gen_random_uuid(),'bootstrap')"
"${race_migrator[@]}" -At -c "$race_sql" | tail -1 > "$first" &
p1=$!
"${race_migrator[@]}" -At -c "$race_sql" | tail -1 > "$second" &
p2=$!
wait "$p1"; wait "$p2"
[[ "$(cat "$first")$(cat "$second")" == tf ||
   "$(cat "$first")$(cat "$second")" == ft ]] ||
  { echo 'concurrent bootstrap did not produce one winner' >&2; exit 1; }
rm -f "$first" "$second"
[ "$("${race_root[@]}" -At -c "select count(*) from admin_private.role_assignments where role_name='Owner'")" = 1 ] ||
  { echo 'concurrent bootstrap created duplicate Owners' >&2; exit 1; }
echo 'ADM-01B-4 disposable staff lifecycle: PASS'
