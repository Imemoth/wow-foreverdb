-- ADM-01B-2: private, inert server-side authorization evaluator.
-- Additive and unapplied to hosted environments. There is no public RPC,
-- protected application write, policy activation, staff seed or MFA handoff.
-- A later reviewed wrapper must call this inside the SAME transaction as its
-- protected write and audit append. Do not expose this function directly.

begin;

do $preflight$
declare
    t text;
begin
    if to_regnamespace('admin_private') is null
       or to_regrole('admin_executor') is null
       or to_regclass('admin_private.active_policy') is null
       or to_regprocedure('admin_private.authorize_action(text,text,text,text)') is not null
       or to_regprocedure('admin_private.live_auth_session(uuid,uuid)') is not null then
        raise exception '0021 pre-flight: 0020 foundation missing or evaluator already exists';
    end if;
    if (select version_id from admin_private.active_policy where singleton) <> 0
       or exists (select 1 from admin_private.staff_subjects) then
        raise exception '0021 pre-flight: foundation must remain inert';
    end if;
    if exists (
        select 1 from pg_roles where rolname = 'admin_executor'
        and (rolcanlogin or rolinherit or rolbypassrls)
    ) or pg_has_role('anon','admin_executor','MEMBER')
      or pg_has_role('authenticated','admin_executor','MEMBER')
      or pg_has_role('service_role','admin_executor','MEMBER')
      or pg_has_role('authenticator','admin_executor','MEMBER') then
        raise exception '0021 pre-flight: executor boundary changed';
    end if;
    foreach t in array array['users','sessions','refresh_tokens'] loop
        if to_regclass(format('auth.%I',t)) is null then
            raise exception '0021 pre-flight: auth.% missing', t;
        end if;
    end loop;
    if not (select rolbypassrls or rolsuper from pg_roles where rolname=current_user)
       or not has_table_privilege(current_user,'auth.users','SELECT')
       or not has_table_privilege(current_user,'auth.sessions','SELECT')
       or not has_table_privilege(current_user,'auth.sessions','UPDATE')
       or not has_table_privilege(current_user,'auth.refresh_tokens','SELECT') then
        raise exception '0021 pre-flight: migration role lacks reviewed Auth read/lock privileges';
    end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema='auth' and table_name='sessions' and column_name='not_after')
       or not exists (select 1 from information_schema.columns
                      where table_schema='auth' and table_name='refresh_tokens' and column_name='revoked')
       or not exists (select 1 from information_schema.columns
                      where table_schema='auth' and table_name='users' and column_name='is_anonymous')
       or not exists (select 1 from information_schema.columns
                      where table_schema='auth' and table_name='users' and column_name='deleted_at')
       or not exists (select 1 from information_schema.columns
                      where table_schema='auth' and table_name='users' and column_name='banned_until') then
        raise exception '0021 pre-flight: required GoTrue Auth columns missing';
    end if;
end
$preflight$;

-- PostgreSQL requires UPDATE privilege for SELECT ... FOR SHARE. These are
-- column-limited lock privileges; forced RLS and the lock-only UPDATE policies
-- below still prevent the executor from changing Admin rows directly.
grant update (singleton) on admin_private.active_policy to admin_executor;
grant update (user_id) on admin_private.staff_subjects to admin_executor;
grant update (assignment_id) on admin_private.role_assignments to admin_executor;
grant update (grant_id) on admin_private.direct_grants to admin_executor;
-- FOR SHARE consults UPDATE RLS policies as well as SELECT. WITH CHECK false
-- keeps actual UPDATE denied even where the row can be locked for reading.
create policy admin_executor_lock on admin_private.active_policy
    for update to admin_executor using (true) with check (false);
create policy admin_executor_lock on admin_private.staff_subjects
    for update to admin_executor using (true) with check (false);
create policy admin_executor_lock on admin_private.role_assignments
    for update to admin_executor using (true) with check (false);
create policy admin_executor_lock on admin_private.direct_grants
    for update to admin_executor using (true) with check (false);

-- Managed GoTrue Auth tables have RLS enabled. Keep the no-login executor out
-- of Auth entirely. A fixed, private, migration-role-owned helper performs
-- only the liveness lookup and holds the session row lock. The migration role
-- already needs BYPASSRLS and SELECT/UPDATE for the existing Account guards.
-- This elevated SECURITY DEFINER boundary requires independent review before
-- any hosted migration or public action wrapper.
create function admin_private.live_auth_session(p_uid uuid, p_sid uuid)
returns boolean language plpgsql security definer set search_path = ''
as $auth$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
begin
    perform 1 from auth.sessions s
    where s.id=p_sid and s.user_id=p_uid
      and (s.not_after is null or s.not_after > v_now)
    for share;
    if not found then return false; end if;
    return exists (
        select 1 from auth.users u
        where u.id=p_uid and not u.is_anonymous and u.deleted_at is null
          and (u.banned_until is null or u.banned_until <= v_now)
    ) and exists (
        select 1 from auth.refresh_tokens r
        where r.session_id=p_sid and not r.revoked
    );
end
$auth$;
revoke all on function admin_private.live_auth_session(uuid,uuid)
    from public, anon, authenticated, service_role, authenticator;
grant execute on function admin_private.live_auth_session(uuid,uuid) to admin_executor;

create function admin_private.authorize_action(
    p_permission text, p_environment text, p_scope_kind text, p_scope_id text
) returns boolean
language plpgsql security definer set search_path = ''
as $fn$
declare
    v_claims jsonb;
    v_uid uuid;
    v_sid uuid;
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_policy bigint;
    v_has_role boolean := false;
    v_editor boolean := false;
    v_administrator boolean := false;
    v_role_permission boolean := false;
    v_direct_permission boolean := false;
    v_role_deadline timestamptz := 'infinity';
    v_grant_deadline timestamptz := 'infinity';
    v_assignment record;
    v_grant record;
begin
    -- This helper is deliberately private. The eventual public action wrapper
    -- must use a verified PostgREST JWT, not caller-supplied claims or service_role.
    if p_permission is null or p_environment not in ('staging','production')
       or p_scope_kind not in ('global','collection','article')
       or (p_scope_kind = 'global' and p_scope_id is not null)
       or (p_scope_kind <> 'global' and
           (p_scope_id is null or pg_catalog.length(p_scope_id) > 200
            or pg_catalog.btrim(p_scope_id) = '')) then
        return false;
    end if;
    v_claims := pg_catalog.current_setting('request.jwt.claims', true)::jsonb;
    if v_claims is null or v_claims->>'role' <> 'authenticated'
       or v_claims->>'aal' <> 'aal2'
       or (v_claims->>'sub') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (v_claims->>'session_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (v_claims->>'exp') !~ '^[0-9]{1,12}$'
       or pg_catalog.to_timestamp((v_claims->>'exp')::double precision) <= v_now then
        return false;
    end if;
    v_uid := (v_claims->>'sub')::uuid;
    v_sid := (v_claims->>'session_id')::uuid;

    -- Policy switch is the first lock in the Admin authorization order. The
    -- frozen version 0 remains deny-all until a separate activation review.
    select a.version_id into v_policy
    from admin_private.active_policy a where a.singleton for share;
    if v_policy is null or v_policy = 0
       or not exists (
           select 1 from admin_private.policy_versions v
           where v.version_id=v_policy and v.approval_state='approved'
             and v.activated_at is not null
       ) or not exists (
           select 1 from admin_private.permission_catalog c
           where c.permission_key=p_permission
       ) then
        return false;
    end if;

    -- A live GoTrue session is authoritative; a JWT or refreshed iat alone is
    -- insufficient. The helper's session row lock lasts through the caller's write.
    if not admin_private.live_auth_session(v_uid,v_sid) then
        return false;
    end if;

    perform 1 from admin_private.staff_subjects s
    where s.user_id=v_uid and s.status='active' for share;
    if not found then return false; end if;

    -- Lock every currently relevant assignment before deciding. Revocation or
    -- suspension UPDATE requires a conflicting lock. No permission result is cached.
    for v_assignment in
        select a.role_name, a.scope_kind, a.scope_id, a.expires_at, a.review_due_at
        from admin_private.role_assignments a
        where a.user_id=v_uid and a.policy_version_id=v_policy
          and a.environment_scope=p_environment and a.status='active'
          and a.starts_at <= v_now and (a.expires_at is null or a.expires_at > v_now)
          and a.review_due_at > v_now
          and (a.scope_kind='global' or
               (a.scope_kind=p_scope_kind and a.scope_id=p_scope_id))
        order by a.assignment_id for share of a
    loop
        v_role_deadline := least(
            v_role_deadline, coalesce(v_assignment.expires_at,'infinity'::timestamptz),
            v_assignment.review_due_at
        );
        if exists (
            select 1 from admin_private.role_permissions rp
            where rp.version_id=v_policy and rp.role_name=v_assignment.role_name
              and rp.permission_key='admin.enter'
        ) then
            v_has_role := true;
            if v_assignment.role_name='Editor' then v_editor := true; end if;
            if v_assignment.role_name='Administrator' then v_administrator := true; end if;
        end if;
        if exists (
            select 1 from admin_private.role_permissions rp
            where rp.version_id=v_policy and rp.role_name=v_assignment.role_name
              and rp.permission_key=p_permission
        ) then
            v_role_permission := true;
        end if;
    end loop;
    if not v_has_role then return false; end if;

    -- Only the owner-approved editorial grant cells are executable in this
    -- slice. Other proposed grant ceilings remain inactive until staff-lifecycle
    -- review. Owner/Administrator defaults come from versioned role mappings.
    if p_scope_kind <> 'global' and (
        (p_permission='news.article.publish' and (v_editor or v_administrator))
        or (p_permission in ('news.article.approve_highlighted','news.article.unpublish')
            and v_editor)
    ) then
        -- Direct grants are individually scoped, time-bounded and version-bound.
        for v_grant in
            select g.grant_id, g.expires_at from admin_private.direct_grants g
            where g.user_id=v_uid and g.policy_version_id=v_policy
              and g.environment_scope=p_environment and g.status='active'
              and g.permission_key=p_permission
              and g.starts_at <= v_now and g.expires_at > v_now
              and g.scope_kind in ('collection','article')
              and g.scope_kind=p_scope_kind and g.scope_id=p_scope_id
            order by g.grant_id for share of g
        loop
            v_direct_permission := true;
            v_grant_deadline := least(v_grant_deadline,v_grant.expires_at);
        end loop;
    end if;
    -- A lock wait can cross an expiry boundary. Recheck all locked effective
    -- rows and the signed token at the final decision point.
    v_now := pg_catalog.clock_timestamp();
    if v_role_deadline <= v_now
       or (v_direct_permission and v_grant_deadline <= v_now)
       or pg_catalog.to_timestamp((v_claims->>'exp')::double precision) <= v_now
       or not admin_private.live_auth_session(v_uid,v_sid) then
        return false;
    end if;
    return v_role_permission or v_direct_permission;
exception when invalid_text_representation or invalid_parameter_value then
    return false;
end
$fn$;

-- Remove default PUBLIC EXECUTE while the migration role still owns the
-- function. The 0020 migration operator has role-admin membership without SET
-- privilege. Grant SET temporarily for ownership transfer, then revoke it.
revoke all on function admin_private.authorize_action(text,text,text,text)
    from public, anon, authenticated, service_role, authenticator;
grant create on schema admin_private to admin_executor;
grant admin_executor to current_user;
alter function admin_private.authorize_action(text,text,text,text) owner to admin_executor;
revoke admin_executor from current_user;
revoke create on schema admin_private from admin_executor;

commit;
