-- ADM-03B/03C backend hotfix: forward repair of two confirmed defects found by running the Admin CMS against the real pinned PostgREST and the
-- merged delivery worker. Migrations 0025 and 0026 are already merged and are NOT edited: this additive migration replaces exactly two functions
-- with `create or replace`, so owner, ACL, SECURITY attribute and search_path are preserved and nothing else changes.
--
-- 1. editorial_private.run_action (ADM-03B). A stale or uneditable revision raised SQLSTATE 40001. The pinned PostgREST (v12.2.12) treats 40001
--    as a transient serialization failure and RETRIES the call; the stale condition is deterministic, so the request never completes and holds a
--    pooled database connection until the client gives up. It now raises PT409: PostgREST's documented way to answer HTTP 409 immediately with
--    {"code":"PT409",...}. The check is unchanged and still runs under the article row lock, so the transaction still rolls back and optimistic
--    concurrency (exactly one of two edits from the same base revision commits) is preserved.
-- 2. editorial_private.delivery_eligible (ADM-03C). The PL/pgSQL record variable `ap` and the table alias `ap` collided, so every HIGHLIGHTED
--    publication failed with `column reference "ap.approval_id" is ambiguous` before it could be claimed. The table alias is renamed `appr`; the
--    approval lookup (intent-bound, same article, same revision, same policy) and the independence / eligible_approver checks are byte-identical.
--    The 0026 function is replaced only when the ADM-03C ledger is installed (a 0025-only database has no such function).
--
-- Numbering: 0027 is reserved by the Admin UI read RPCs (PR #208). This migration touches neither of that PR's objects and 0027 does not depend on
-- the functions replaced here, so the two apply in either order.
begin;

do $preflight$
begin
  if to_regprocedure('editorial_private.run_action(text,uuid,uuid,jsonb,text,text,uuid)') is null
     or to_regrole('admin_executor') is null then
    raise exception '0028 pre-flight: the ADM-03B private CMS (0025) is required';
  end if;
  if pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('editorial_private.run_action(text,uuid,uuid,jsonb,text,text,uuid)'))
       not like '%errcode=''40001''%' then
    raise exception '0028 pre-flight: already applied or an unexpected run_action definition';
  end if;
  -- Nested on purpose: a 0025-only database has no delivery_eligible, and SQL does not guarantee left-to-right evaluation of one boolean expression.
  if pg_catalog.to_regprocedure('editorial_private.delivery_eligible(uuid)') is not null then
    if pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure('editorial_private.delivery_eligible(uuid)'))
         not like '%select ap.* into ap from%' then
      raise exception '0028 pre-flight: unexpected delivery_eligible definition';
    end if;
  end if;
  if not has_database_privilege(current_user,current_database(),'CREATE')
     or not exists(select 1 from pg_roles where rolname=current_user
                   and rolcreaterole and (rolbypassrls or rolsuper)) then
    raise exception '0028 pre-flight: reviewed migration operator required';
  end if;
end $preflight$;

grant create on schema editorial_private to admin_executor;
grant admin_executor to current_user;
set role admin_executor;

create or replace function editorial_private.run_action(
  p_action text,p_article uuid,p_revision uuid,p_snapshot jsonb,
  p_slug text,p_note text,p_request uuid
) returns uuid language plpgsql security invoker set search_path = '' as $action$
declare a editorial_private.articles%rowtype; r editorial_private.revisions%rowtype;
  v_actor uuid; v_snapshot jsonb; v_original_snapshot jsonb; v_hash bytea; v_new uuid;
  v_before jsonb; v_after jsonb; v_audit bigint; v_policy bigint;
  v_approval editorial_private.approvals%rowtype; v_prior editorial_private.publication_intents%rowtype;
  v_class integer; v_kind text; v_payload jsonb; v_approval_grant uuid;
  v_action_grant uuid;
begin
  if p_request is null or p_article is null or p_action not in
    ('create','edit','submit','return','reject','approve','publish','unpublish') then
    raise exception 'invalid editorial request' using errcode='22023';
  end if;
  if p_action='create' then
    if p_revision is not null or p_slug is null or
       p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(p_slug) not between 3 and 80
       or pg_catalog.md5(p_slug)='f39fb24d02e53f0539810a117ab69877' then
      raise exception 'invalid article slug' using errcode='22023'; end if;
    -- Retry remains authenticated and cannot disclose another author's row.
    select * into a from editorial_private.articles where create_request_id=p_request;
    if found then
      v_actor:=editorial_private.require_actor('news.draft.write',a.article_id);
      v_snapshot:=editorial_private.canonical_snapshot(p_snapshot);
      select snapshot into v_original_snapshot from editorial_private.revisions
        where article_id=a.article_id and revision_no=1;
      if a.article_id=p_article and a.slug=p_slug and a.created_by=v_actor
         and v_snapshot=v_original_snapshot
         then return a.article_id; end if;
      raise exception 'request id reused' using errcode='23505';
    end if;
    v_actor:=editorial_private.require_actor('news.draft.write',p_article);
    v_snapshot:=editorial_private.canonical_snapshot(p_snapshot);
    v_class:=case when v_snapshot->>'classification'='highlighted'
      or (v_snapshot->>'featured')::boolean then 1 else 0 end;
    if v_class=1 and v_snapshot->>'classification'<>'highlighted' then
      raise exception 'featured content must be highlighted' using errcode='22023'; end if;
    perform editorial_private.lock_audit_and_recheck('news.draft.write',p_article,v_actor,null,null);
    v_new:=pg_catalog.gen_random_uuid();
    v_hash:=pg_catalog.sha256(pg_catalog.convert_to(v_snapshot::text,'UTF8'));
    insert into editorial_private.articles(article_id,slug,origin,current_revision_id,
      review_state,classification_floor,created_by,create_request_id)
      values(p_article,p_slug,'manual',v_new,'draft',v_class,v_actor,p_request);
    insert into editorial_private.slug_reservations(slug,kind,article_id)
      values(p_slug,'cms',p_article);
    insert into editorial_private.revisions(revision_id,article_id,revision_no,
      snapshot_schema_version,snapshot,snapshot_hash,effective_classification,created_by)
      values(v_new,p_article,1,1,v_snapshot,v_hash,v_class,v_actor);
    insert into editorial_private.revision_contributors(article_id,revision_id,actor_id,contribution)
      values(p_article,v_new,v_actor,'author');
    perform admin_private.append_editorial_audit('news.draft.write',p_article::text,v_actor,
      p_request,'{}'::jsonb,pg_catalog.jsonb_build_object('event','create','revision',v_new,
        'hash',pg_catalog.encode(v_hash,'hex')));
    return p_article;
  end if;

  -- The existing evaluator takes policy/Auth/staff locks first. All CMS
  -- actions follow those locks with the article lock, then recheck after wait.
  v_kind:=case p_action when 'edit' then 'news.draft.write'
    when 'submit' then 'news.article.submit'
    when 'return' then 'news.article.review'
    when 'reject' then 'news.article.review'
    when 'approve' then 'news.article.approve_highlighted'
    when 'publish' then 'news.article.publish'
    when 'unpublish' then 'news.article.unpublish' end;
  v_actor:=editorial_private.require_actor(v_kind,p_article);
  select * into a from editorial_private.articles where article_id=p_article for update;
  if not found then raise exception 'article unavailable' using errcode='42501'; end if;
  if editorial_private.require_actor(v_kind,p_article) is distinct from v_actor then
    raise exception 'editorial authority changed' using errcode='42501'; end if;
  select * into r from editorial_private.revisions where revision_id=a.current_revision_id;
  if not found or r.article_id<>p_article then
    raise exception 'article revision unavailable' using errcode='42501'; end if;
  v_before:=pg_catalog.jsonb_build_object('state',a.review_state,
    'revision',a.current_revision_id,'generation',a.generation);

  if p_action='edit' then
    if p_revision is distinct from r.revision_id or a.review_state not in
      ('draft','in_review','approved','rejected') then
      raise exception 'stale or uneditable revision' using errcode='PT409'; end if;
    v_snapshot:=editorial_private.canonical_snapshot(p_snapshot);
    v_class:=case when v_snapshot->>'classification'='highlighted'
      or (v_snapshot->>'featured')::boolean then 1 else 0 end;
    if v_class<a.classification_floor or
       (v_class=1 and v_snapshot->>'classification'<>'highlighted') then
      raise exception 'classification downgrade forbidden' using errcode='42501'; end if;
    perform editorial_private.lock_audit_and_recheck(v_kind,p_article,v_actor,null,null);
    v_new:=pg_catalog.gen_random_uuid();
    v_hash:=pg_catalog.sha256(pg_catalog.convert_to(v_snapshot::text,'UTF8'));
    insert into editorial_private.revisions(revision_id,article_id,revision_no,parent_revision_id,
      snapshot_schema_version,snapshot,snapshot_hash,effective_classification,created_by)
      values(v_new,p_article,r.revision_no+1,r.revision_id,1,v_snapshot,v_hash,
        greatest(v_class,a.classification_floor),v_actor);
    insert into editorial_private.revision_contributors(article_id,revision_id,actor_id,contribution)
      select p_article,v_new,actor_id,contribution from editorial_private.revision_contributors
      where revision_id=r.revision_id on conflict do nothing;
    insert into editorial_private.revision_contributors(article_id,revision_id,actor_id,contribution)
      values(p_article,v_new,v_actor,'substantive_editor') on conflict do nothing;
    update editorial_private.articles set current_revision_id=v_new,review_state='draft',
      classification_floor=greatest(classification_floor,v_class) where article_id=p_article;
    v_after:=pg_catalog.jsonb_build_object('event','edit','revision',v_new,
      'hash',pg_catalog.encode(v_hash,'hex'));
  elsif p_action='submit' then
    if p_revision is distinct from r.revision_id or a.review_state not in ('draft','rejected') then
      raise exception 'stale or unsubmitted revision' using errcode='PT409'; end if;
    perform editorial_private.lock_audit_and_recheck(v_kind,p_article,v_actor,null,null);
    insert into editorial_private.review_events(article_id,revision_id,revision_hash,actor_id,decision)
      values(p_article,r.revision_id,r.snapshot_hash,v_actor,'submit') returning event_id into v_new;
    update editorial_private.articles set review_state='in_review' where article_id=p_article;
    v_after:=pg_catalog.jsonb_build_object('event','submit','revision',r.revision_id);
  elsif p_action in ('return','reject') then
    if p_revision is distinct from r.revision_id or a.review_state<>'in_review'
       or p_note is null or length(btrim(p_note)) not between 5 and 2000 then
      raise exception 'invalid review decision' using errcode='22023'; end if;
    perform editorial_private.lock_audit_and_recheck(v_kind,p_article,v_actor,null,null);
    insert into editorial_private.review_events(article_id,revision_id,revision_hash,
      actor_id,decision,note) values(p_article,r.revision_id,r.snapshot_hash,v_actor,
      p_action,p_note) returning event_id into v_new;
    update editorial_private.articles set review_state=case when p_action='return'
      then 'draft' else 'rejected' end where article_id=p_article;
    v_after:=pg_catalog.jsonb_build_object('event',p_action,'revision',r.revision_id,
      'review_event',v_new,'reason_hash',pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(p_note,'UTF8')),'hex'));
  elsif p_action='approve' then
    if p_revision is distinct from r.revision_id or a.review_state<>'in_review'
       or r.effective_classification<>1 or exists(
         select 1 from editorial_private.revision_contributors
         where revision_id=r.revision_id and actor_id=v_actor) then
      raise exception 'independent highlighted approval required' using errcode='42501'; end if;
    select version_id into v_policy from admin_private.active_policy where singleton for share;
    if not editorial_private.eligible_approver(v_actor,p_article,v_policy,null) then
      select g.grant_id into v_approval_grant from admin_private.direct_grants g
        where g.user_id=v_actor and g.policy_version_id=v_policy
          and g.environment_scope='staging' and g.status='active'
          and g.permission_key='news.article.approve_highlighted'
          and g.starts_at<=pg_catalog.clock_timestamp() and g.expires_at>pg_catalog.clock_timestamp()
          and ((g.scope_kind='article' and g.scope_id=p_article::text)
            or (g.scope_kind='collection' and g.scope_id=a.collection_key))
        order by g.grant_id limit 1 for share of g;
      if v_approval_grant is null or not editorial_private.eligible_approver(
           v_actor,p_article,v_policy,v_approval_grant) then
        raise exception 'approver no longer eligible' using errcode='42501'; end if;
    end if;
    perform editorial_private.lock_audit_and_recheck(v_kind,p_article,v_actor,v_actor,v_policy,v_approval_grant);
    insert into editorial_private.approvals(article_id,revision_id,revision_hash,
      approver_id,grant_id,policy_version_id) values(p_article,r.revision_id,r.snapshot_hash,
      v_actor,v_approval_grant,v_policy) returning approval_id into v_new;
    insert into editorial_private.review_events(article_id,revision_id,revision_hash,
      actor_id,decision) values(p_article,r.revision_id,r.snapshot_hash,
      v_actor,'approve_highlighted');
    update editorial_private.articles set review_state='approved' where article_id=p_article;
    v_after:=pg_catalog.jsonb_build_object('event','approve_highlighted',
      'revision',r.revision_id,'approval',v_new,'approval_grant',v_approval_grant);
  elsif p_action in ('publish','unpublish') then
    select * into v_prior from editorial_private.publication_intents where request_id=p_request;
    if found then
      if v_prior.article_id=p_article and v_prior.kind=p_action and
         (p_action='unpublish' or v_prior.revision_id=p_revision) and
         v_prior.requested_by=v_actor then return v_prior.intent_id; end if;
      raise exception 'request id reused' using errcode='23505'; end if;
    select version_id into v_policy from admin_private.active_policy where singleton for share;
    if p_action='publish' then
      if p_revision is distinct from r.revision_id or
         (r.effective_classification=0 and a.review_state<>'in_review') or
         (r.effective_classification=1 and a.review_state<>'approved') or
         a.classification_floor>r.effective_classification then
        raise exception 'revision not publishable' using errcode='42501'; end if;
      if r.effective_classification=1 then
        select * into v_approval from editorial_private.approvals ap
          where ap.article_id=p_article and ap.revision_id=r.revision_id
            and ap.revision_hash=r.snapshot_hash and ap.policy_version_id=v_policy
            and not exists(select 1 from editorial_private.approval_uses u
                           where u.approval_id=ap.approval_id)
          order by ap.approved_at,ap.approval_id limit 1;
        if not found or v_approval.approver_id=v_actor
           or exists(select 1 from editorial_private.revision_contributors
                     where revision_id=r.revision_id and actor_id=v_approval.approver_id)
           or not editorial_private.eligible_approver(v_approval.approver_id,p_article,v_policy,v_approval.grant_id)
           then raise exception 'independent current approval required' using errcode='42501'; end if;
      end if;
      v_payload:=pg_catalog.jsonb_build_object('kind','publish','article_id',p_article,
        'slug',a.slug,'revision_id',r.revision_id,'revision_hash',
        pg_catalog.encode(r.snapshot_hash,'hex'),'generation',a.generation+1);
      perform editorial_private.lock_audit_and_recheck(v_kind,p_article,v_actor,
        case when r.effective_classification=1 then v_approval.approver_id end,
        v_policy,case when r.effective_classification=1 then v_approval.grant_id end);
      update editorial_private.articles set review_state='publish_pending',
        generation=generation+1 where article_id=p_article;
    else
      if a.review_state<>'publish_pending' and a.published_revision_id is null then
        raise exception 'nothing to unpublish' using errcode='42501'; end if;
      v_payload:=pg_catalog.jsonb_build_object('kind','unpublish','article_id',p_article,
        'slug',a.slug,'generation',a.generation+1);
      perform editorial_private.lock_audit_and_recheck(v_kind,p_article,v_actor,null,null);
      update editorial_private.articles set review_state='unpublish_pending',
        generation=generation+1 where article_id=p_article;
    end if;
    -- The evaluator already locked relevant grants before the audit-head wait.
    -- Read the still-live applicable grant without taking a new post-audit lock.
    select g.grant_id into v_action_grant from admin_private.direct_grants g
      where g.user_id=v_actor and g.policy_version_id=v_policy
        and g.environment_scope='staging' and g.status='active'
        and g.permission_key=v_kind
        and g.starts_at<=pg_catalog.clock_timestamp() and g.expires_at>pg_catalog.clock_timestamp()
        and ((g.scope_kind='article' and g.scope_id=p_article::text)
          or (g.scope_kind='collection' and g.scope_id=a.collection_key))
      order by g.grant_id limit 1;
    v_hash:=pg_catalog.sha256(pg_catalog.convert_to(v_payload::text,'UTF8'));
    v_new:=pg_catalog.gen_random_uuid();
    v_after:=pg_catalog.jsonb_build_object('event',p_action||'_intent',
      'revision',case when p_action='publish' then r.revision_id end,
      'revision_hash',case when p_action='publish' then pg_catalog.encode(r.snapshot_hash,'hex') end,
      'payload_hash',pg_catalog.encode(v_hash,'hex'),
      'intent',v_new,'generation',a.generation+1,
      'approval',case when p_action='publish' and r.effective_classification=1 then v_approval.approval_id end,
      'approval_grant',case when p_action='publish' and r.effective_classification=1 then v_approval.grant_id end,
      'action_grant',v_action_grant);
    v_audit:=admin_private.append_editorial_audit(v_kind,p_article::text,v_actor,
      p_request,v_before,v_after);
    insert into editorial_private.publication_intents(intent_id,article_id,revision_id,
      generation,kind,requested_by,request_id,audit_event_no,payload_hash)
      values(v_new,p_article,case when p_action='publish' then r.revision_id end,
        a.generation+1,p_action,v_actor,p_request,v_audit,v_hash);
    if p_action='publish' and r.effective_classification=1 then
      insert into editorial_private.approval_uses(approval_id,intent_id)
        values(v_approval.approval_id,v_new);
    end if;
    insert into editorial_private.delivery_outbox(intent_id,article_id,generation,payload,payload_hash)
      values(v_new,p_article,a.generation+1,v_payload,v_hash);
    if p_action='publish' and r.effective_classification=1
       and not editorial_private.eligible_approver(v_approval.approver_id,p_article,v_policy,v_approval.grant_id) then
      raise exception 'approver eligibility expired during publication' using errcode='42501'; end if;
    return v_new;
  end if;
  perform admin_private.append_editorial_audit(v_kind,p_article::text,v_actor,
    p_request,v_before,v_after);
  return v_new;
end $action$;

do $repair_eligibility$
begin
  if to_regprocedure('editorial_private.delivery_eligible(uuid)') is not null then
    execute $fn$
create or replace function editorial_private.delivery_eligible(p_intent uuid)
returns boolean language plpgsql security definer set search_path = '' as $eligible$
declare i editorial_private.publication_intents%rowtype;
  a editorial_private.articles%rowtype; ev admin_private.staff_audit_events%rowtype;
  pol bigint; at_time timestamptz; permission text; role_ok boolean:=false;
  default_ok boolean:=false; grant_ok boolean:=false; enter_ok boolean:=false;
  has_editor boolean:=false; has_administrator boolean:=false; has_owner boolean:=false;
  required_grant uuid; role_deadline timestamptz; grant_deadline timestamptz;
  r record; g record; ap editorial_private.approvals%rowtype;
  is_system boolean;
begin
  select * into i from editorial_private.publication_intents where intent_id=p_intent;
  if not found then return false; end if;
  select * into a from editorial_private.articles where article_id=i.article_id;
  if not found or a.generation<>i.generation then return false; end if;
  select is_compensation into is_system from editorial_private.delivery_state
    where intent_id=p_intent;
  if coalesce(is_system,false) then return i.kind='unpublish'; end if;
  select enabled into role_ok from editorial_private.delivery_control where singleton;
  if not coalesce(role_ok,false) then return false; end if;
  select version_id into pol from admin_private.active_policy where singleton for share;
  if pol=0 or not exists(select 1 from admin_private.policy_versions
       where version_id=pol and approval_state='approved' and activated_at is not null)
     then return false; end if;
  select * into ev from admin_private.staff_audit_events where event_no=i.audit_event_no;
  if not found or ev.actor_id is distinct from i.requested_by
     or ev.request_id is distinct from i.request_id
     or ev.policy_version_id<>pol
     or ev.resource_key is distinct from 'article:'||i.article_id::text
     or ev.action_key is distinct from (case i.kind when 'publish' then 'news.article.publish'
       else 'news.article.unpublish' end)
     or ev.session_id is null then return false; end if;
  permission:=ev.action_key;
  if ev.after_state ? 'action_grant' and ev.after_state->>'action_grant' is not null then
    required_grant:=(ev.after_state->>'action_grant')::uuid;
  end if;
  perform 1 from admin_private.staff_subjects
    where user_id=i.requested_by and status='active' for share;
  if not found then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('admin-session:'||ev.session_id::text,0));
  if exists(select 1 from admin_private.session_revocations
       where user_id=i.requested_by and session_id=ev.session_id)
     or not admin_private.live_auth_session(i.requested_by,ev.session_id)
     or not admin_private.fresh_totp_session(i.requested_by,ev.session_id)
     then return false; end if;
  at_time:=pg_catalog.clock_timestamp();
  for r in select role_name,scope_kind,scope_id,expires_at,review_due_at
    from admin_private.role_assignments
    where user_id=i.requested_by and policy_version_id=pol
      and environment_scope='staging' and status='active'
      and starts_at<=at_time and (expires_at is null or expires_at>at_time)
      and review_due_at>at_time
      and (scope_kind='global' or (scope_kind='article' and scope_id=i.article_id::text)
        or (scope_kind='collection' and scope_id=a.collection_key))
    order by assignment_id for share loop
    if r.expires_at is not null and (role_deadline is null or r.expires_at<role_deadline)
      then role_deadline:=r.expires_at; end if;
    if r.review_due_at is not null and (role_deadline is null or r.review_due_at<role_deadline)
      then role_deadline:=r.review_due_at; end if;
    if r.role_name='Editor' then has_editor:=true; end if;
    if r.role_name='Administrator' then has_administrator:=true; end if;
    if r.role_name='Owner' then has_owner:=true; end if;
    if r.scope_kind='global' and exists(select 1 from admin_private.role_permissions
        where version_id=pol and role_name=r.role_name and permission_key='admin.enter')
      then enter_ok:=true; end if;
    if r.role_name in ('Owner','Administrator','Editor') then role_ok:=true; end if;
    if exists(select 1 from admin_private.role_permissions
        where version_id=pol and role_name=r.role_name and permission_key=permission)
       then default_ok:=true; end if;
  end loop;
  if not enter_ok or not role_ok then return false; end if;
  for g in select grant_id,expires_at from admin_private.direct_grants
    where user_id=i.requested_by and policy_version_id=pol
      and environment_scope='staging' and status='active'
      and permission_key=permission and starts_at<=at_time and expires_at>at_time
      and (required_grant is null or grant_id=required_grant)
      and ((scope_kind='article' and scope_id=i.article_id::text)
        or (scope_kind='collection' and scope_id=a.collection_key))
    order by grant_id for share loop
    grant_ok:=true; grant_deadline:=g.expires_at;
  end loop;
  at_time:=pg_catalog.clock_timestamp();
  if (role_deadline is not null and role_deadline<=at_time)
     or (grant_deadline is not null and grant_deadline<=at_time)
     or (required_grant is not null and not grant_ok)
     or not (default_ok or grant_ok)
     or (permission='news.article.publish' and not
       (has_owner or (has_editor and grant_ok) or (has_administrator and grant_ok)))
     or (permission='news.article.unpublish' and not
       (has_owner or has_administrator or (has_editor and grant_ok)))
     or not admin_private.live_auth_session(i.requested_by,ev.session_id)
     or not admin_private.fresh_totp_session(i.requested_by,ev.session_id)
     or exists(select 1 from admin_private.session_revocations
       where user_id=i.requested_by and session_id=ev.session_id)
     or (select version_id from admin_private.active_policy where singleton)<>pol
     or not exists(select 1 from admin_private.staff_subjects
       where user_id=i.requested_by and status='active') then return false; end if;
  if i.kind='publish' then
    if a.current_revision_id<>i.revision_id or a.classification_floor>
       (select effective_classification from editorial_private.revisions
         where revision_id=i.revision_id) then return false; end if;
    if exists(select 1 from editorial_private.revisions
         where revision_id=i.revision_id and effective_classification=1) then
      select appr.* into ap from editorial_private.approvals appr
        join editorial_private.approval_uses u on u.approval_id=appr.approval_id
        where u.intent_id=i.intent_id and appr.article_id=i.article_id
          and appr.revision_id=i.revision_id and appr.policy_version_id=pol;
      if not found or ap.approver_id=i.requested_by or not
         editorial_private.eligible_approver(ap.approver_id,i.article_id,pol,ap.grant_id)
         then return false; end if;
    end if;
  end if;
  return true;
end $eligible$;
$fn$;
  end if;
end $repair_eligibility$;

reset role;
revoke admin_executor from current_user;
revoke create on schema editorial_private from admin_executor;
commit;
