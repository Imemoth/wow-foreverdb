-- ADM-01B-1: inert Admin authorization source. Additive; never applied by this PR.
-- ADR-020 policy names are seeded, but only version 0 (deny-all) is active.
-- No staff row, privileged RPC, live evaluator, Auth-table grant, or production setting is created.
-- The deployment operator must verify that admin_private is absent from PostgREST exposed schemas.
-- Rehearse database/rollback/0020_admin_private_authorization_rollback.sql before any hosted application.

begin;

do $preflight$
begin
    if to_regnamespace('admin_private') is not null
       or exists (select 1 from pg_roles where rolname = 'admin_executor') then
        raise exception '0020 pre-flight: admin_private schema or admin_executor role already exists';
    end if;
    if to_regclass('auth.users') is null
       or not exists (
           select 1 from information_schema.columns
           where table_schema = 'auth' and table_name = 'users' and column_name = 'id'
       ) then
        raise exception '0020 pre-flight: auth.users(id) is required';
    end if;
    if not has_database_privilege(current_user, current_database(), 'CREATE') then
        raise exception '0020 pre-flight: migration role lacks CREATE on database';
    end if;
    if not has_table_privilege(current_user, 'auth.users', 'REFERENCES') then
        raise exception '0020 pre-flight: migration role lacks REFERENCES on auth.users';
    end if;
    if not exists (
        select 1 from pg_roles
        where rolname = current_user and rolcreaterole and (rolbypassrls or rolsuper)
    ) then
        raise exception '0020 pre-flight: migration role needs CREATEROLE and BYPASSRLS';
    end if;
    if to_regprocedure('pg_catalog.sha256(bytea)') is null
       or to_regprocedure('pg_catalog.gen_random_uuid()') is null then
        raise exception '0020 pre-flight: PostgreSQL SHA-256 and gen_random_uuid are required';
    end if;
    if to_regclass('supabase_migrations.schema_migrations') is not null
       and exists (
           select 1 from supabase_migrations.schema_migrations
           where name = 'admin_private_authorization'
       ) then
        raise exception '0020 pre-flight: migration is already recorded';
    end if;
end
$preflight$;

create role admin_executor nologin noinherit;
create schema admin_private;
revoke all on schema admin_private from public, anon, authenticated, service_role, authenticator;
grant usage on schema admin_private to admin_executor;

-- Per-schema defaults are defense in depth. Each future table/function migration must also
-- revoke its actual ACLs: per-schema defaults cannot cancel a broader global default grant.
alter default privileges in schema admin_private
    revoke all on tables from public, anon, authenticated, service_role, authenticator;
alter default privileges in schema admin_private
    revoke all on sequences from public, anon, authenticated, service_role, authenticator;
alter default privileges in schema admin_private
    revoke all on functions from public, anon, authenticated, service_role, authenticator;

create table admin_private.permission_catalog (
    permission_key text primary key,
    check (permission_key in (
        'admin.enter',
        'news.draft.write', 'news.article.preview', 'news.article.submit',
        'news.article.review', 'news.article.classify',
        'news.article.approve_highlighted', 'news.article.publish',
        'news.article.unpublish', 'news.media.manage', 'news.media.validate',
        'moderation.case.read', 'moderation.case.decide', 'moderation.case.reverse',
        'staff.role.propose', 'staff.grant.propose', 'staff.role.approve',
        'staff.grant.approve', 'staff.access.revoke',
        'audit.editorial.read', 'audit.staff.read', 'ops.status.read'
    ))
);

create table admin_private.role_catalog (
    role_name text primary key,
    check (role_name in ('User', 'Moderator', 'Editor', 'Administrator', 'Owner'))
);

create table admin_private.policy_versions (
    version_id bigint primary key check (version_id >= 0),
    label text not null unique check (btrim(label) <> ''),
    catalog_sha256 bytea not null check (octet_length(catalog_sha256) = 32),
    approval_state text not null check (approval_state in ('system_deny_all', 'proposed', 'approved')),
    created_at timestamptz not null default now(),
    proposer_id uuid,
    approver_id uuid,
    activated_at timestamptz
);

create table admin_private.role_permissions (
    version_id bigint not null references admin_private.policy_versions (version_id) on delete restrict,
    role_name text not null references admin_private.role_catalog (role_name) on delete restrict,
    permission_key text not null references admin_private.permission_catalog (permission_key) on delete restrict,
    primary key (version_id, role_name, permission_key),
    -- Version 0 is permanently empty, even if a migration owner attempts to add a mapping.
    check (version_id > 0)
);

create table admin_private.active_policy (
    singleton boolean primary key default true check (singleton),
    version_id bigint not null references admin_private.policy_versions (version_id) on delete restrict,
    epoch bigint not null default 0 check (epoch >= 0),
    activated_at timestamptz not null default now()
);

create table admin_private.staff_subjects (
    user_id uuid primary key references auth.users (id) on delete restrict,
    status text not null check (status in ('active', 'suspended')),
    epoch bigint not null default 0 check (epoch >= 0),
    created_at timestamptz not null default now(),
    changed_at timestamptz not null default now()
);

create table admin_private.role_assignments (
    assignment_id uuid primary key default pg_catalog.gen_random_uuid(),
    user_id uuid not null references admin_private.staff_subjects (user_id) on delete restrict,
    role_name text not null references admin_private.role_catalog (role_name) on delete restrict,
    policy_version_id bigint not null references admin_private.policy_versions (version_id) on delete restrict,
    environment_scope text not null check (environment_scope in ('staging', 'production')),
    scope_kind text not null check (scope_kind in ('global', 'collection', 'article')),
    scope_id text,
    starts_at timestamptz not null,
    expires_at timestamptz,
    review_due_at timestamptz not null,
    status text not null check (status in ('proposed', 'active', 'revoked')),
    proposal_id uuid,
    proposed_by uuid,
    approved_by uuid,
    reason text not null check (btrim(reason) <> ''),
    revoked_at timestamptz,
    check ((scope_kind = 'global' and scope_id is null)
        or (scope_kind <> 'global' and scope_id is not null and btrim(scope_id) <> '')),
    check (expires_at is null or expires_at > starts_at),
    check (review_due_at > starts_at),
    check (status <> 'active' or approved_by is not null),
    check (status <> 'revoked' or revoked_at is not null)
);
create unique index admin_role_assignments_active_uniq
    on admin_private.role_assignments
    (user_id, role_name, environment_scope, scope_kind, (coalesce(scope_id, '')))
    where status = 'active';

create table admin_private.direct_grants (
    grant_id uuid primary key default pg_catalog.gen_random_uuid(),
    user_id uuid not null references admin_private.staff_subjects (user_id) on delete restrict,
    permission_key text not null references admin_private.permission_catalog (permission_key) on delete restrict,
    policy_version_id bigint not null references admin_private.policy_versions (version_id) on delete restrict,
    environment_scope text not null check (environment_scope in ('staging', 'production')),
    scope_kind text not null check (scope_kind in ('global', 'collection', 'article')),
    scope_id text,
    starts_at timestamptz not null,
    expires_at timestamptz not null,
    status text not null check (status in ('proposed', 'active', 'revoked')),
    proposal_id uuid,
    proposed_by uuid,
    approved_by uuid,
    reason text not null check (btrim(reason) <> ''),
    revoked_at timestamptz,
    check ((scope_kind = 'global' and scope_id is null)
        or (scope_kind <> 'global' and scope_id is not null and btrim(scope_id) <> '')),
    check (expires_at > starts_at),
    check (expires_at <= starts_at + interval '2160 hours'),
    check (status <> 'active' or approved_by is not null),
    check (status <> 'revoked' or revoked_at is not null)
);
create unique index admin_direct_grants_active_uniq
    on admin_private.direct_grants
    (user_id, permission_key, environment_scope, scope_kind, (coalesce(scope_id, '')))
    where status = 'active';

insert into admin_private.permission_catalog (permission_key) values
    ('admin.enter'),
    ('news.draft.write'), ('news.article.preview'), ('news.article.submit'),
    ('news.article.review'), ('news.article.classify'),
    ('news.article.approve_highlighted'), ('news.article.publish'),
    ('news.article.unpublish'), ('news.media.manage'), ('news.media.validate'),
    ('moderation.case.read'), ('moderation.case.decide'), ('moderation.case.reverse'),
    ('staff.role.propose'), ('staff.grant.propose'), ('staff.role.approve'),
    ('staff.grant.approve'), ('staff.access.revoke'),
    ('audit.editorial.read'), ('audit.staff.read'), ('ops.status.read');

insert into admin_private.role_catalog (role_name) values
    ('User'), ('Moderator'), ('Editor'), ('Administrator'), ('Owner');

insert into admin_private.policy_versions (version_id, label, catalog_sha256, approval_state)
select v.version_id, v.label,
       pg_catalog.sha256(pg_catalog.convert_to(
           (select string_agg(permission_key, E'\n' order by permission_key)
            from admin_private.permission_catalog), 'UTF8')),
       v.approval_state
from (values (0, 'deny-all', 'system_deny_all'), (1, 'v1-proposed', 'proposed'))
    as v(version_id, label, approval_state);

-- Version 1 is proposed and INACTIVE. G-cells from ADR-020 are not defaults.
insert into admin_private.role_permissions (version_id, role_name, permission_key) values
    (1, 'Moderator', 'admin.enter'),
    (1, 'Moderator', 'moderation.case.read'),
    (1, 'Moderator', 'moderation.case.decide'),
    (1, 'Moderator', 'moderation.case.reverse'),
    (1, 'Editor', 'admin.enter'),
    (1, 'Editor', 'news.draft.write'),
    (1, 'Editor', 'news.article.preview'),
    (1, 'Editor', 'news.article.submit'),
    (1, 'Editor', 'news.article.review'),
    (1, 'Editor', 'news.article.classify'),
    (1, 'Editor', 'news.media.manage'),
    (1, 'Editor', 'news.media.validate'),
    (1, 'Administrator', 'admin.enter'),
    (1, 'Administrator', 'news.article.approve_highlighted'),
    (1, 'Administrator', 'news.article.unpublish'),
    (1, 'Administrator', 'staff.role.propose'),
    (1, 'Administrator', 'staff.grant.propose'),
    (1, 'Administrator', 'audit.editorial.read'),
    (1, 'Administrator', 'audit.staff.read'),
    (1, 'Owner', 'admin.enter'),
    (1, 'Owner', 'news.article.approve_highlighted'),
    (1, 'Owner', 'news.article.publish'),
    (1, 'Owner', 'news.article.unpublish'),
    (1, 'Owner', 'staff.role.propose'),
    (1, 'Owner', 'staff.role.approve'),
    (1, 'Owner', 'staff.grant.propose'),
    (1, 'Owner', 'staff.grant.approve'),
    (1, 'Owner', 'staff.access.revoke'),
    (1, 'Owner', 'audit.editorial.read'),
    (1, 'Owner', 'audit.staff.read');

insert into admin_private.active_policy (singleton, version_id, epoch)
values (true, 0, 0);

-- Immutable catalog/version rows cannot be edited in place. New reviewed policy
-- versions must be appended; an active mapping cannot be extended.
create function admin_private.reject_immutable_change()
returns trigger language plpgsql set search_path = ''
as $fn$
begin
    raise exception 'Admin policy/catalog rows are immutable' using errcode = '42501';
end
$fn$;

create function admin_private.reject_active_mapping_insert()
returns trigger language plpgsql set search_path = ''
as $fn$
begin
    if exists (
        select 1 from admin_private.active_policy
        where version_id = new.version_id
    ) then
        raise exception 'Cannot add mapping to active Admin policy' using errcode = '42501';
    end if;
    return new;
end
$fn$;

create trigger permission_catalog_immutable before update or delete
    on admin_private.permission_catalog for each row execute function admin_private.reject_immutable_change();
create trigger role_catalog_immutable before update or delete
    on admin_private.role_catalog for each row execute function admin_private.reject_immutable_change();
create trigger policy_versions_immutable before update or delete
    on admin_private.policy_versions for each row execute function admin_private.reject_immutable_change();
create trigger role_permissions_immutable before update or delete
    on admin_private.role_permissions for each row execute function admin_private.reject_immutable_change();
create trigger active_policy_no_delete before delete
    on admin_private.active_policy for each row execute function admin_private.reject_immutable_change();
create trigger role_permissions_no_active_insert before insert
    on admin_private.role_permissions for each row execute function admin_private.reject_active_mapping_insert();

-- No Data API role gets schema usage or a table/function grant. service_role can
-- bypass RLS but still has no direct schema/table grant here; guard its key separately.
revoke all on all tables in schema admin_private
    from public, anon, authenticated, service_role, authenticator;
revoke all on all sequences in schema admin_private
    from public, anon, authenticated, service_role, authenticator;
revoke all on function admin_private.reject_immutable_change()
    from public, anon, authenticated, service_role, authenticator;
revoke all on function admin_private.reject_active_mapping_insert()
    from public, anon, authenticated, service_role, authenticator;

-- The non-login executor can only read in this slice. There are no runtime
-- functions and no membership from an API/application role to admin_executor.
grant select on all tables in schema admin_private to admin_executor;
do $lockdown$
declare
    t text;
begin
    foreach t in array array[
        'permission_catalog', 'role_catalog', 'policy_versions',
        'role_permissions', 'active_policy', 'staff_subjects',
        'role_assignments', 'direct_grants'
    ] loop
        execute format('alter table admin_private.%I enable row level security', t);
        execute format('alter table admin_private.%I force row level security', t);
        execute format(
            'create policy admin_executor_read on admin_private.%I for select to admin_executor using (true)', t
        );
    end loop;
end
$lockdown$;

commit;
