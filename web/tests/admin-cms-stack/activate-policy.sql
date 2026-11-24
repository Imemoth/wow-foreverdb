\set ON_ERROR_STOP on
-- ADM-04 DISPOSABLE-ONLY activation of the reviewed policy version 1. It switches the immutability triggers off as the cluster superuser, which a
-- hosted operator can never do and which this repository never ships as a migration. It runs only inside web/tests/admin-cms-stack/up.sh against
-- the throw-away database. Staff, roles and grants are inserted per test by web/tests/admin-cms-e2e/fixtures.ts.
alter table admin_private.policy_versions disable trigger policy_versions_immutable;
update admin_private.policy_versions set approval_state='approved',activated_at=clock_timestamp() where version_id=1;
alter table admin_private.policy_versions enable trigger policy_versions_immutable;
alter table admin_private.active_policy disable trigger active_policy_immutable;
update admin_private.active_policy set version_id=1,epoch=1,activated_at=clock_timestamp() where singleton;
alter table admin_private.active_policy enable trigger active_policy_immutable;
