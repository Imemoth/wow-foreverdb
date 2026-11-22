-- ADM-03C public-read projection. Separate from Collector and observation publisher.
-- The delivery login is NOLOGIN until a separately approved operator ceremony.
begin;

do $preflight$
begin
  if to_regclass('pub.news_entries') is null
     or to_regrole('foreverdb_pub_owner') is null
     or to_regrole('foreverdb_web_reader') is null
     or to_regnamespace('cms_pub') is not null then
    raise exception '0013 requires the existing public-read foundation and no CMS projection';
  end if;
  if to_regrole('azerdex_cms_delivery') is not null then
    raise exception '0013 refuses an existing delivery identity';
  end if;
end $preflight$;

create role azerdex_cms_delivery nologin noinherit nosuperuser nocreatedb
  nocreaterole noreplication nobypassrls;
alter role azerdex_cms_delivery connection limit 2;
alter role azerdex_cms_delivery set statement_timeout = '15s';
alter role azerdex_cms_delivery set idle_in_transaction_session_timeout = '10s';

create schema cms_pub authorization foreverdb_pub_owner;
set local role foreverdb_pub_owner;
revoke all on schema cms_pub from public,anon,authenticated,service_role,
  foreverdb_web_reader,foreverdb_publisher,azerdex_news_ingest,azerdex_cms_delivery;
grant usage on schema pub_admin to azerdex_cms_delivery;
grant usage on schema web_api to foreverdb_web_reader;

create table cms_pub.articles (
  article_id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 80),
  generation bigint not null check (generation>=1),
  revision_id uuid,
  tombstone boolean not null,
  first_published_at timestamptz,
  changed_at timestamptz not null default pg_catalog.clock_timestamp(),
  check (tombstone=(revision_id is null))
);
create table cms_pub.revisions (
  article_id uuid not null references cms_pub.articles(article_id) on delete restrict,
  revision_id uuid not null,
  snapshot_hash bytea not null check (pg_catalog.octet_length(snapshot_hash)=32),
  snapshot jsonb not null check (pg_catalog.jsonb_typeof(snapshot)='object'),
  first_applied_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key(article_id,revision_id)
);
alter table cms_pub.articles add constraint cms_active_revision_same_article
  foreign key(article_id,revision_id) references cms_pub.revisions(article_id,revision_id)
  on delete restrict deferrable initially deferred;
create table cms_pub.receipts (
  intent_id uuid primary key,
  article_id uuid not null references cms_pub.articles(article_id) on delete restrict,
  generation bigint not null,
  kind text not null check (kind in ('publish','unpublish')),
  revision_id uuid,
  payload_hash bytea not null check (pg_catalog.octet_length(payload_hash)=32),
  applied_at timestamptz not null default pg_catalog.clock_timestamp(),
  unique(article_id,generation),
  check ((kind='publish')=(revision_id is not null))
);
create table cms_pub.delivery_mac_key (
  singleton boolean primary key default true check(singleton),
  secret bytea not null check(pg_catalog.octet_length(secret)=32)
);

create function cms_pub.reject_evidence_change() returns trigger language plpgsql
  set search_path = '' as $$
begin raise exception 'immutable public CMS evidence' using errcode='42501'; end $$;
create trigger revisions_immutable before update or delete on cms_pub.revisions
  for each row execute function cms_pub.reject_evidence_change();
create trigger receipts_immutable before update or delete on cms_pub.receipts
  for each row execute function cms_pub.reject_evidence_change();

revoke all on all tables in schema cms_pub from public,anon,authenticated,service_role,
  foreverdb_web_reader,foreverdb_publisher,azerdex_news_ingest,azerdex_cms_delivery;
revoke all on all functions in schema cms_pub from public,anon,authenticated,service_role,
  foreverdb_web_reader,foreverdb_publisher,azerdex_news_ingest,azerdex_cms_delivery;
alter default privileges in schema cms_pub revoke all on tables from public;
alter default privileges in schema cms_pub revoke all on functions from public;
do $rls$
declare t text;
begin
  foreach t in array array['articles','revisions','receipts','delivery_mac_key'] loop
    execute format('alter table cms_pub.%I enable row level security',t);
    execute format('alter table cms_pub.%I force row level security',t);
    execute format('create policy owner_read on cms_pub.%I for select to foreverdb_pub_owner using (true)',t);
    execute format('create policy owner_insert on cms_pub.%I for insert to foreverdb_pub_owner with check (true)',t);
  end loop;
end $rls$;
create policy owner_update on cms_pub.articles for update to foreverdb_pub_owner
  using (true) with check (true);

create function cms_pub.cms_mac(p_message text)
returns text language plpgsql security invoker set search_path = '' as $mac$
declare k bytea; inner_pad bytea:=pg_catalog.decode(pg_catalog.repeat('36',64),'hex');
  outer_pad bytea:=pg_catalog.decode(pg_catalog.repeat('5c',64),'hex'); n integer;
begin
  select secret into k from cms_pub.delivery_mac_key where singleton;
  if k is null then raise exception 'CMS delivery MAC key is unprovisioned' using errcode='42501'; end if;
  for n in 0..31 loop
    inner_pad:=pg_catalog.set_byte(inner_pad,n,pg_catalog.get_byte(inner_pad,n)#pg_catalog.get_byte(k,n));
    outer_pad:=pg_catalog.set_byte(outer_pad,n,pg_catalog.get_byte(outer_pad,n)#pg_catalog.get_byte(k,n));
  end loop;
  return pg_catalog.encode(pg_catalog.sha256(outer_pad ||
    pg_catalog.sha256(inner_pad || pg_catalog.convert_to(p_message,'UTF8'))),'hex');
end $mac$;

create function cms_pub.receipt_json(p_receipt cms_pub.receipts)
returns jsonb language plpgsql security invoker set search_path = '' as $receipt$
declare body jsonb;
begin
  body:=pg_catalog.jsonb_build_object('intent_id',p_receipt.intent_id,
    'article_id',p_receipt.article_id,'generation',p_receipt.generation,
    'kind',p_receipt.kind,'payload_hash',pg_catalog.encode(p_receipt.payload_hash,'hex'),
    'applied_at',p_receipt.applied_at);
  return body || pg_catalog.jsonb_build_object('receipt_mac',cms_pub.cms_mac(body::text));
end $receipt$;

-- Dedicated login may call this one finite mutation. A receipt is returned
-- only after the article pointer, immutable snapshot and receipt commit.
create function pub_admin.cms_apply(p_envelope jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $apply$
declare v_article uuid; v_revision uuid; v_intent uuid; v_generation bigint;
  v_auth_expires bigint;
  v_slug text; v_kind text; v_hash bytea; v_snapshot jsonb; v_snapshot_hash bytea;
  v_expected bytea; a cms_pub.articles%rowtype; prior cms_pub.receipts%rowtype;
  v_payload jsonb;
begin
  if p_envelope is null or pg_catalog.jsonb_typeof(p_envelope)<>'object'
     or exists(select 1 from pg_catalog.jsonb_object_keys(p_envelope) k
       where k not in ('article_id','revision_id','intent_id','generation',
         'slug','kind','payload_hash','revision_hash','snapshot','auth_mac','auth_expires_epoch')) then
    raise exception 'invalid CMS delivery envelope' using errcode='22023'; end if;
  v_article:=(p_envelope->>'article_id')::uuid;
  v_intent:=(p_envelope->>'intent_id')::uuid;
  v_generation:=(p_envelope->>'generation')::bigint;
  v_slug:=p_envelope->>'slug'; v_kind:=p_envelope->>'kind';
  v_hash:=pg_catalog.decode(p_envelope->>'payload_hash','hex');
  v_auth_expires:=(p_envelope->>'auth_expires_epoch')::bigint;
  if v_article is null or v_intent is null or v_generation is null
     or v_generation<1 or v_slug is null
     or v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) not between 3 and 80
     or v_kind not in ('publish','unpublish') or pg_catalog.octet_length(v_hash)<>32
     then raise exception 'invalid CMS delivery envelope' using errcode='22023'; end if;
  if v_kind='publish' then
    v_revision:=(p_envelope->>'revision_id')::uuid;
    v_snapshot:=p_envelope->'snapshot';
    v_snapshot_hash:=pg_catalog.decode(p_envelope->>'revision_hash','hex');
    if v_revision is null or v_snapshot is null or
       pg_catalog.jsonb_typeof(v_snapshot)<>'object' or
       pg_catalog.octet_length(v_snapshot_hash)<>32 or
       pg_catalog.sha256(pg_catalog.convert_to(v_snapshot::text,'UTF8'))<>v_snapshot_hash or
       exists(select 1 from pg_catalog.jsonb_object_keys(v_snapshot) k
         where k not in ('title','summary','body_markdown','byline','category',
           'tags','classification','featured','sample','seo_description','images','related_links'))
       then raise exception 'invalid CMS revision snapshot' using errcode='22023'; end if;
    v_payload:=pg_catalog.jsonb_build_object('kind','publish','article_id',v_article,
      'slug',v_slug,'revision_id',v_revision,'revision_hash',
      pg_catalog.encode(v_snapshot_hash,'hex'),'generation',v_generation);
  else
    if p_envelope->'revision_id' is not null or p_envelope->'snapshot' is not null
       or p_envelope->'revision_hash' is not null then
      raise exception 'unpublish cannot carry a revision' using errcode='22023'; end if;
    v_payload:=pg_catalog.jsonb_build_object('kind','unpublish','article_id',v_article,
      'slug',v_slug,'generation',v_generation);
  end if;
  v_expected:=pg_catalog.sha256(pg_catalog.convert_to(v_payload::text,'UTF8'));
  if v_hash<>v_expected then raise exception 'CMS payload hash mismatch' using errcode='42501'; end if;
  if v_auth_expires is null or
     v_auth_expires<=pg_catalog.date_part('epoch',pg_catalog.clock_timestamp()) or
     v_auth_expires>pg_catalog.date_part('epoch',pg_catalog.clock_timestamp()+interval '3 minutes') or
     p_envelope->>'auth_mac' is distinct from
      cms_pub.cms_mac(v_intent::text||':'||pg_catalog.encode(v_hash,'hex')||':'||v_auth_expires::text) then
    raise exception 'CMS delivery authorization MAC mismatch' using errcode='42501'; end if;

  select * into prior from cms_pub.receipts where intent_id=v_intent;
  if found then
    if prior.article_id<>v_article or prior.generation<>v_generation
       or prior.kind<>v_kind or prior.revision_id is distinct from v_revision
       or prior.payload_hash<>v_hash then
      raise exception 'conflicting CMS delivery retry' using errcode='23505'; end if;
    return cms_pub.receipt_json(prior);
  end if;
  select * into a from cms_pub.articles where article_id=v_article for update;
  if found then
    -- Superseded or revoked intents may never reach this database. A signed
    -- current intent can jump over them, but never overwrite a newer pointer.
    if a.slug<>v_slug or v_generation<=a.generation then
      raise exception 'stale or conflicting CMS generation' using errcode='40001'; end if;
  elsif v_generation<1 then
    raise exception 'invalid first CMS generation' using errcode='40001';
  end if;
  if v_kind='publish' then
    if found then
      insert into cms_pub.revisions(article_id,revision_id,snapshot_hash,snapshot)
        values(v_article,v_revision,v_snapshot_hash,v_snapshot)
        on conflict(article_id,revision_id) do nothing;
      if not exists(select 1 from cms_pub.revisions where article_id=v_article
          and revision_id=v_revision and snapshot_hash=v_snapshot_hash and snapshot=v_snapshot)
        then raise exception 'revision ID content conflict' using errcode='23505'; end if;
      update cms_pub.articles set generation=v_generation,revision_id=v_revision,
        tombstone=false,changed_at=pg_catalog.clock_timestamp() where article_id=v_article;
    else
      insert into cms_pub.articles(article_id,slug,generation,revision_id,tombstone,
        first_published_at) values(v_article,v_slug,v_generation,v_revision,false,
          pg_catalog.clock_timestamp());
      insert into cms_pub.revisions(article_id,revision_id,snapshot_hash,snapshot)
        values(v_article,v_revision,v_snapshot_hash,v_snapshot);
    end if;
  else
    if not found then
      insert into cms_pub.articles(article_id,slug,generation,revision_id,tombstone)
        values(v_article,v_slug,v_generation,null,true);
    else
      update cms_pub.articles set generation=v_generation,revision_id=null,
        tombstone=true,changed_at=pg_catalog.clock_timestamp() where article_id=v_article;
    end if;
  end if;
  insert into cms_pub.receipts(intent_id,article_id,generation,kind,revision_id,payload_hash)
    values(v_intent,v_article,v_generation,v_kind,v_revision,v_hash) returning * into prior;
  return cms_pub.receipt_json(prior);
exception when invalid_text_representation or invalid_parameter_value or numeric_value_out_of_range
  then raise exception 'invalid CMS delivery envelope' using errcode='22023';
end $apply$;

-- A tombstone is returned as an explicit result so the website never falls
-- back to a removed Git article after a separately approved cutover.
create function web_api.cms_article(p_slug text) returns jsonb language sql stable
security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('article_id',a.article_id,'slug',a.slug,
    'generation',a.generation,'tombstone',a.tombstone,'revision_id',a.revision_id,
    'published_at',a.first_published_at,'changed_at',a.changed_at,
    'snapshot',r.snapshot,'revision_hash',pg_catalog.encode(r.snapshot_hash,'hex'))
  from cms_pub.articles a left join cms_pub.revisions r
    on r.article_id=a.article_id and r.revision_id=a.revision_id
  where a.slug=p_slug and p_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
$$;
create function pub_admin.cms_receipt(p_intent uuid) returns jsonb language sql stable
security definer set search_path = '' as $$
  select cms_pub.receipt_json(r)
  from cms_pub.receipts r where r.intent_id=p_intent
$$;

revoke all on function cms_pub.cms_mac(text),cms_pub.receipt_json(cms_pub.receipts)
  from public,anon,authenticated,service_role,foreverdb_web_reader,
    foreverdb_publisher,azerdex_news_ingest,azerdex_cms_delivery;
create function web_api.cms_list(p_limit integer,p_offset integer) returns setof jsonb
language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('article_id',a.article_id,'slug',a.slug,
    'generation',a.generation,'revision_id',a.revision_id,
    'published_at',a.first_published_at,'changed_at',a.changed_at,
    'snapshot',r.snapshot,'revision_hash',pg_catalog.encode(r.snapshot_hash,'hex'))
  from cms_pub.articles a join cms_pub.revisions r
    on r.article_id=a.article_id and r.revision_id=a.revision_id
  where not a.tombstone and coalesce(p_limit,0) between 1 and 50
    and coalesce(p_offset,-1) between 0 and 10000
  order by a.first_published_at desc,a.article_id
  limit p_limit offset p_offset
$$;

revoke all on function pub_admin.cms_apply(jsonb),pub_admin.cms_receipt(uuid),web_api.cms_article(text),
  web_api.cms_list(integer,integer) from public,anon,authenticated,service_role,
  foreverdb_publisher,azerdex_news_ingest;
grant execute on function pub_admin.cms_apply(jsonb) to azerdex_cms_delivery;
grant execute on function pub_admin.cms_receipt(uuid) to azerdex_cms_delivery;
grant execute on function web_api.cms_article(text),web_api.cms_list(integer,integer)
  to foreverdb_web_reader;
commit;
