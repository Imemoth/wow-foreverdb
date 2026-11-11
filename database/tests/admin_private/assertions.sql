-- Assertions against the disposable first-slice migration. An exception fails CI.
do $assert$
declare
    v_tables text[] := array[
        'permission_catalog', 'role_catalog', 'policy_versions',
        'role_permissions', 'active_policy', 'staff_subjects',
        'role_assignments', 'direct_grants'
    ];
    v_table text;
begin
    if (select count(*) from pg_roles where rolname = 'admin_executor'
        and not rolcanlogin and not rolinherit and not rolbypassrls) <> 1 then
        raise exception 'executor must be NOLOGIN NOINHERIT without BYPASSRLS';
    end if;
    if pg_has_role('anon', 'admin_executor', 'MEMBER')
       or pg_has_role('authenticated', 'admin_executor', 'MEMBER')
       or pg_has_role('service_role', 'admin_executor', 'MEMBER')
       or pg_has_role('authenticator', 'admin_executor', 'MEMBER') then
        raise exception 'API role can assume or inherit executor';
    end if;

    foreach v_table in array v_tables loop
        if not exists (
            select 1 from pg_class c
            where c.oid = format('admin_private.%I', v_table)::regclass
              and c.relrowsecurity and c.relforcerowsecurity
        ) then
            raise exception 'RLS and FORCE missing on %', v_table;
        end if;
        if exists (
            select 1
            from unnest(array['anon','authenticated','service_role','authenticator']) as api(role_name)
            cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as priv(name)
            where has_table_privilege(api.role_name, format('admin_private.%I', v_table), priv.name)
        ) then
            raise exception 'direct API table grant on %', v_table;
        end if;
        if not has_table_privilege('admin_executor', format('admin_private.%I', v_table), 'SELECT')
           or has_table_privilege('admin_executor', format('admin_private.%I', v_table), 'INSERT')
           or has_table_privilege('admin_executor', format('admin_private.%I', v_table), 'UPDATE')
           or has_table_privilege('admin_executor', format('admin_private.%I', v_table), 'DELETE') then
            raise exception 'executor table privilege exceeds read-only on %', v_table;
        end if;
        if not exists (
            select 1 from pg_policy p
            where p.polrelid = format('admin_private.%I', v_table)::regclass
              and p.polcmd = 'r'
              and (select oid from pg_roles where rolname = 'admin_executor') = any(p.polroles)
        ) then
            raise exception 'executor SELECT RLS policy missing on %', v_table;
        end if;
    end loop;

    if has_schema_privilege('anon', 'admin_private', 'USAGE')
       or has_schema_privilege('authenticated', 'admin_private', 'USAGE')
       or has_schema_privilege('service_role', 'admin_private', 'USAGE')
       or has_schema_privilege('authenticator', 'admin_private', 'USAGE') then
        raise exception 'API role has admin_private schema USAGE';
    end if;
    if has_table_privilege('admin_executor', 'auth.users', 'SELECT')
       or has_schema_privilege('admin_executor', 'auth', 'USAGE')
       or has_table_privilege('admin_executor', 'public.account_sentinel', 'SELECT')
       or has_table_privilege('admin_executor', 'private.guildbook_sentinel', 'SELECT') then
        raise exception 'executor crossed managed Auth/Account/Guildbook boundary';
    end if;
    if exists (
        select 1
        from unnest(array['anon','authenticated','service_role','authenticator']) as api(role_name)
        cross join unnest(array[
            'admin_private.reject_immutable_change()',
            'admin_private.reject_active_mapping_insert()'
        ]) as helper(signature)
        where has_function_privilege(api.role_name, helper.signature, 'EXECUTE')
    ) then
        raise exception 'Admin trigger function broadly executable';
    end if;
    if exists (
        select 1 from pg_proc p where p.pronamespace = 'admin_private'::regnamespace
        and p.prosecdef
    ) then
        raise exception 'first slice has a privileged function';
    end if;
    if exists (
        select 1 from pg_policy p
        where p.polrelid in (
            select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'admin_private'
        ) and (
            (select oid from pg_roles where rolname = 'anon') = any(p.polroles)
            or (select oid from pg_roles where rolname = 'authenticated') = any(p.polroles)
            or 0 = any(p.polroles)
        )
    ) then
        raise exception 'API/PUBLIC RLS policy found';
    end if;

    if (select count(*) from admin_private.permission_catalog) <> 22
       or (select count(*) from admin_private.role_catalog) <> 5
       or (select count(*) from admin_private.policy_versions) <> 2
       or (select count(*) from admin_private.role_permissions where version_id = 1) <> 30
       or exists (select 1 from admin_private.role_permissions where version_id = 0)
       or (select version_id from admin_private.active_policy where singleton) is distinct from 0
       or (select epoch from admin_private.active_policy where singleton) is distinct from 0
       or (select count(*) from admin_private.active_policy) <> 1
       or exists (select 1 from admin_private.staff_subjects)
       or exists (select 1 from admin_private.role_assignments)
       or exists (select 1 from admin_private.direct_grants) then
        raise exception 'policy is not an empty active deny-all with inactive V1';
    end if;
    if exists (
        select 1 from admin_private.role_permissions
        where role_name = 'User'
           or (role_name in ('Editor', 'Administrator') and permission_key = 'news.article.publish')
           or (role_name = 'Editor' and permission_key = 'news.article.approve_highlighted')
    ) or not exists (
        select 1 from admin_private.role_permissions
        where role_name = 'Owner' and permission_key = 'news.article.publish'
    ) or not exists (
        select 1 from admin_private.role_permissions
        where role_name = 'Owner' and permission_key = 'news.article.approve_highlighted'
    ) then
        raise exception 'ADR-020 default permission mapping changed';
    end if;
    if exists (
        select 1 from admin_private.policy_versions
        where catalog_sha256 <> (
            select pg_catalog.sha256(pg_catalog.convert_to(
                string_agg(permission_key, E'\n' order by permission_key), 'UTF8'))
            from admin_private.permission_catalog
        )
    ) then
        raise exception 'catalog hash mismatch';
    end if;
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'admin_private.staff_subjects'::regclass
          and contype = 'f' and confrelid = 'auth.users'::regclass and confdeltype = 'r'
    ) then
        raise exception 'staff subject must RESTRICT Auth user deletion';
    end if;
    if (select payload from private.guildbook_sentinel where id = 1) <> 'untouched'
       or (select payload from public.account_sentinel where id = 1) <> 'untouched' then
        raise exception 'unrelated Account/Guildbook data changed';
    end if;
end
$assert$;

-- Test actual constraint and trigger behavior; all fixture writes roll back.
begin;
insert into auth.users (id) values ('00000000-0000-0000-0000-000000000001');
insert into admin_private.staff_subjects (user_id, status)
values ('00000000-0000-0000-0000-000000000001', 'active');

do $negative$
begin
    begin
        insert into admin_private.permission_catalog values ('production.deploy');
        raise exception 'unknown permission was accepted';
    exception when check_violation then null;
    end;
    begin
        insert into admin_private.role_catalog values ('Superuser');
        raise exception 'unknown role was accepted';
    exception when check_violation then null;
    end;
    begin
        delete from auth.users where id = '00000000-0000-0000-0000-000000000001';
        raise exception 'Auth deletion unexpectedly removed a staff subject';
    exception when foreign_key_violation then null;
    end;
    begin
        insert into admin_private.direct_grants
            (user_id, permission_key, policy_version_id, environment_scope,
             scope_kind, starts_at, expires_at, status, reason)
        values
            ('00000000-0000-0000-0000-000000000001', 'news.article.publish', 1,
             'staging', 'global', now(), now() + interval '2161 hours',
             'proposed', 'synthetic test');
        raise exception 'grant longer than 90 days was accepted';
    exception when check_violation then null;
    end;
    begin
        update admin_private.policy_versions set label = 'edited' where version_id = 1;
        raise exception 'policy version was mutable';
    exception when insufficient_privilege then null;
    end;
    begin
        update admin_private.active_policy set version_id = 1 where singleton;
        raise exception 'proposed policy could be activated';
    exception when insufficient_privilege then null;
    end;
    begin
        insert into admin_private.role_permissions
            (version_id, role_name, permission_key)
        values (0, 'Owner', 'admin.enter');
        raise exception 'active deny-all accepted a permission';
    exception when check_violation or insufficient_privilege then null;
    end;
end
$negative$;
rollback;

-- Temporarily give authenticated SELECT to prove RLS itself still hides all rows.
begin;
grant usage on schema admin_private to authenticated;
grant select on admin_private.permission_catalog to authenticated;
set role authenticated;
do $rls$
begin
    if (select count(*) from admin_private.permission_catalog) <> 0 then
        raise exception 'RLS leaked catalog rows to authenticated';
    end if;
end
$rls$;
reset role;
rollback;
