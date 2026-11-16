select intent_id as cms_intent from editorial_private.publication_intents
  where request_id='00000000-0000-0000-0000-000000000503' \gset
select intent_id as old_intent from editorial_private.publication_intents
  where article_id='00000000-0000-0000-0000-000000000402' and generation=1 \gset
set role azerdex_cms_dispatch;
select 1/(case when editorial_private.cms_dispatch_qualify(:'cms_intent'::uuid)
  then 0 else 1 end);
reset role;
update editorial_private.delivery_control set enabled=true,
  reviewed_config_id='00000000-0000-0000-0000-000000000901' where singleton;
set role azerdex_cms_dispatch;
select 1/(case when not exists(
  select 1 from editorial_private.cms_dispatch_candidates(20) c
    where c=:'old_intent'::uuid) then 1 else 0 end);
reset role;
set role azerdex_cms_dispatch;
select 1/(case when editorial_private.cms_dispatch_qualify(:'cms_intent'::uuid)
  then 1 else 0 end);
select (editorial_private.cms_dispatch_claim(:'cms_intent'::uuid)->>'claim_token') as cms_token \gset
select 1/(case when editorial_private.cms_dispatch_recheck(:'cms_intent'::uuid,:'cms_token'::uuid)
  then 1 else 0 end);
reset role;
update admin_private.direct_grants set status='revoked',revoked_at=pg_catalog.clock_timestamp()
 where user_id='00000000-0000-0000-0000-000000000101'
   and permission_key='news.article.publish'
   and scope_id='00000000-0000-0000-0000-000000000401';
set role azerdex_cms_dispatch;
select 1/(case when editorial_private.cms_dispatch_recheck(:'cms_intent'::uuid,:'cms_token'::uuid)
  then 0 else 1 end);
reset role;
