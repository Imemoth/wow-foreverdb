-- Development-only rollback. Refuses data, policy activation and later schema work.
begin;
do $guard$
begin
  if to_regnamespace('editorial_private') is null
     or (select version_id from admin_private.active_policy where singleton)<>0
     or exists(select 1 from admin_private.staff_subjects)
     or exists(select 1 from editorial_private.articles)
     or exists(select 1 from editorial_private.media_assets)
     or exists(select 1 from editorial_private.slug_reservations where kind='cms')
     or (select count(*) from editorial_private.slug_reservations)<>6
     or exists(select 1 from editorial_private.publication_intents)
     or (select count(*) from pg_class where relnamespace='editorial_private'::regnamespace and relkind='r')<>11
     or (select count(*) from pg_class where relnamespace='editorial_private'::regnamespace and relkind='i')<>24
     or exists(select 1 from pg_class where relnamespace='editorial_private'::regnamespace and relkind not in ('r','i'))
     or (select count(*) from pg_proc where pronamespace='editorial_private'::regnamespace)<>7
     or (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname like 'fdb_cms_%')<>8
     then raise exception '0025 rollback refused: protected data, policy or schema changed'; end if;
end $guard$;
-- The old helper must be restored before the private schema is removed.
grant create on schema admin_private to admin_executor;
grant admin_executor to current_user;
set role admin_executor;
create or replace function admin_private.editorial_actor(p_permission text,p_article_id text)
returns uuid language plpgsql security definer set search_path = ''
as $actor$
declare c jsonb; uid uuid; sid uuid;
begin
  if p_permission is null or p_permission not in
       ('news.draft.write','news.article.submit',
        'news.article.approve_highlighted','news.article.publish',
        'news.article.unpublish')
     or p_article_id is null
     or p_article_id !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    return null;
  end if;
  -- Evaluator validates verified PostgREST claims, live Auth session, active
  -- policy/version, staff, role/grant and resource scope under row locks.
  if not admin_private.authorize_action('admin.enter','staging','global',null)
     or not admin_private.authorize_action(p_permission,'staging','article',p_article_id) then
    return null;
  end if;
  c := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
  uid := (c->>'sub')::uuid;
  sid := (c->>'session_id')::uuid;
  -- A checked absence cannot be row-locked. Serialize it with the paired
  -- Admin logout RPC using the same session-keyed transaction advisory lock.
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('admin-session:'||sid::text,0));
  if exists(select 1 from admin_private.session_revocations r
       where r.user_id=uid and r.session_id=sid)
     or not admin_private.fresh_totp_session(uid,sid) then
    return null;
  end if;
  -- Re-evaluate after any MFA lock wait, including database-clock expiries.
  if not admin_private.authorize_action(p_permission,'staging','article',p_article_id)
     or not admin_private.fresh_totp_session(uid,sid) then
    return null;
  end if;
  return uid;
exception when invalid_text_representation or invalid_parameter_value then
  return null;
end $actor$;

reset role;
revoke admin_executor from current_user;
revoke create on schema admin_private from admin_executor;
drop function public.fdb_cms_create_draft(uuid,text,jsonb,uuid);
drop function public.fdb_cms_edit_draft(uuid,uuid,jsonb,uuid);
drop function public.fdb_cms_submit_review(uuid,uuid,uuid);
drop function public.fdb_cms_review_decide(uuid,uuid,text,text,uuid);
drop function public.fdb_cms_approve_highlighted(uuid,uuid,uuid);
drop function public.fdb_cms_publish_intent(uuid,uuid,uuid);
drop function public.fdb_cms_unpublish_intent(uuid,uuid);
drop function public.fdb_cms_article(uuid);
drop schema editorial_private cascade;
commit;
