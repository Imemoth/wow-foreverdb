do $security$
begin
  if has_schema_privilege('foreverdb_web_reader','cms_pub','USAGE')
     or cms_pub.cms_mac('test')<>
       '248c3141988983387d02b1f0b0fd9f94b7ebef6f841a501a90deeaa2f72e5fd3'
     or has_schema_privilege('azerdex_cms_delivery','cms_pub','USAGE')
     or has_table_privilege('foreverdb_web_reader','cms_pub.articles','SELECT')
     or has_table_privilege('azerdex_cms_delivery','cms_pub.articles','INSERT')
     or has_table_privilege('azerdex_cms_delivery','cms_pub.delivery_mac_key','SELECT')
     or has_function_privilege('azerdex_cms_delivery','cms_pub.cms_mac(text)','EXECUTE')
     or has_function_privilege('foreverdb_publisher','pub_admin.cms_apply(jsonb)','EXECUTE')
     or has_function_privilege('azerdex_news_ingest','pub_admin.cms_apply(jsonb)','EXECUTE')
     or not has_function_privilege('azerdex_cms_delivery','pub_admin.cms_apply(jsonb)','EXECUTE')
     or not has_function_privilege('foreverdb_web_reader','web_api.cms_article(text)','EXECUTE')
     or not (select relforcerowsecurity from pg_class where oid='cms_pub.articles'::regclass)
     then raise exception 'public CMS projection isolation failed'; end if;
end $security$;

set role foreverdb_pub_owner;
do $lifecycle$
declare article uuid:='00000000-0000-0000-0000-000000000801';
  rev1 uuid:='00000000-0000-0000-0000-000000000802';
  rev2 uuid:='00000000-0000-0000-0000-000000000803';
  intent1 uuid:='00000000-0000-0000-0000-000000000811';
  intent2 uuid:='00000000-0000-0000-0000-000000000812';
  intent3 uuid:='00000000-0000-0000-0000-000000000813';
  intent4 uuid:='00000000-0000-0000-0000-000000000814';
  snap jsonb:='{"title":"Disposable CMS article","summary":"A synthetic article used for isolated testing.","body_markdown":"A safe test body.","classification":"normal","featured":false,"sample":false}';
  core jsonb; envelope jsonb; receipt jsonb; hash text;
  expiry bigint:=pg_catalog.floor(pg_catalog.date_part('epoch',
    pg_catalog.clock_timestamp()+interval '2 minutes'))::bigint;
begin
  core:=pg_catalog.jsonb_build_object('kind','publish','article_id',article,
    'slug','cms-disposable-article','revision_id',rev1,'revision_hash',
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(snap::text,'UTF8')),'hex'),
    'generation',1);
  hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(core::text,'UTF8')),'hex');
  envelope:=core||pg_catalog.jsonb_build_object('intent_id',intent1,
    'payload_hash',hash,'snapshot',snap,'auth_expires_epoch',expiry,
    'auth_mac',cms_pub.cms_mac(intent1::text||':'||hash||':'||expiry::text));
  begin
    perform pub_admin.cms_apply(envelope||pg_catalog.jsonb_build_object(
      'auth_expires_epoch',expiry-3600));
    raise exception 'expired dispatch authorization accepted';
  exception when insufficient_privilege then null; end;
  receipt:=pub_admin.cms_apply(envelope);
  if receipt->>'intent_id'<>intent1::text or
    pub_admin.cms_apply(envelope)<>receipt then
    raise exception 'first delivery/idempotent retry failed'; end if;
  begin
    perform pub_admin.cms_apply(envelope||pg_catalog.jsonb_build_object('slug','cms-other-slug'));
    raise exception 'conflicting retry accepted';
  exception when insufficient_privilege or unique_violation then null; end;
  core:=core||pg_catalog.jsonb_build_object('generation',3,'revision_id',rev2);
  core:=core||pg_catalog.jsonb_build_object('revision_hash',
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(snap::text,'UTF8')),'hex'));
  envelope:=core||pg_catalog.jsonb_build_object('intent_id',intent2,
    'payload_hash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(core::text,'UTF8')),'hex'),
    'snapshot',snap,'auth_expires_epoch',expiry,
    'auth_mac',cms_pub.cms_mac(intent2::text||':'||
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(core::text,'UTF8')),'hex')||':'||expiry::text));
  perform pub_admin.cms_apply(envelope);
  if (select revision_id from cms_pub.articles where article_id=article)<>rev2 then
    raise exception 'signed newer generation was not published'; end if;
  core:=core||pg_catalog.jsonb_build_object('generation',2);
  envelope:=core||pg_catalog.jsonb_build_object('intent_id',intent4,
    'payload_hash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(core::text,'UTF8')),'hex'),
    'snapshot',snap,'auth_expires_epoch',expiry,
    'auth_mac',cms_pub.cms_mac(intent4::text||':'||
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(core::text,'UTF8')),'hex')||':'||expiry::text));
  begin
    perform pub_admin.cms_apply(envelope);
    raise exception 'stale lower generation accepted';
  exception when serialization_failure then null; end;
  if (select revision_id from cms_pub.articles where article_id=article)<>rev2 then
    raise exception 'failed delivery changed the published revision'; end if;
  core:=pg_catalog.jsonb_build_object('kind','unpublish','article_id',article,
    'slug','cms-disposable-article','generation',4);
  envelope:=core||pg_catalog.jsonb_build_object('intent_id',intent3,
    'payload_hash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(core::text,'UTF8')),'hex'),
    'auth_expires_epoch',expiry,
    'auth_mac',cms_pub.cms_mac(intent3::text||':'||
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(core::text,'UTF8')),'hex')||':'||expiry::text));
  receipt:=pub_admin.cms_apply(envelope);
  if pub_admin.cms_apply(envelope)<>receipt then
    raise exception 'unpublish retry changed receipt'; end if;
  begin
    perform pub_admin.cms_apply(core||pg_catalog.jsonb_build_object(
      'intent_id',pg_catalog.gen_random_uuid(),
      'payload_hash',pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(core::text,'UTF8')),'hex')));
    raise exception 'same-generation conflicting intent accepted';
 exception when serialization_failure or insufficient_privilege then null; end;
end $lifecycle$;
reset role;

set role foreverdb_web_reader;
do $reader$
begin
  if (web_api.cms_article('cms-disposable-article')->>'tombstone')<>'true'
     or exists(select 1 from web_api.cms_list(50,0))
     or (select count(*) from web_api.cms_list(1000,0))<>0 then
    raise exception 'tombstone or bounded reader failed'; end if;
end $reader$;
reset role;

do $evidence$
begin
  if (select count(*) from cms_pub.receipts)<>3
     or (select count(*) from cms_pub.revisions)<>2
     or (select generation from cms_pub.articles)<>4
     or (select revision_id from cms_pub.articles) is not null then
    raise exception 'public projection history or atomic pointer failed'; end if;
end $evidence$;

-- A compensation tombstone can arrive before an earlier signed publish.
-- A later legitimate publication must initialize its first public date.
begin;
set role foreverdb_pub_owner;
do $first_publish_after_tombstone$
declare article uuid:='00000000-0000-0000-0000-000000000821';
  revision uuid:='00000000-0000-0000-0000-000000000822';
  intent uuid:='00000000-0000-0000-0000-000000000823';
  expiry bigint:=pg_catalog.floor(pg_catalog.date_part('epoch',
    pg_catalog.clock_timestamp()+interval '2 minutes'))::bigint;
  core jsonb; payload_hash text; envelope jsonb;
  source_snapshot jsonb:='{"title":"After tombstone","summary":"Synthetic republish date test.","body_markdown":"Safe body.","classification":"normal","featured":false,"sample":false,"images":[{"path":"/content-images/cms-test.png","alt":"Synthetic test image","attribution":"Public attribution","rights_source":"private-licensing-contact@example.test","rights_license":"internal-contract-reference"}]}';
begin
  core:=pg_catalog.jsonb_build_object('kind','unpublish','article_id',article,
    'slug','cms-after-tombstone','generation',2);
  payload_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(core::text,'UTF8')),'hex');
  envelope:=core||pg_catalog.jsonb_build_object('intent_id',intent,
    'payload_hash',payload_hash,'auth_expires_epoch',expiry,
    'auth_mac',cms_pub.cms_mac(intent::text||':'||payload_hash||':'||expiry::text));
  perform pub_admin.cms_apply(envelope);
  if (select first_published_at from cms_pub.articles where article_id=article) is not null
    then raise exception 'tombstone invented a publication date'; end if;
  intent:='00000000-0000-0000-0000-000000000824';
  core:=pg_catalog.jsonb_build_object('kind','publish','article_id',article,
    'slug','cms-after-tombstone','revision_id',revision,'revision_hash',
    pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(source_snapshot::text,'UTF8')),'hex'),
    'generation',3);
  payload_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(core::text,'UTF8')),'hex');
  envelope:=core||pg_catalog.jsonb_build_object('intent_id',intent,
    'payload_hash',payload_hash,'snapshot',source_snapshot,'auth_expires_epoch',expiry,
    'auth_mac',cms_pub.cms_mac(intent::text||':'||payload_hash||':'||expiry::text));
  perform pub_admin.cms_apply(envelope);
  if (select first_published_at from cms_pub.articles where article_id=article) is null
    then raise exception 'first publication after tombstone has no public date'; end if;
  if exists(select 1 from cms_pub.revisions where article_id=article and
      (snapshot::text like '%private-licensing-contact%'
       or snapshot::text like '%internal-contract-reference%'
       or source_revision_hash<>pg_catalog.sha256(pg_catalog.convert_to(source_snapshot::text,'UTF8'))
       or snapshot_hash<>pg_catalog.sha256(pg_catalog.convert_to(snapshot::text,'UTF8'))))
    then raise exception 'public snapshot leaked private rights evidence or hash mismatch'; end if;
end $first_publish_after_tombstone$;
reset role;

set role foreverdb_web_reader;
do $dated_reader$
begin
  if web_api.cms_article('cms-after-tombstone')->>'published_at' is null or
     not exists(select 1 from web_api.cms_list(50,0) as item(value)
       where item.value->>'slug'='cms-after-tombstone'
         and item.value->>'published_at' is not null)
    then raise exception 'republished article is missing from dated public readers'; end if;
end $dated_reader$;
reset role;
rollback;
