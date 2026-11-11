-- Guarded rollback of the private, never-exposed 0021 evaluator.
-- Refuse after any policy activation or staff data; preserve evidence for review.
begin;
do $guard$
begin
    if to_regprocedure('admin_private.authorize_action(text,text,text,text)') is null
       or (select version_id from admin_private.active_policy where singleton) <> 0
       or exists (select 1 from admin_private.staff_subjects)
       or exists (select 1 from admin_private.role_assignments)
       or exists (select 1 from admin_private.direct_grants) then
        raise exception '0021 rollback: preserve and escalate after activation or staff data';
    end if;
end
$guard$;
drop function admin_private.authorize_action(text,text,text,text);
drop function admin_private.live_auth_session(uuid,uuid);
drop policy admin_executor_lock on admin_private.active_policy;
drop policy admin_executor_lock on admin_private.staff_subjects;
drop policy admin_executor_lock on admin_private.role_assignments;
drop policy admin_executor_lock on admin_private.direct_grants;
revoke update (singleton) on admin_private.active_policy from admin_executor;
revoke update (user_id) on admin_private.staff_subjects from admin_executor;
revoke update (assignment_id) on admin_private.role_assignments from admin_executor;
revoke update (grant_id) on admin_private.direct_grants from admin_executor;
commit;
