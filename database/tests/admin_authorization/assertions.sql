\set ON_ERROR_STOP on
do $test$
declare
    p record;
    h record;
begin
    select * into p from pg_proc where oid = to_regprocedure('admin_private.authorize_action(text,text,text,text)');
    if p.oid is null then raise exception 'missing central evaluator'; end if;
    if pg_get_userbyid(p.proowner) <> 'admin_executor' or not p.prosecdef
       or p.proconfig <> array['search_path=""']::text[] then
        raise exception 'evaluator ownership/security/search path mismatch: %, %, %',
            pg_get_userbyid(p.proowner), p.prosecdef, p.proconfig;
    end if;
    if has_schema_privilege('authenticated','admin_private','USAGE')
       or has_function_privilege('authenticated',p.oid,'EXECUTE')
       or has_function_privilege('anon',p.oid,'EXECUTE')
       or has_function_privilege('service_role',p.oid,'EXECUTE')
       or pg_has_role('authenticated','admin_executor','MEMBER') then
        raise exception 'API role has executor/evaluator access';
    end if;
    if has_schema_privilege('admin_executor','auth','USAGE')
       or has_table_privilege('admin_executor','auth.sessions','SELECT')
       or has_function_privilege('authenticated',
             'admin_private.live_auth_session(uuid,uuid)'::regprocedure,'EXECUTE')
       or not has_function_privilege('admin_executor',
             'admin_private.live_auth_session(uuid,uuid)'::regprocedure,'EXECUTE') then
        raise exception 'live Auth helper boundary mismatch';
    end if;
    select * into h from pg_proc where oid='admin_private.live_auth_session(uuid,uuid)'::regprocedure;
    if not h.prosecdef or h.proconfig <> array['search_path=""']::text[]
       or not (select rolbypassrls from pg_roles where oid=h.proowner)
       or pg_has_role('authenticated','admin_executor','MEMBER')
       or pg_has_role('fdb_migrator','admin_executor','SET') then
        raise exception 'private Auth helper ownership or executor membership mismatch: owner %, definer %, config %, bypass %, authmember %',
            pg_get_userbyid(h.proowner), h.prosecdef, h.proconfig,
            (select rolbypassrls from pg_roles where oid=h.proowner),
            pg_has_role('authenticated','admin_executor','MEMBER');
    end if;
    if (select version_id from admin_private.active_policy) <> 0
       or (select approval_state from admin_private.policy_versions where version_id=1) <> 'proposed' then
        raise exception 'migration activated the proposed policy';
    end if;
end
$test$;

-- An artificial signed-JWT context in a disposable DB still denies while
-- policy version 0 is active. The test process alone can SET ROLE executor.
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $test$
begin
    if admin_private.authorize_action('admin.enter','staging','global',null) then
        raise exception 'deny-all policy authorized an action';
    end if;
end
$test$;
reset role;

-- Synthetic future-approved policy/subjects are confined to this disposable
-- fixture. Migration 0021 must never install these rows or activate V1.
alter table admin_private.policy_versions disable trigger policy_versions_immutable;
update admin_private.policy_versions set approval_state='approved', activated_at=clock_timestamp()
where version_id=1;
alter table admin_private.policy_versions enable trigger policy_versions_immutable;
alter table admin_private.active_policy disable trigger active_policy_immutable;
update admin_private.active_policy set version_id=1, epoch=1, activated_at=clock_timestamp();
alter table admin_private.active_policy enable trigger active_policy_immutable;
insert into auth.users (id) values ('00000000-0000-0000-0000-000000000101');
insert into auth.sessions (id,user_id) values
    ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000101');
insert into auth.refresh_tokens (session_id) values ('00000000-0000-0000-0000-000000000201');
insert into admin_private.staff_subjects (user_id,status) values
    ('00000000-0000-0000-0000-000000000101','active');
insert into admin_private.role_assignments
    (user_id,role_name,policy_version_id,environment_scope,scope_kind,starts_at,
     review_due_at,status,approved_by,reason)
values ('00000000-0000-0000-0000-000000000101','Editor',1,'staging','global',
        clock_timestamp()-interval '1 day',clock_timestamp()+interval '30 days',
        'active','00000000-0000-0000-0000-000000000301','synthetic fixture');
insert into admin_private.direct_grants
    (user_id,permission_key,policy_version_id,environment_scope,scope_kind,scope_id,
     starts_at,expires_at,status,approved_by,reason)
values ('00000000-0000-0000-0000-000000000101','news.article.publish',1,'staging',
        'article','story-1',clock_timestamp()-interval '1 day',
        clock_timestamp()+interval '30 days','active',
        '00000000-0000-0000-0000-000000000301','synthetic fixture');

set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $test$
begin
    if not admin_private.authorize_action('admin.enter','staging','global',null)
       or not admin_private.authorize_action('news.article.publish','staging','article','story-1')
       or admin_private.authorize_action('news.article.publish','staging','article','story-2')
       or admin_private.authorize_action('news.article.publish','production','article','story-1')
       or admin_private.authorize_action('staff.role.approve','staging','global',null)
       or admin_private.authorize_action('made.up','staging','global',null) then
        raise exception 'version/scope/closed-catalog decision mismatch: enter %, publish %, wrongscope %, prod %, role %, unknown %',
            admin_private.authorize_action('admin.enter','staging','global',null),
            admin_private.authorize_action('news.article.publish','staging','article','story-1'),
            admin_private.authorize_action('news.article.publish','staging','article','story-2'),
            admin_private.authorize_action('news.article.publish','production','article','story-1'),
            admin_private.authorize_action('staff.role.approve','staging','global',null),
            admin_private.authorize_action('made.up','staging','global',null);
    end if;
end
$test$;
-- Every required JWT field must be present. SQL NULL must never turn an OR
-- guard into an implicit allow when the staff row and role are otherwise valid.
do $test$
declare
    good jsonb := '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}'::jsonb;
    field text;
begin
    foreach field in array array['aal','role','exp','sub','session_id'] loop
        perform pg_catalog.set_config('request.jwt.claims', (good - field)::text, false);
        if admin_private.authorize_action('admin.enter','staging','global',null) then
            raise exception 'missing JWT % claim admitted', field;
        end if;
        perform pg_catalog.set_config('request.jwt.claims',
            (good || pg_catalog.jsonb_build_object(field,null))::text, false);
        if admin_private.authorize_action('admin.enter','staging','global',null) then
            raise exception 'NULL JWT % claim admitted', field;
        end if;
    end loop;
    perform pg_catalog.set_config('request.jwt.claims', good::text, false);
    if admin_private.authorize_action('admin.enter','staging',null,null)
       or admin_private.authorize_action('admin.enter',null,'global',null) then
        raise exception 'NULL environment or resource scope admitted';
    end if;
end
$test$;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal1","exp":4102444800}';
do $test$ begin
    if admin_private.authorize_action('admin.enter','staging','global',null) then
        raise exception 'AAL1 admitted';
    end if;
end $test$;
-- Column-level UPDATE exists only to permit FOR SHARE; forced RLS WITH CHECK
-- false must still prevent an executor from changing any lockable Admin row.
do $test$ begin
    begin
        update admin_private.active_policy set singleton=singleton;
        raise exception 'executor changed active policy';
    exception when insufficient_privilege then null;
    end;
    begin
        update admin_private.staff_subjects set user_id=user_id;
        raise exception 'executor changed staff subject';
    exception when insufficient_privilege then null;
    end;
    begin
        update admin_private.role_assignments set assignment_id=assignment_id;
        raise exception 'executor changed an assignment';
    exception when insufficient_privilege then null;
    end;
    begin
        update admin_private.direct_grants set grant_id=grant_id;
        raise exception 'executor changed a direct grant';
    exception when insufficient_privilege then null;
    end;
end $test$;
reset role;

-- A grant cannot elevate a Moderator into an Editor/Administrator publishing
-- cell, nor can a global grant bypass the explicit article/collection scope.
update admin_private.role_assignments set role_name='Moderator';
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $test$ begin
    if admin_private.authorize_action('news.article.publish','staging','article','story-1') then
        raise exception 'Moderator escalated through a publishing grant';
    end if;
end $test$;
reset role;
update admin_private.role_assignments set role_name='Editor';
insert into admin_private.direct_grants
    (user_id,permission_key,policy_version_id,environment_scope,scope_kind,
     starts_at,expires_at,status,approved_by,reason)
values ('00000000-0000-0000-0000-000000000101','news.article.publish',1,'staging',
        'global',clock_timestamp()-interval '1 day',clock_timestamp()+interval '30 days',
        'active','00000000-0000-0000-0000-000000000301','synthetic forbidden scope');
set role admin_executor;
do $test$ begin
    if admin_private.authorize_action('news.article.publish','staging','article','story-2') then
        raise exception 'global publishing grant bypassed article scope';
    end if;
end $test$;
reset role;
delete from admin_private.direct_grants where scope_kind='global';

update auth.refresh_tokens set revoked=true;
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $test$ begin
    if admin_private.authorize_action('admin.enter','staging','global',null) then
        raise exception 'revoked Auth session admitted';
    end if;
end $test$;
reset role;
update auth.refresh_tokens set revoked=false;

update admin_private.staff_subjects set status='suspended';
set role admin_executor;
do $test$ begin
    if admin_private.authorize_action('admin.enter','staging','global',null) then
        raise exception 'suspended staff subject admitted';
    end if;
end $test$;
reset role;
update admin_private.staff_subjects set status='active';

update admin_private.role_assignments set review_due_at=clock_timestamp()-interval '1 hour';
set role admin_executor;
do $test$ begin
    if admin_private.authorize_action('news.article.publish','staging','article','story-1') then
        raise exception 'overdue staff role admitted';
    end if;
end $test$;
reset role;
update admin_private.role_assignments set review_due_at=clock_timestamp()+interval '30 days';
