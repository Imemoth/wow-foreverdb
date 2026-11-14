-- ADM-03B: private, inactive article/revision source of truth.
-- Never apply to a hosted project under this PR. Public delivery and policy
-- activation are separate gates. All application fixtures belong to disposable DBs.
begin;

do $preflight$
begin
  if to_regnamespace('editorial_private') is not null
     or to_regprocedure('admin_private.editorial_actor(text,text)') is null
     or to_regprocedure('admin_private.append_editorial_audit(text,text,uuid,uuid,jsonb,jsonb)') is null
     or to_regrole('admin_executor') is null
     or (select version_id from admin_private.active_policy where singleton) <> 0
     or exists(select 1 from admin_private.staff_subjects) then
    raise exception '0025 pre-flight: inactive 0024 foundation and empty staff required';
  end if;
  if not has_database_privilege(current_user,current_database(),'CREATE')
     or not exists(select 1 from pg_roles where rolname=current_user
                   and rolcreaterole and (rolbypassrls or rolsuper)) then
    raise exception '0025 pre-flight: reviewed migration operator required';
  end if;
end $preflight$;

create schema editorial_private;
revoke all on schema editorial_private from public,anon,authenticated,service_role,authenticator;
grant usage on schema editorial_private to admin_executor;
alter default privileges in schema editorial_private
  revoke all on tables from public,anon,authenticated,service_role,authenticator;
alter default privileges in schema editorial_private
  revoke all on functions from public,anon,authenticated,service_role,authenticator;

-- Only verified, immutable asset versions can enter a revision snapshot.
-- This slice exposes no asset registration or upload endpoint.
create table editorial_private.media_assets (
  asset_id uuid primary key default pg_catalog.gen_random_uuid(),
  asset_version integer not null check (asset_version > 0),
  path text not null check (path ~ '^/content-images/[a-z0-9/_-]+\.(svg|png|jpg|webp)$'),
  content_sha256 bytea not null check (pg_catalog.octet_length(content_sha256)=32),
  rights_source text not null check (pg_catalog.length(pg_catalog.btrim(rights_source)) between 3 and 500),
  rights_license text not null check (pg_catalog.length(pg_catalog.btrim(rights_license)) between 3 and 200),
  attribution text not null check (pg_catalog.length(pg_catalog.btrim(attribution)) between 3 and 200),
  verified_by uuid not null,
  verified_at timestamptz not null,
  unique (path,asset_version)
);

create table editorial_private.articles (
  article_id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and pg_catalog.length(slug) between 3 and 80),
  collection_key text not null default 'news' check (collection_key='news'),
  origin text not null check (origin in ('manual','legacy_git')),
  current_revision_id uuid not null,
  published_revision_id uuid,
  review_state text not null check (review_state in ('draft','in_review','approved','rejected','publish_pending','unpublish_pending')),
  classification_floor integer not null check (classification_floor in (0,1)),
  generation bigint not null default 0 check (generation>=0),
  created_by uuid not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  create_request_id uuid not null unique
);

create table editorial_private.slug_reservations (
  slug text primary key,
  kind text not null check (kind in ('route','legacy_git','cms')),
  article_id uuid unique references editorial_private.articles(article_id) on delete restrict,
  check ((kind='cms')=(article_id is not null))
);
insert into editorial_private.slug_reservations(slug,kind) values
  ('entry','route'),('rss','route'),('api','route'),
  ('jokerd-team-world-first-level-60-wow-forever','legacy_git'),
  ('zone-browsing-and-api-hardening','legacy_git'),
  ('introducing-foreverdb-web','legacy_git');

create table editorial_private.revisions (
  revision_id uuid primary key,
  article_id uuid not null references editorial_private.articles(article_id) on delete restrict,
  revision_no integer not null check (revision_no>0),
  parent_revision_id uuid,
  snapshot_schema_version integer not null check (snapshot_schema_version=1),
  snapshot jsonb not null check (pg_catalog.jsonb_typeof(snapshot)='object'),
  snapshot_hash bytea not null check (pg_catalog.octet_length(snapshot_hash)=32),
  effective_classification integer not null check (effective_classification in (0,1)),
  created_by uuid not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique(article_id,revision_id),
  unique(article_id,revision_no),
  foreign key(article_id,parent_revision_id)
    references editorial_private.revisions(article_id,revision_id) on delete restrict
);
alter table editorial_private.articles add constraint article_current_revision_same_article
  foreign key(article_id,current_revision_id)
  references editorial_private.revisions(article_id,revision_id)
  on delete restrict deferrable initially deferred;
alter table editorial_private.articles add constraint article_published_revision_same_article
  foreign key(article_id,published_revision_id)
  references editorial_private.revisions(article_id,revision_id) on delete restrict;

create table editorial_private.revision_contributors (
  article_id uuid not null,
  revision_id uuid not null,
  actor_id uuid not null,
  contribution text not null check (contribution in ('author','substantive_editor')),
  primary key(article_id,revision_id,actor_id),
  foreign key(article_id,revision_id)
    references editorial_private.revisions(article_id,revision_id) on delete restrict
);
create table editorial_private.review_events (
  event_id uuid primary key default pg_catalog.gen_random_uuid(),
  article_id uuid not null,
  revision_id uuid not null,
  revision_hash bytea not null check (pg_catalog.octet_length(revision_hash)=32),
  actor_id uuid not null,
  decision text not null check (decision in ('submit','return','reject','approve_highlighted')),
  note text not null default '' check (pg_catalog.length(note)<=2000),
  occurred_at timestamptz not null default pg_catalog.clock_timestamp(),
  foreign key(article_id,revision_id)
    references editorial_private.revisions(article_id,revision_id) on delete restrict
);
create table editorial_private.approvals (
  approval_id uuid primary key default pg_catalog.gen_random_uuid(),
  article_id uuid not null,
  revision_id uuid not null,
  revision_hash bytea not null check (pg_catalog.octet_length(revision_hash)=32),
  approver_id uuid not null,
  policy_version_id bigint not null references admin_private.policy_versions(version_id) on delete restrict,
  approved_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique(article_id,revision_id,approver_id),
  foreign key(article_id,revision_id)
    references editorial_private.revisions(article_id,revision_id) on delete restrict
);
create table editorial_private.publication_intents (
  intent_id uuid primary key default pg_catalog.gen_random_uuid(),
  article_id uuid not null references editorial_private.articles(article_id) on delete restrict,
  revision_id uuid,
  generation bigint not null check (generation>0),
  kind text not null check (kind in ('publish','unpublish')),
  requested_by uuid not null,
  request_id uuid not null unique,
  audit_event_no bigint not null references admin_private.staff_audit_events(event_no) on delete restrict,
  payload_hash bytea not null check (pg_catalog.octet_length(payload_hash)=32),
  status text not null default 'blocked' check (status='blocked'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique(article_id,generation),
  check ((kind='publish')=(revision_id is not null)),
  foreign key(article_id,revision_id)
    references editorial_private.revisions(article_id,revision_id) on delete restrict
);
create table editorial_private.approval_uses (
  approval_id uuid primary key references editorial_private.approvals(approval_id) on delete restrict,
  intent_id uuid not null unique references editorial_private.publication_intents(intent_id) on delete restrict,
  used_at timestamptz not null default pg_catalog.clock_timestamp()
);
create table editorial_private.delivery_outbox (
  intent_id uuid primary key references editorial_private.publication_intents(intent_id) on delete restrict,
  article_id uuid not null references editorial_private.articles(article_id) on delete restrict,
  generation bigint not null,
  payload jsonb not null check (pg_catalog.jsonb_typeof(payload)='object'),
  payload_hash bytea not null check (pg_catalog.octet_length(payload_hash)=32),
  status text not null default 'blocked' check (status='blocked'),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique(article_id,generation)
);
create table editorial_private.legacy_git_map (
  article_id uuid primary key references editorial_private.articles(article_id) on delete restrict,
  source_path text not null unique,
  slug text not null unique,
  source_hash bytea not null check (pg_catalog.octet_length(source_hash)=32),
  cutover_state text not null default 'not_started' check (cutover_state='not_started')
);

create function editorial_private.reject_evidence_change()
returns trigger language plpgsql set search_path = '' as $$
begin raise exception 'immutable CMS evidence' using errcode='42501'; end $$;
create function editorial_private.guard_article_change()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op='DELETE' then raise exception 'CMS article deletion forbidden' using errcode='42501'; end if;
  if new.article_id is distinct from old.article_id or new.slug is distinct from old.slug
     or new.collection_key is distinct from old.collection_key or new.origin is distinct from old.origin
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     or new.create_request_id is distinct from old.create_request_id
     or new.published_revision_id is distinct from old.published_revision_id
     or new.classification_floor < old.classification_floor
     or new.generation < old.generation then
    raise exception 'immutable CMS identity or floor changed' using errcode='42501';
  end if;
  return new;
end $$;
create trigger articles_guard before update or delete on editorial_private.articles
  for each row execute function editorial_private.guard_article_change();

do $triggers$
declare t text;
begin
  foreach t in array array['media_assets','slug_reservations','revisions',
    'revision_contributors','review_events','approvals','publication_intents',
    'approval_uses','delivery_outbox','legacy_git_map'] loop
    execute format('create trigger %I_immutable before update or delete on editorial_private.%I for each row execute function editorial_private.reject_evidence_change()',t,t);
  end loop;
end $triggers$;

revoke all on all tables in schema editorial_private
  from public,anon,authenticated,service_role,authenticator;
revoke all on all functions in schema editorial_private
  from public,anon,authenticated,service_role,authenticator;
grant select on all tables in schema editorial_private to admin_executor;
grant insert on editorial_private.articles,editorial_private.slug_reservations,
  editorial_private.revisions,editorial_private.revision_contributors,
  editorial_private.review_events,editorial_private.approvals,
  editorial_private.publication_intents,editorial_private.approval_uses,
  editorial_private.delivery_outbox to admin_executor;
grant update (current_revision_id,review_state,classification_floor,generation)
  on editorial_private.articles to admin_executor;

do $rls$
declare t text;
begin
  foreach t in array array['media_assets','articles','slug_reservations','revisions',
    'revision_contributors','review_events','approvals','publication_intents',
    'approval_uses','delivery_outbox','legacy_git_map'] loop
    execute format('alter table editorial_private.%I enable row level security',t);
    execute format('alter table editorial_private.%I force row level security',t);
    execute format('create policy executor_read on editorial_private.%I for select to admin_executor using (true)',t);
    if t in ('articles','slug_reservations','revisions','revision_contributors',
             'review_events','approvals','publication_intents','approval_uses','delivery_outbox') then
      execute format('create policy executor_insert on editorial_private.%I for insert to admin_executor with check (true)',t);
    end if;
  end loop;
end $rls$;
create policy executor_update on editorial_private.articles
  for update to admin_executor using (true) with check (true);

-- Expand the 0024 private gate only for the narrowly named CMS read/review
-- permissions and a collection grant derived from an immutable article row.
-- Existing article-scope and logout serialization semantics stay unchanged.
grant create on schema admin_private to admin_executor;
grant admin_executor to current_user;
set role admin_executor;
create or replace function admin_private.editorial_actor(p_permission text,p_article_id text)
returns uuid language plpgsql security definer set search_path = ''
as $actor$
declare c jsonb; uid uuid; sid uuid; coll text; allowed boolean;
begin
  if p_permission is null or p_permission not in
       ('news.draft.write','news.article.preview','news.article.submit',
        'news.article.review','news.article.approve_highlighted',
        'news.article.publish','news.article.unpublish')
     or p_article_id is null
     or p_article_id !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then return null; end if;
  if not admin_private.authorize_action('admin.enter','staging','global',null) then return null; end if;
  allowed := admin_private.authorize_action(p_permission,'staging','article',p_article_id);
  if not allowed and p_article_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select collection_key into coll from editorial_private.articles
      where article_id=p_article_id::uuid;
    if coll is not null then
      allowed := admin_private.authorize_action(p_permission,'staging','collection',coll);
    end if;
  end if;
  if not allowed then return null; end if;
  c := pg_catalog.current_setting('request.jwt.claims',true)::jsonb;
  uid := (c->>'sub')::uuid; sid := (c->>'session_id')::uuid;
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('admin-session:'||sid::text,0));
  if exists(select 1 from admin_private.session_revocations r
       where r.user_id=uid and r.session_id=sid)
     or not admin_private.fresh_totp_session(uid,sid) then return null; end if;
  -- Recheck after every possible lock wait, including expiry and revocation.
  if not admin_private.authorize_action('admin.enter','staging','global',null)
     or not (admin_private.authorize_action(p_permission,'staging','article',p_article_id)
       or (coll is not null and admin_private.authorize_action(p_permission,'staging','collection',coll)))
     or not admin_private.fresh_totp_session(uid,sid) then return null; end if;
  return uid;
exception when invalid_text_representation or invalid_parameter_value then return null;
end $actor$;
reset role;
revoke admin_executor from current_user;
revoke create on schema admin_private from admin_executor;

create function editorial_private.canonical_snapshot(p_input jsonb)
returns jsonb language plpgsql security invoker set search_path = ''
as $snapshot$
declare v_title text; v_summary text; v_body text; v_byline text; v_category text;
  v_seo text; v_class text; v_featured boolean; v_sample boolean;
  v_tags jsonb; v_links jsonb; v_images jsonb; v_output_images jsonb := '[]'::jsonb;
  item jsonb; asset record; v_asset_id uuid;
begin
  if p_input is null or pg_catalog.jsonb_typeof(p_input)<>'object'
     or exists(select 1 from pg_catalog.jsonb_object_keys(p_input) k
               where k not in ('title','summary','body_markdown','byline',
                 'category','tags','classification','featured','sample',
                 'seo_description','images','related_links')) then
    raise exception 'invalid article snapshot' using errcode='22023';
  end if;
  if pg_catalog.jsonb_typeof(p_input->'title')<>'string'
     or pg_catalog.jsonb_typeof(p_input->'summary')<>'string'
     or pg_catalog.jsonb_typeof(p_input->'body_markdown')<>'string'
     or pg_catalog.jsonb_typeof(p_input->'classification')<>'string' then
    raise exception 'invalid article snapshot' using errcode='22023';
  end if;
  v_title:=pg_catalog.btrim(p_input->>'title');
  v_summary:=pg_catalog.btrim(p_input->>'summary');
  v_body:=p_input->>'body_markdown';
  v_class:=p_input->>'classification';
  v_byline:=coalesce(p_input->>'byline','AzerDex');
  v_category:=coalesce(p_input->>'category','news');
  v_seo:=coalesce(p_input->>'seo_description',v_summary);
  if pg_catalog.length(v_title) not between 3 and 120
     or pg_catalog.length(v_summary) not between 20 and 200
     or pg_catalog.length(v_body) not between 1 and 100000
     or pg_catalog.length(v_byline) not between 2 and 60
     or pg_catalog.length(v_category) not between 2 and 40
     or pg_catalog.length(v_seo) not between 20 and 200
     or v_class not in ('normal','highlighted')
     or v_body ~* '<[a-z/!][^>]*>'
     or v_body ~* '(javascript:|data:)' then
    raise exception 'invalid article snapshot' using errcode='22023';
  end if;
  if p_input ? 'featured' and pg_catalog.jsonb_typeof(p_input->'featured')<>'boolean'
     or p_input ? 'sample' and pg_catalog.jsonb_typeof(p_input->'sample')<>'boolean' then
    raise exception 'invalid article snapshot flags' using errcode='22023';
  end if;
  v_featured:=coalesce((p_input->>'featured')::boolean,false);
  v_sample:=coalesce((p_input->>'sample')::boolean,false);
  v_tags:=coalesce(p_input->'tags','[]'::jsonb);
  v_links:=coalesce(p_input->'related_links','[]'::jsonb);
  v_images:=coalesce(p_input->'images','[]'::jsonb);
  if pg_catalog.jsonb_typeof(v_tags)<>'array' or pg_catalog.jsonb_array_length(v_tags)>10
     or pg_catalog.jsonb_typeof(v_links)<>'array' or pg_catalog.jsonb_array_length(v_links)>6
     or pg_catalog.jsonb_typeof(v_images)<>'array' or pg_catalog.jsonb_array_length(v_images)>10
     or exists(select 1 from pg_catalog.jsonb_array_elements(v_tags) x
               where pg_catalog.jsonb_typeof(x)<>'string' or x#>>'{}' !~ '^[a-z0-9-]{2,30}$')
     or exists(select 1 from pg_catalog.jsonb_array_elements(v_links) x
               where pg_catalog.jsonb_typeof(x)<>'string' or x#>>'{}' !~ '^https://[^[:space:]]+$'
                 or pg_catalog.length(x#>>'{}')>308) then
    raise exception 'invalid article snapshot arrays' using errcode='22023';
  end if;
  for item in select value from pg_catalog.jsonb_array_elements(v_images) loop
    if pg_catalog.jsonb_typeof(item)<>'object'
       or (select count(*) from pg_catalog.jsonb_object_keys(item))<>2
       or not (item ? 'asset_id' and item ? 'alt')
       or pg_catalog.jsonb_typeof(item->'asset_id')<>'string'
       or pg_catalog.jsonb_typeof(item->'alt')<>'string'
       or pg_catalog.length(item->>'alt') not between 3 and 200 then
      raise exception 'invalid image reference' using errcode='22023';
    end if;
    v_asset_id:=(item->>'asset_id')::uuid;
    select * into asset from editorial_private.media_assets m where m.asset_id=v_asset_id;
    if not found or asset.verified_at is null then
      raise exception 'image rights not verified' using errcode='22023';
    end if;
    v_output_images:=v_output_images || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('asset_id',asset.asset_id,'version',asset.asset_version,
        'path',asset.path,'content_sha256',pg_catalog.encode(asset.content_sha256,'hex'),
        'alt',item->>'alt','attribution',asset.attribution,
        'rights_source',asset.rights_source,'rights_license',asset.rights_license));
  end loop;
  return pg_catalog.jsonb_build_object(
    'title',v_title,'summary',v_summary,'body_markdown',v_body,
    'byline',v_byline,'category',v_category,'tags',v_tags,
    'classification',v_class,'featured',v_featured,'sample',v_sample,
    'seo_description',v_seo,'images',v_output_images,'related_links',v_links);
exception when invalid_text_representation then
  raise exception 'invalid image reference' using errcode='22023';
end $snapshot$;
revoke all on function editorial_private.canonical_snapshot(jsonb)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function editorial_private.canonical_snapshot(jsonb) to admin_executor;

create function editorial_private.require_actor(p_permission text,p_article_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $actor$
declare v_actor uuid;
begin
  v_actor:=admin_private.editorial_actor(p_permission,p_article_id::text);
  if v_actor is null then raise exception 'editorial action denied' using errcode='42501'; end if;
  return v_actor;
end $actor$;
revoke all on function editorial_private.require_actor(text,uuid)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function editorial_private.require_actor(text,uuid) to admin_executor;

-- A historical approval is useful only while its approver has live authority
-- under the current policy. Lock staff/grants so a competing revoke serializes.
create function editorial_private.eligible_approver(p_uid uuid,p_article_id uuid,p_policy bigint)
returns boolean language plpgsql security invoker set search_path = '' as $eligible$
declare v_now timestamptz; v_role record; v_grant record;
  v_enter_deadline timestamptz:='-infinity';
  v_default_deadline timestamptz:='-infinity';
  v_editor_deadline timestamptz:='-infinity';
  v_grant_deadline timestamptz:='-infinity'; v_collection text;
begin
  select collection_key into v_collection from editorial_private.articles
    where article_id=p_article_id;
  if v_collection is null or p_policy=0
     or (select version_id from admin_private.active_policy where singleton)<>p_policy
     or not exists(select 1 from admin_private.policy_versions
                   where version_id=p_policy and approval_state='approved' and activated_at is not null)
     then return false; end if;
  perform 1 from admin_private.staff_subjects
    where user_id=p_uid and status='active' for share;
  if not found then return false; end if;
  v_now:=pg_catalog.clock_timestamp();
  for v_role in select a.role_name,a.scope_kind,a.expires_at,a.review_due_at from admin_private.role_assignments a
    where a.user_id=p_uid and a.policy_version_id=p_policy and a.environment_scope='staging'
      and a.status='active' and a.starts_at<=v_now
      and (a.expires_at is null or a.expires_at>v_now) and a.review_due_at>v_now
      and (a.scope_kind='global' or (a.scope_kind='article' and a.scope_id=p_article_id::text)
           or (a.scope_kind='collection' and a.scope_id=v_collection))
    order by a.assignment_id for share of a loop
    if v_role.scope_kind='global' and exists(select 1 from admin_private.role_permissions
         where version_id=p_policy and role_name=v_role.role_name and permission_key='admin.enter')
       then v_enter_deadline:=greatest(v_enter_deadline,
         least(coalesce(v_role.expires_at,'infinity'::timestamptz),v_role.review_due_at)); end if;
    if v_role.role_name='Editor' then
      v_editor_deadline:=greatest(v_editor_deadline,
        least(coalesce(v_role.expires_at,'infinity'::timestamptz),v_role.review_due_at)); end if;
    if v_role.role_name in ('Administrator','Owner')
       and exists(select 1 from admin_private.role_permissions
                  where version_id=p_policy and role_name=v_role.role_name
                    and permission_key='news.article.approve_highlighted') then
      v_default_deadline:=greatest(v_default_deadline,
        least(coalesce(v_role.expires_at,'infinity'::timestamptz),v_role.review_due_at));
    end if;
  end loop;
  if v_editor_deadline>'-infinity'::timestamptz then
    for v_grant in select g.expires_at from admin_private.direct_grants g
      where g.user_id=p_uid and g.policy_version_id=p_policy
        and g.environment_scope='staging' and g.status='active'
        and g.permission_key='news.article.approve_highlighted'
        and g.starts_at<=v_now and g.expires_at>v_now
        and ((g.scope_kind='article' and g.scope_id=p_article_id::text)
             or (g.scope_kind='collection' and g.scope_id=v_collection))
      order by g.grant_id for share of g loop
      v_grant_deadline:=greatest(v_grant_deadline,v_grant.expires_at);
    end loop;
  end if;
  v_now:=pg_catalog.clock_timestamp();
  return v_enter_deadline>v_now
     and (v_default_deadline>v_now
       or (v_editor_deadline>v_now and v_grant_deadline>v_now))
     and (select version_id from admin_private.active_policy where singleton)=p_policy
     and exists(select 1 from admin_private.staff_subjects where user_id=p_uid and status='active');
end $eligible$;
revoke all on function editorial_private.eligible_approver(uuid,uuid,bigint)
  from public,anon,authenticated,service_role,authenticator;
grant execute on function editorial_private.eligible_approver(uuid,uuid,bigint) to admin_executor;

-- Only the no-login executor can enter this dispatcher; each API RPC below has
-- a fixed operation and fixed signature. No caller chooses a permission or role.
grant create on schema editorial_private to admin_executor;
grant create on schema public to admin_executor;
grant admin_executor to current_user;
set role admin_executor;
create function editorial_private.lock_audit_and_recheck(
  p_permission text,p_article uuid,p_actor uuid,p_approver uuid,p_policy bigint
) returns void language plpgsql security invoker set search_path = '' as $lock$
begin
  perform 1 from admin_private.staff_audit_head where singleton for update;
  if not found or editorial_private.require_actor(p_permission,p_article)
     is distinct from p_actor then
    raise exception 'editorial authority expired during audit wait' using errcode='42501'; end if;
  if p_approver is not null and
     not editorial_private.eligible_approver(p_approver,p_article,p_policy) then
    raise exception 'approver authority expired during audit wait' using errcode='42501'; end if;
end $lock$;
create function editorial_private.run_action(
  p_action text,p_article uuid,p_revision uuid,p_snapshot jsonb,
  p_slug text,p_note text,p_request uuid
) returns uuid language plpgsql security invoker set search_path = '' as $action$
declare a editorial_private.articles%rowtype; r editorial_private.revisions%rowtype;
  v_actor uuid; v_snapshot jsonb; v_original_snapshot jsonb; v_hash bytea; v_new uuid;
  v_before jsonb; v_after jsonb; v_audit bigint; v_policy bigint;
  v_approval editorial_private.approvals%rowtype; v_prior editorial_private.publication_intents%rowtype;
  v_class integer; v_kind text; v_payload jsonb;
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
      raise exception 'stale or uneditable revision' using errcode='40001'; end if;
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
      raise exception 'stale or unsubmitted revision' using errcode='40001'; end if;
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
    v_after:=pg_catalog.jsonb_build_object('event',p_action,'revision',r.revision_id);
  elsif p_action='approve' then
    if p_revision is distinct from r.revision_id or a.review_state<>'in_review'
       or r.effective_classification<>1 or exists(
         select 1 from editorial_private.revision_contributors
         where revision_id=r.revision_id and actor_id=v_actor) then
      raise exception 'independent highlighted approval required' using errcode='42501'; end if;
    select version_id into v_policy from admin_private.active_policy where singleton for share;
    if not editorial_private.eligible_approver(v_actor,p_article,v_policy) then
      raise exception 'approver no longer eligible' using errcode='42501'; end if;
    perform editorial_private.lock_audit_and_recheck(v_kind,p_article,v_actor,v_actor,v_policy);
    insert into editorial_private.approvals(article_id,revision_id,revision_hash,
      approver_id,policy_version_id) values(p_article,r.revision_id,r.snapshot_hash,
      v_actor,v_policy) returning approval_id into v_new;
    insert into editorial_private.review_events(article_id,revision_id,revision_hash,
      actor_id,decision) values(p_article,r.revision_id,r.snapshot_hash,
      v_actor,'approve_highlighted');
    update editorial_private.articles set review_state='approved' where article_id=p_article;
    v_after:=pg_catalog.jsonb_build_object('event','approve_highlighted',
      'revision',r.revision_id,'approval',v_new);
  elsif p_action in ('publish','unpublish') then
    select * into v_prior from editorial_private.publication_intents where request_id=p_request;
    if found then
      if v_prior.article_id=p_article and v_prior.kind=p_action and
         (p_action='unpublish' or v_prior.revision_id=p_revision) and
         v_prior.requested_by=v_actor then return v_prior.intent_id; end if;
      raise exception 'request id reused' using errcode='23505'; end if;
    if p_action='publish' then
      if p_revision is distinct from r.revision_id or
         (r.effective_classification=0 and a.review_state<>'in_review') or
         (r.effective_classification=1 and a.review_state<>'approved') or
         a.classification_floor>r.effective_classification then
        raise exception 'revision not publishable' using errcode='42501'; end if;
      select version_id into v_policy from admin_private.active_policy where singleton for share;
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
           or not editorial_private.eligible_approver(v_approval.approver_id,p_article,v_policy)
           then raise exception 'independent current approval required' using errcode='42501'; end if;
      end if;
      v_payload:=pg_catalog.jsonb_build_object('kind','publish','article_id',p_article,
        'slug',a.slug,'revision_id',r.revision_id,'revision_hash',
        pg_catalog.encode(r.snapshot_hash,'hex'),'generation',a.generation+1);
      perform editorial_private.lock_audit_and_recheck(v_kind,p_article,v_actor,
        case when r.effective_classification=1 then v_approval.approver_id end,v_policy);
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
    v_hash:=pg_catalog.sha256(pg_catalog.convert_to(v_payload::text,'UTF8'));
    v_new:=pg_catalog.gen_random_uuid();
    v_after:=pg_catalog.jsonb_build_object('event',p_action||'_intent',
      'revision',case when p_action='publish' then r.revision_id end,
      'revision_hash',case when p_action='publish' then pg_catalog.encode(r.snapshot_hash,'hex') end,
      'payload_hash',pg_catalog.encode(v_hash,'hex'),
      'intent',v_new,'generation',a.generation+1);
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
       and not editorial_private.eligible_approver(v_approval.approver_id,p_article,v_policy) then
      raise exception 'approver eligibility expired during publication' using errcode='42501'; end if;
    return v_new;
  end if;
  perform admin_private.append_editorial_audit(v_kind,p_article::text,v_actor,
    p_request,v_before,v_after);
  return v_new;
end $action$;

-- Each public entrypoint is a finite action, with no caller-supplied authority.
create function public.fdb_cms_create_draft(p_article uuid,p_slug text,p_snapshot jsonb,p_request uuid)
returns uuid language sql security definer set search_path = '' as $$
  select editorial_private.run_action('create',p_article,null,p_snapshot,p_slug,null,p_request)
$$;
create function public.fdb_cms_edit_draft(p_article uuid,p_revision uuid,p_snapshot jsonb,p_request uuid)
returns uuid language sql security definer set search_path = '' as $$
  select editorial_private.run_action('edit',p_article,p_revision,p_snapshot,null,null,p_request)
$$;
create function public.fdb_cms_submit_review(p_article uuid,p_revision uuid,p_request uuid)
returns uuid language sql security definer set search_path = '' as $$
  select editorial_private.run_action('submit',p_article,p_revision,null,null,null,p_request)
$$;
create function public.fdb_cms_review_decide(p_article uuid,p_revision uuid,p_decision text,p_note text,p_request uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if p_decision not in ('return','reject') then raise exception 'invalid review decision' using errcode='22023'; end if;
  return editorial_private.run_action(p_decision,p_article,p_revision,null,null,p_note,p_request);
end $$;
create function public.fdb_cms_approve_highlighted(p_article uuid,p_revision uuid,p_request uuid)
returns uuid language sql security definer set search_path = '' as $$
  select editorial_private.run_action('approve',p_article,p_revision,null,null,null,p_request)
$$;
create function public.fdb_cms_publish_intent(p_article uuid,p_revision uuid,p_request uuid)
returns uuid language sql security definer set search_path = '' as $$
  select editorial_private.run_action('publish',p_article,p_revision,null,null,null,p_request)
$$;
create function public.fdb_cms_unpublish_intent(p_article uuid,p_request uuid)
returns uuid language sql security definer set search_path = '' as $$
  select editorial_private.run_action('unpublish',p_article,null,null,null,null,p_request)
$$;
create function public.fdb_cms_article(p_article uuid)
returns jsonb language plpgsql security definer set search_path = '' as $read$
declare a editorial_private.articles%rowtype; r editorial_private.revisions%rowtype;
  actor uuid;
begin
  actor:=admin_private.editorial_actor('news.article.preview',p_article::text);
  if actor is null then
    actor:=admin_private.editorial_actor('news.article.approve_highlighted',p_article::text);
  end if;
  if actor is null then raise exception 'editorial read denied' using errcode='42501'; end if;
  select * into a from editorial_private.articles where article_id=p_article for share;
  if not found or (admin_private.editorial_actor('news.article.preview',p_article::text)
    is distinct from actor and
    admin_private.editorial_actor('news.article.approve_highlighted',p_article::text)
    is distinct from actor) then
    raise exception 'editorial read denied' using errcode='42501'; end if;
  select * into r from editorial_private.revisions where revision_id=a.current_revision_id;
  if not found or r.article_id<>p_article then
    raise exception 'editorial revision missing' using errcode='42501'; end if;
  return pg_catalog.jsonb_build_object('article_id',a.article_id,'slug',a.slug,
    'origin',a.origin,'review_state',a.review_state,'classification_floor',a.classification_floor,
    'generation',a.generation,'current_revision_id',r.revision_id,
    'published_revision_id',a.published_revision_id,'revision_no',r.revision_no,
    'snapshot_hash',pg_catalog.encode(r.snapshot_hash,'hex'),'snapshot',r.snapshot);
end $read$;
revoke all on function editorial_private.run_action(text,uuid,uuid,jsonb,text,text,uuid)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function editorial_private.lock_audit_and_recheck(text,uuid,uuid,uuid,bigint)
  from public,anon,authenticated,service_role,authenticator;
revoke all on function
  public.fdb_cms_create_draft(uuid,text,jsonb,uuid),
  public.fdb_cms_edit_draft(uuid,uuid,jsonb,uuid),
  public.fdb_cms_submit_review(uuid,uuid,uuid),
  public.fdb_cms_review_decide(uuid,uuid,text,text,uuid),
  public.fdb_cms_approve_highlighted(uuid,uuid,uuid),
  public.fdb_cms_publish_intent(uuid,uuid,uuid),
  public.fdb_cms_unpublish_intent(uuid,uuid),
  public.fdb_cms_article(uuid)
  from public,anon,service_role,authenticator;
grant execute on function
  public.fdb_cms_create_draft(uuid,text,jsonb,uuid),
  public.fdb_cms_edit_draft(uuid,uuid,jsonb,uuid),
  public.fdb_cms_submit_review(uuid,uuid,uuid),
  public.fdb_cms_review_decide(uuid,uuid,text,text,uuid),
  public.fdb_cms_approve_highlighted(uuid,uuid,uuid),
  public.fdb_cms_publish_intent(uuid,uuid,uuid),
  public.fdb_cms_unpublish_intent(uuid,uuid),
  public.fdb_cms_article(uuid)
  to authenticated;
reset role;
revoke admin_executor from current_user;
revoke create on schema editorial_private from admin_executor;
revoke create on schema public from admin_executor;


commit;
