-- ADM-01B-1 rollback: only for an empty, still-deny-all first slice.
-- Refuses if any staff data or later policy version exists. Run on a backup-tested
-- disposable clone before considering any hosted use. No hosted use in this PR.

begin;

do $preflight$
begin
    if to_regnamespace('admin_private') is null
       or not exists (select 1 from pg_roles where rolname = 'admin_executor') then
        raise exception '0020 rollback: schema or executor role missing';
    end if;
    if (select version_id from admin_private.active_policy where singleton) is distinct from 0
       or (select epoch from admin_private.active_policy where singleton) is distinct from 0
       or (select activated_at from admin_private.active_policy where singleton)
          is distinct from (select created_at from admin_private.policy_versions where version_id = 0)
       or (select count(*) from admin_private.active_policy) <> 1
       or (select count(*) from admin_private.policy_versions) <> 2
       or (select count(*) from admin_private.permission_catalog) <> 22
       or (select count(*) from admin_private.role_catalog) <> 5
       or (select count(*) from admin_private.role_permissions where version_id = 1) <> 30
       or exists (select 1 from admin_private.role_permissions where version_id = 0)
       or exists (select 1 from admin_private.staff_subjects)
       or exists (select 1 from admin_private.role_assignments)
       or exists (select 1 from admin_private.direct_grants) then
        raise exception '0020 rollback: policy changed or staff data exists; preserve and escalate';
    end if;
end
$preflight$;

drop table admin_private.direct_grants;
drop table admin_private.role_assignments;
drop table admin_private.staff_subjects;
drop table admin_private.active_policy;
drop table admin_private.role_permissions;
drop table admin_private.policy_versions;
drop table admin_private.role_catalog;
drop table admin_private.permission_catalog;
drop function admin_private.reject_active_mapping_insert();
drop function admin_private.reject_immutable_change();
drop schema admin_private restrict;
drop role admin_executor;

commit;
