-- ADM-04: read-only Admin CMS RPCs for the real Admin UI.
-- Disposable/staging development only. Never apply to a hosted project under the ADM-04 PR.
--
-- ADM-03B exposes seven protected mutations and ONE single-article read. A usable CMS also needs to
-- list articles, show immutable revision history, review/approval evidence, delivery status and the
-- editorial audit trail. This migration adds exactly those reads, nothing else:
--   * no mutation, no staff/role/grant/policy function, no service_role path;
--   * every function resolves the caller ONLY from the verified PostgREST JWT claims and reuses the
--     reviewed admin_private.editorial_actor gate (live AAL2 session, active policy, staff status,
--     scoped role/grant, session revocation, fresh TOTP, re-check after lock waits);
--   * the audit read uses the same checks for audit.editorial.read at the news collection scope;
--   * delivery status is read from the ADM-03C delivery ledger when it exists and degrades to the
--     ADM-03B 'blocked' intent status when it does not (no hard dependency on 0026 at create time).
-- A denied call raises 42501 and rolls back, exactly like the ADM-03B functions.
begin;

do $preflight$
begin
  if to_regclass('editorial_private.articles') is null
     or to_regprocedure('public.fdb_cms_article(uuid)') is null
     or to_regprocedure('admin_private.editorial_actor(text,text)') is null
     or to_regprocedure('admin_private.authorize_action(text,text,text,text)') is null
     or to_regprocedure('admin_private.fresh_totp_session(uuid,uuid)') is null
     or to_regrole('admin_executor') is null then
    raise exception '0027 pre-flight: the ADM-03B private CMS (0025) is required';
  end if;
  if to_regprocedure('public.fdb_cms_articles(integer)') is not null then
    raise exception '0027 pre-flight: already applied';
  end if;
  if not has_database_privilege(current_user,current_database(),'CREATE')
     or not exists(select 1 from pg_roles where rolname=current_user
                   and rolcreaterole and (rolbypassrls or rolsuper)) then
    raise exception '0027 pre-flight: reviewed migration operator required';
  end if;
end $preflight$;

grant create on schema editorial_private to admin_executor;
grant create on schema public to admin_executor;
grant admin_executor to current_user;
set role admin_executor;

-- Any editorial permission lets a staff member READ an article they are scoped to. The permission
-- list is the reviewed ADM-03B set; unknown permissions are refused by editorial_actor itself.
create function editorial_private.read_actor(p_article uuid)
returns uuid language plpgsql security invoker set search_path = '' as $read_actor$
declare v uuid; p text;
begin
  foreach p in array array['news.article.preview','news.article.review',
    'news.article.approve_highlighted','news.article.publish','news.article.unpublish',
    'news.draft.write','news.article.submit'] loop
    v := admin_private.editorial_actor(p,p_article::text);
    if v is not null then return v; end if;
  end loop;
  return null;
end $read_actor$;

-- Same session/authority checks as admin_private.editorial_actor, for the audit read permission at
-- the news collection scope. Re-checked after the advisory lock exactly like the ADM-03B gate.
create function editorial_private.audit_reader()
returns uuid language plpgsql security invoker set search_path = '' as $audit_reader$
declare c jsonb; uid uuid; sid uuid;
begin
  if not admin_private.authorize_action('admin.enter','staging','global',null)
     or not admin_private.authorize_action('audit.editorial.read','staging','collection','news') then
    return null;
  end if;
  c := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
  uid := (c->>'sub')::uuid; sid := (c->>'session_id')::uuid;
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('admin-session:'||sid::text,0));
  if exists(select 1 from admin_private.session_revocations r
       where r.user_id=uid and r.session_id=sid)
     or not admin_private.fresh_totp_session(uid,sid) then return null; end if;
  if not admin_private.authorize_action('admin.enter','staging','global',null)
     or not admin_private.authorize_action('audit.editorial.read','staging','collection','news')
     or not admin_private.fresh_totp_session(uid,sid) then return null; end if;
  return uid;
exception when invalid_text_representation or invalid_parameter_value then return null;
end $audit_reader$;

-- Delivery status of one intent. ADM-03C adds editorial_private.delivery_state; before it exists
-- (or for an intent it has not recorded) the ADM-03B 'blocked' status is reported.
create function editorial_private.intent_delivery(p_intent uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $delivery$
declare v jsonb;
begin
  if pg_catalog.to_regclass('editorial_private.delivery_state') is not null then
    execute 'select pg_catalog.jsonb_build_object(''state'',s.state,''attempt'',s.attempt,'
      '''compensation'',s.is_compensation,''error_code'',s.last_error_code,'
      '''applied_at'',s.public_applied_at,''updated_at'',s.updated_at) '
      'from editorial_private.delivery_state s where s.intent_id=$1'
      into v using p_intent;
  end if;
  return coalesce(v,pg_catalog.jsonb_build_object('state','blocked','attempt',0,
    'compensation',false,'error_code',null,'applied_at',null,'updated_at',null));
end $delivery$;

-- Context of the signed-in staff member: used by the UI to enable or disable controls. The
-- database still enforces every permission again on each protected call.
create function public.fdb_cms_context()
returns jsonb language plpgsql security definer set search_path = '' as $context$
declare c jsonb; probe uuid:=pg_catalog.gen_random_uuid(); v_create uuid; v_read uuid; v_audit uuid;
begin
  v_create:=admin_private.editorial_actor('news.draft.write',probe::text);
  v_read:=editorial_private.read_actor(probe);
  v_audit:=editorial_private.audit_reader();
  if v_create is null and v_read is null and v_audit is null then
    raise exception 'editorial read denied' using errcode='42501'; end if;
  c := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
  return pg_catalog.jsonb_build_object('user_id',(c->>'sub')::uuid,
    'can_create',v_create is not null,'can_read',v_read is not null,'can_read_audit',v_audit is not null);
end $context$;

create function public.fdb_cms_articles(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $list$
declare v_probe uuid; v_out jsonb:='[]'::jsonb; a record; v_intent record; v_item jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid page size' using errcode='22023'; end if;
  v_probe:=editorial_private.read_actor(pg_catalog.gen_random_uuid());
  for a in
    select ar.*, r.revision_no, r.snapshot, r.created_at as updated_at, r.effective_classification
    from editorial_private.articles ar
    join editorial_private.revisions r on r.revision_id=ar.current_revision_id
    order by r.created_at desc, ar.article_id
    limit 400
  loop
    exit when pg_catalog.jsonb_array_length(v_out)>=p_limit;
    if editorial_private.read_actor(a.article_id) is null then continue; end if;
    select i.intent_id,i.kind,i.generation,i.created_at into v_intent
      from editorial_private.publication_intents i where i.article_id=a.article_id
      order by i.generation desc limit 1;
    v_item:=pg_catalog.jsonb_build_object('article_id',a.article_id,'slug',a.slug,
      'review_state',a.review_state,'classification_floor',a.classification_floor,
      'generation',a.generation,'current_revision_id',a.current_revision_id,
      'published_revision_id',a.published_revision_id,'revision_no',a.revision_no,
      'title',a.snapshot->>'title','summary',a.snapshot->>'summary',
      'category',a.snapshot->>'category','classification',a.snapshot->>'classification',
      'featured',coalesce((a.snapshot->>'featured')::boolean,false),
      'updated_at',a.updated_at,'created_by',a.created_by,'created_at',a.created_at,
      'latest_intent',case when v_intent.intent_id is null then null
        else pg_catalog.jsonb_build_object('intent_id',v_intent.intent_id,'kind',v_intent.kind,
          'generation',v_intent.generation,'created_at',v_intent.created_at,
          'delivery',editorial_private.intent_delivery(v_intent.intent_id)) end);
    v_out:=v_out||pg_catalog.jsonb_build_array(v_item);
  end loop;
  if pg_catalog.jsonb_array_length(v_out)=0 and v_probe is null then
    raise exception 'editorial read denied' using errcode='42501'; end if;
  return v_out;
end $list$;

create function public.fdb_cms_article_detail(p_article uuid)
returns jsonb language plpgsql security definer set search_path = '' as $detail$
declare a editorial_private.articles%rowtype; r editorial_private.revisions%rowtype;
  v_revisions jsonb; v_reviews jsonb; v_approvals jsonb; v_intents jsonb; v_permitted jsonb;
begin
  if p_article is null then raise exception 'editorial read denied' using errcode='42501'; end if;
  if editorial_private.read_actor(p_article) is null then
    raise exception 'editorial read denied' using errcode='42501'; end if;
  select * into a from editorial_private.articles where article_id=p_article for share;
  if not found then raise exception 'editorial read denied' using errcode='42501'; end if;
  select * into r from editorial_private.revisions where revision_id=a.current_revision_id;
  if not found or r.article_id<>p_article then
    raise exception 'editorial revision missing' using errcode='42501'; end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'revision_id',x.revision_id,'revision_no',x.revision_no,'parent_revision_id',x.parent_revision_id,
      'snapshot_hash',pg_catalog.encode(x.snapshot_hash,'hex'),
      'effective_classification',x.effective_classification,'created_by',x.created_by,
      'created_at',x.created_at,'title',x.snapshot->>'title',
      'contributors',(select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'actor_id',c.actor_id,'contribution',c.contribution) order by c.actor_id),'[]'::jsonb)
        from editorial_private.revision_contributors c where c.revision_id=x.revision_id))
    order by x.revision_no desc),'[]'::jsonb) into v_revisions
    from editorial_private.revisions x where x.article_id=p_article;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'event_id',e.event_id,'revision_id',e.revision_id,'decision',e.decision,
      'actor_id',e.actor_id,'note',e.note,'occurred_at',e.occurred_at,
      'revision_hash',pg_catalog.encode(e.revision_hash,'hex')) order by e.occurred_at desc,e.event_id),'[]'::jsonb)
    into v_reviews from editorial_private.review_events e where e.article_id=p_article;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'approval_id',p.approval_id,'revision_id',p.revision_id,'approver_id',p.approver_id,
      'approved_at',p.approved_at,'grant_bound',p.grant_id is not null,
      'consumed',exists(select 1 from editorial_private.approval_uses u where u.approval_id=p.approval_id))
    order by p.approved_at desc),'[]'::jsonb)
    into v_approvals from editorial_private.approvals p where p.article_id=p_article;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'intent_id',i.intent_id,'kind',i.kind,'generation',i.generation,'revision_id',i.revision_id,
      'requested_by',i.requested_by,'created_at',i.created_at,
      'delivery',editorial_private.intent_delivery(i.intent_id)) order by i.generation desc),'[]'::jsonb)
    into v_intents from editorial_private.publication_intents i where i.article_id=p_article;
  v_permitted:=pg_catalog.jsonb_build_object(
    'edit',admin_private.editorial_actor('news.draft.write',p_article::text) is not null,
    'submit',admin_private.editorial_actor('news.article.submit',p_article::text) is not null,
    'review',admin_private.editorial_actor('news.article.review',p_article::text) is not null,
    'approve',admin_private.editorial_actor('news.article.approve_highlighted',p_article::text) is not null,
    'publish',admin_private.editorial_actor('news.article.publish',p_article::text) is not null,
    'unpublish',admin_private.editorial_actor('news.article.unpublish',p_article::text) is not null);
  return pg_catalog.jsonb_build_object(
    'article',pg_catalog.jsonb_build_object('article_id',a.article_id,'slug',a.slug,'origin',a.origin,
      'review_state',a.review_state,'classification_floor',a.classification_floor,
      'generation',a.generation,'current_revision_id',r.revision_id,
      'published_revision_id',a.published_revision_id,'revision_no',r.revision_no,
      'snapshot_hash',pg_catalog.encode(r.snapshot_hash,'hex'),'snapshot',r.snapshot,
      'created_by',a.created_by,'created_at',a.created_at),
    'permitted',v_permitted,'revisions',v_revisions,'reviews',v_reviews,
    'approvals',v_approvals,'intents',v_intents);
end $detail$;

create function public.fdb_cms_revision(p_article uuid,p_revision uuid)
returns jsonb language plpgsql security definer set search_path = '' as $revision$
declare r editorial_private.revisions%rowtype;
begin
  if p_article is null or p_revision is null
     or editorial_private.read_actor(p_article) is null then
    raise exception 'editorial read denied' using errcode='42501'; end if;
  select * into r from editorial_private.revisions
    where article_id=p_article and revision_id=p_revision;
  if not found then raise exception 'editorial read denied' using errcode='42501'; end if;
  return pg_catalog.jsonb_build_object('revision_id',r.revision_id,'article_id',r.article_id,
    'revision_no',r.revision_no,'parent_revision_id',r.parent_revision_id,
    'snapshot_hash',pg_catalog.encode(r.snapshot_hash,'hex'),'snapshot',r.snapshot,
    'effective_classification',r.effective_classification,'created_by',r.created_by,
    'created_at',r.created_at);
end $revision$;

-- Editorial audit events (action keys 'news.%'). Metadata only: the audit ledger never stores draft
-- bodies. Requires audit.editorial.read; paging is by descending event number.
create function public.fdb_cms_audit(p_limit integer default 50,p_before bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $audit$
declare v_out jsonb;
begin
  if p_limit is null or p_limit not between 1 and 100
     or (p_before is not null and p_before<1) then
    raise exception 'invalid page' using errcode='22023'; end if;
  if editorial_private.audit_reader() is null then
    raise exception 'editorial audit read denied' using errcode='42501'; end if;
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'event_no',x.event_no,'occurred_at',x.occurred_at,'actor_id',x.actor_id,
      'action_key',x.action_key,'resource_key',x.resource_key,'outcome',x.outcome,
      'decision',x.decision,'request_id',x.request_id,'reason',x.reason,
      'detail',x.after_state) order by x.event_no desc),'[]'::jsonb) into v_out
    from (select e.* from admin_private.staff_audit_events e
      where e.action_key like 'news.%' and (p_before is null or e.event_no<p_before)
      order by e.event_no desc limit p_limit) x;
  return v_out;
end $audit$;

reset role;

revoke all on function editorial_private.read_actor(uuid),editorial_private.audit_reader(),
  editorial_private.intent_delivery(uuid)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function editorial_private.read_actor(uuid),editorial_private.audit_reader(),
  editorial_private.intent_delivery(uuid) to admin_executor;
revoke all on function public.fdb_cms_context(),public.fdb_cms_articles(integer),
  public.fdb_cms_article_detail(uuid),public.fdb_cms_revision(uuid,uuid),
  public.fdb_cms_audit(integer,bigint)
  from public,anon,service_role,authenticator;
grant execute on function public.fdb_cms_context(),public.fdb_cms_articles(integer),
  public.fdb_cms_article_detail(uuid),public.fdb_cms_revision(uuid,uuid),
  public.fdb_cms_audit(integer,bigint) to authenticated;

revoke admin_executor from current_user;
revoke create on schema editorial_private from admin_executor;
revoke create on schema public from admin_executor;

notify pgrst, 'reload schema';
commit;
