-- Disposable rehearsal only. Any staff/bootstrap/audit state requires
-- preservation and an incident-reviewed recovery path, never a destructive rollback.
begin;
do $guard$
begin
  if to_regclass('admin_private.staff_audit_events') is null
     or (select version_id from admin_private.active_policy where singleton)<>0
     or exists(select 1 from admin_private.staff_subjects)
     or exists(select 1 from admin_private.staff_action_approvals)
     or exists(select 1 from admin_private.staff_emergency_reviews)
     or exists(select 1 from admin_private.staff_audit_events)
     or (select event_no from admin_private.staff_audit_head where singleton)<>0
     or exists(select 1 from admin_private.bootstrap_control
       where target_uid is not null or consumed_at is not null) then
    raise exception '0023 rollback: protected Admin state exists; preserve and escalate';
  end if;
end $guard$;

drop function public.fdb_admin_emergency_review(bigint,boolean);
drop function public.fdb_admin_grant_revoke(uuid,text);
drop function public.fdb_admin_role_revoke(uuid,text);
drop function public.fdb_admin_staff_reinstate(uuid,text);
drop function public.fdb_admin_staff_suspend(uuid,text);
drop function public.fdb_admin_grant_approve(uuid);
drop function public.fdb_admin_grant_propose(uuid,text,text,text,integer,text);
drop function public.fdb_admin_role_approve(uuid);
drop function public.fdb_admin_role_propose(uuid,text,integer,text);
drop function public.fdb_admin_staff_prepare(uuid,text);
drop function admin_private.bootstrap_initial_owner(uuid,uuid,bytea,uuid,uuid,text);
drop function admin_private.expire_staff_authority();
drop function admin_private.arm_initial_owner(uuid,bytea,timestamptz,uuid,uuid);
drop function admin_private.staff_grant_ceiling(uuid,text,text,text,bigint);
drop function admin_private.staff_is_owner(uuid,bigint);
drop function admin_private.require_staff_fresh_commit(text,uuid);
drop function admin_private.staff_actor(text);
drop function admin_private.schedule_emergency_review(bigint,uuid,uuid);
drop function admin_private.record_staff_denial(uuid,uuid,text);
drop function admin_private.append_staff_audit(uuid,uuid,uuid,text,text,bigint,text,text,uuid,jsonb,jsonb,text);
drop function admin_private.eligible_staff_identity(uuid);
drop function admin_private.valid_staff_reason(text);
drop trigger role_lifetime_guard on admin_private.role_assignments;
drop function admin_private.role_lifetime_guard();

drop policy staff_writer_subject_insert on admin_private.staff_subjects;
drop policy staff_writer_subject_update on admin_private.staff_subjects;
drop policy staff_writer_role_insert on admin_private.role_assignments;
drop policy staff_writer_role_update on admin_private.role_assignments;
drop policy staff_writer_grant_insert on admin_private.direct_grants;
drop policy staff_writer_grant_update on admin_private.direct_grants;
revoke insert on admin_private.staff_subjects,admin_private.role_assignments,
  admin_private.direct_grants from admin_executor;
revoke update(status,epoch,changed_at) on admin_private.staff_subjects from admin_executor;
revoke update(status,approved_by,revoked_at) on admin_private.role_assignments from admin_executor;
revoke update(status,approved_by,revoked_at) on admin_private.direct_grants from admin_executor;

drop table admin_private.staff_action_approvals;
drop table admin_private.staff_emergency_reviews;
drop table admin_private.staff_audit_events;
drop table admin_private.staff_audit_head;
drop table admin_private.bootstrap_control;
commit;
