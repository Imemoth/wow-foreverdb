\set ON_ERROR_STOP on
-- Synthetic, disposable-only activation. Never run this file against hosted Auth.
insert into auth.users(id,email_confirmed_at) values
 ('00000000-0000-0000-0000-000000000101',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000102',clock_timestamp());
insert into auth.mfa_factors(id,user_id,factor_type,status) values
 ('00000000-0000-0000-0000-000000000301','00000000-0000-0000-0000-000000000101','totp','verified'),
 ('00000000-0000-0000-0000-000000000302','00000000-0000-0000-0000-000000000102','totp','verified');
insert into auth.sessions(id,user_id,factor_id,aal) values
 ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000301','aal2'),
 ('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-000000000302','aal2');
insert into auth.refresh_tokens(session_id) values
 ('00000000-0000-0000-0000-000000000201'),('00000000-0000-0000-0000-000000000202');
insert into auth.mfa_amr_claims(session_id,authentication_method,updated_at) values
 ('00000000-0000-0000-0000-000000000201','totp',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000202','totp',clock_timestamp());
insert into admin_private.staff_subjects(user_id,status) values
 ('00000000-0000-0000-0000-000000000101','active'),
 ('00000000-0000-0000-0000-000000000102','active');
insert into admin_private.role_assignments(user_id,role_name,policy_version_id,
 environment_scope,scope_kind,starts_at,expires_at,review_due_at,status,approved_by,reason)
values
 ('00000000-0000-0000-0000-000000000101','Editor',1,'staging','global',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days',clock_timestamp()+interval '30 days','active','00000000-0000-0000-0000-000000000102','fixture'),
 ('00000000-0000-0000-0000-000000000102','Owner',1,'staging','global',clock_timestamp()-interval '1 minute',null,clock_timestamp()+interval '30 days','active','00000000-0000-0000-0000-000000000101','fixture');
insert into admin_private.direct_grants(user_id,permission_key,policy_version_id,
 environment_scope,scope_kind,scope_id,starts_at,expires_at,status,approved_by,reason)
values('00000000-0000-0000-0000-000000000101','news.article.publish',1,'staging','article',
 '00000000-0000-0000-0000-000000000401',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days','active','00000000-0000-0000-0000-000000000102','fixture');
-- Inactive policy denies all even with synthetic staff, grants and valid MFA.
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $$ begin
  begin
    perform public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000401',
      'cms-test-article','{"title":"A test article","summary":"A synthetic summary with enough words.","body_markdown":"A draft body.","classification":"normal"}',
      '00000000-0000-0000-0000-000000000501');
    raise exception 'deny-all bypassed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
alter table admin_private.policy_versions disable trigger policy_versions_immutable;
update admin_private.policy_versions set approval_state='approved',activated_at=clock_timestamp() where version_id=1;
alter table admin_private.policy_versions enable trigger policy_versions_immutable;
alter table admin_private.active_policy disable trigger active_policy_immutable;
update admin_private.active_policy set version_id=1,epoch=1,activated_at=clock_timestamp() where singleton;
alter table admin_private.active_policy enable trigger active_policy_immutable;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $$ begin
 begin
  perform public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000409',
   'companion-guildbook-polish',
   '{"title":"Protected legacy slug","summary":"A synthetic legacy slug summary today.","body_markdown":"A body.","classification":"normal"}',
   '00000000-0000-0000-0000-000000000509');
  raise exception 'historical slug reused';
 exception when invalid_parameter_value then null; end;
end $$;
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000401',
  'cms-test-article','{"title":"A test article","summary":"A synthetic summary with enough words.","body_markdown":"A draft body.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000501');
do $$ begin
 if (public.fdb_cms_article('00000000-0000-0000-0000-000000000401')->>'slug')<>'cms-test-article'
    then raise exception 'authorized CMS read failed'; end if;
end $$;
reset role;
select current_revision_id as rev from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000401' \gset
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_cms_submit_review('00000000-0000-0000-0000-000000000401', :'rev',
  '00000000-0000-0000-0000-000000000502');
select public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000401', :'rev',
  '00000000-0000-0000-0000-000000000503');
reset role;
do $$ begin
 if (select count(*) from editorial_private.articles)<>1
   or (select count(*) from editorial_private.delivery_outbox where status='blocked')<>1
   or (select count(*) from editorial_private.publication_intents)<>1
   or (select count(*) from admin_private.staff_audit_events where action_key like 'news.%')<>3
 then raise exception 'CMS lifecycle not atomic'; end if;
end $$;
-- Highlighted flow: no self-approval, edits invalidate approval and publisher
-- must hold an individually scoped grant.
insert into admin_private.direct_grants(user_id,permission_key,policy_version_id,
 environment_scope,scope_kind,scope_id,starts_at,expires_at,status,approved_by,reason)
values
 ('00000000-0000-0000-0000-000000000101','news.article.approve_highlighted',1,'staging','article',
  '00000000-0000-0000-0000-000000000402',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days','active','00000000-0000-0000-0000-000000000102','fixture'),
 ('00000000-0000-0000-0000-000000000101','news.article.publish',1,'staging','article',
  '00000000-0000-0000-0000-000000000402',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days','active','00000000-0000-0000-0000-000000000102','fixture'),
 ('00000000-0000-0000-0000-000000000101','news.article.unpublish',1,'staging','article',
  '00000000-0000-0000-0000-000000000402',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days','active','00000000-0000-0000-0000-000000000102','fixture');
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000402',
  'cms-highlighted','{"title":"Highlighted test article","summary":"A synthetic highlighted summary for review.","body_markdown":"A highlighted body.","classification":"highlighted","featured":true}',
  '00000000-0000-0000-0000-000000000511');
reset role;
select current_revision_id as highrev from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000402' \gset
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_cms_submit_review('00000000-0000-0000-0000-000000000402', :'highrev',
  '00000000-0000-0000-0000-000000000512');
do $$ begin
 begin
  perform public.fdb_cms_approve_highlighted('00000000-0000-0000-0000-000000000402',
    (select current_revision_id from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000402'),
    '00000000-0000-0000-0000-000000000513');
  raise exception 'self approval bypassed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_cms_approve_highlighted('00000000-0000-0000-0000-000000000402', :'highrev',
  '00000000-0000-0000-0000-000000000514');
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $$ begin
 begin
  perform public.fdb_cms_edit_draft('00000000-0000-0000-0000-000000000402',
    (select current_revision_id from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000402'),
    '{"title":"Unsafe downgrade test","summary":"A synthetic downgrade summary for review.","body_markdown":"New body.","classification":"normal","featured":false}',
    '00000000-0000-0000-0000-000000000515');
  raise exception 'classification downgrade bypassed';
 exception when insufficient_privilege then null; end;
end $$;
select public.fdb_cms_edit_draft('00000000-0000-0000-0000-000000000402', :'highrev',
  '{"title":"Highlighted revised article","summary":"A synthetic revised summary for review.","body_markdown":"A materially revised body.","classification":"highlighted","featured":true}',
  '00000000-0000-0000-0000-000000000516');
reset role;
select current_revision_id as highrev2 from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000402' \gset
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $$ begin
 begin
  perform public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000402',
    (select current_revision_id from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000402'),
    '00000000-0000-0000-0000-000000000517');
  raise exception 'old approval reused after edit';
 exception when insufficient_privilege then null; end;
end $$;
select public.fdb_cms_submit_review('00000000-0000-0000-0000-000000000402', :'highrev2',
  '00000000-0000-0000-0000-000000000518');
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_cms_approve_highlighted('00000000-0000-0000-0000-000000000402', :'highrev2',
  '00000000-0000-0000-0000-000000000519');
do $$ begin
 begin
  perform public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000402',
    (select current_revision_id from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000402'),
    '00000000-0000-0000-0000-000000000520');
  raise exception 'approver published own approval';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000402', :'highrev2',
  '00000000-0000-0000-0000-000000000521');
select public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000402', :'highrev2',
  '00000000-0000-0000-0000-000000000521');
reset role;
do $$ begin
  if (select count(*) from editorial_private.publication_intents where article_id='00000000-0000-0000-0000-000000000402')<>1
     or (select count(*) from editorial_private.approval_uses)<>1
     or (select count(*) from editorial_private.revisions where article_id='00000000-0000-0000-0000-000000000402')<>2
     or (select count(*) from editorial_private.approvals where article_id='00000000-0000-0000-0000-000000000402')<>2 then
    raise exception 'revision approval or idempotency failure'; end if;
end $$;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_cms_unpublish_intent('00000000-0000-0000-0000-000000000402',
  '00000000-0000-0000-0000-000000000522');
reset role;
do $$ begin
  if (select count(*) from editorial_private.delivery_outbox where article_id='00000000-0000-0000-0000-000000000402')<>2
     or (select review_state from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000402')<>'unpublish_pending'
     then raise exception 'unpublish intent missing or delivered'; end if;
end $$;
-- A failing audit append must roll back a new article, its revision and slug.
create function public.cms_test_audit_failure() returns trigger language plpgsql as $$
begin raise exception 'synthetic audit failure' using errcode='23514'; end $$;
create trigger cms_test_audit_failure before insert on admin_private.staff_audit_events
 for each row execute function public.cms_test_audit_failure();
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $$ begin
 begin
  perform public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000403',
   'cms-audit-failure','{"title":"Rollback test article","summary":"A synthetic audit failure summary today.","body_markdown":"A body.","classification":"normal"}',
   '00000000-0000-0000-0000-000000000523');
  raise exception 'audit failure was ignored';
 exception when check_violation then null; end;
end $$;
reset role;
drop trigger cms_test_audit_failure on admin_private.staff_audit_events;
drop function public.cms_test_audit_failure();
do $$ begin
 if exists(select 1 from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000403')
    or exists(select 1 from editorial_private.slug_reservations where slug='cms-audit-failure')
    then raise exception 'audit failure left protected data'; end if;
end $$;
-- Server-side freshness and session liveness beat a forged AAL2 JWT.
update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '16 minutes'
 where session_id='00000000-0000-0000-0000-000000000201';
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $$ begin
 begin
  perform public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000404',
   'cms-stale-mfa','{"title":"Stale MFA article","summary":"A synthetic stale session summary today.","body_markdown":"A body.","classification":"normal"}',
   '00000000-0000-0000-0000-000000000524');
  raise exception 'stale MFA accepted';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
update auth.mfa_amr_claims set updated_at=clock_timestamp()
 where session_id='00000000-0000-0000-0000-000000000201';
delete from auth.refresh_tokens where session_id='00000000-0000-0000-0000-000000000201';
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $$ begin
 begin
  perform public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000405',
   'cms-dead-session','{"title":"Dead session article","summary":"A synthetic dead session summary today.","body_markdown":"A body.","classification":"normal"}',
   '00000000-0000-0000-0000-000000000525');
  raise exception 'dead session accepted';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
insert into auth.refresh_tokens(session_id) values('00000000-0000-0000-0000-000000000201');
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000406',
 'cms-concurrency','{"title":"Concurrent article","summary":"A synthetic concurrent edit summary today.","body_markdown":"A body.","classification":"normal"}',
 '00000000-0000-0000-0000-000000000526');
reset role;
-- An article outside the Editor's publishing grants cannot be sent, even if
-- the same account can author and submit it.
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
-- The fixture's Editor role has now expired in the concurrency test, which
-- runs later; this SQL file still executes before that test.
select public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000407',
 'cms-scope-denial','{"title":"Scoped article","summary":"A synthetic resource scope summary today.","body_markdown":"A body.","classification":"normal"}',
 '00000000-0000-0000-0000-000000000527');
reset role;
select current_revision_id as scopedrev from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000407' \gset
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_cms_submit_review('00000000-0000-0000-0000-000000000407', :'scopedrev',
 '00000000-0000-0000-0000-000000000528');
do $$ begin
 begin
  perform public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000407',
   (select current_revision_id from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000407'),
   '00000000-0000-0000-0000-000000000529');
  raise exception 'cross-resource publish allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Claims naming another user's live session are insufficient.
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
do $$ begin
 begin
  perform public.fdb_cms_create_draft('00000000-0000-0000-0000-000000000408',
   'cms-forged-session','{"title":"Forged session article","summary":"A synthetic forged session summary today.","body_markdown":"A body.","classification":"normal"}',
   '00000000-0000-0000-0000-000000000533');
  raise exception 'forged session allowed';
 exception when insufficient_privilege then null; end;
end $$;
reset role;
-- Outbox insertion failure must undo the state update and audit append.
insert into admin_private.direct_grants(user_id,permission_key,policy_version_id,
 environment_scope,scope_kind,scope_id,starts_at,expires_at,status,approved_by,reason)
values('00000000-0000-0000-0000-000000000101','news.article.unpublish',1,'staging','article',
 '00000000-0000-0000-0000-000000000401',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '29 days','active',
 '00000000-0000-0000-0000-000000000102','fixture');
create function public.cms_test_outbox_failure() returns trigger language plpgsql as $$
begin raise exception 'synthetic outbox failure' using errcode='23514'; end $$;
create trigger cms_test_outbox_failure before insert on editorial_private.delivery_outbox
 for each row execute function public.cms_test_outbox_failure();
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
do $$ begin
 begin
  perform public.fdb_cms_unpublish_intent('00000000-0000-0000-0000-000000000401',
    '00000000-0000-0000-0000-000000000534');
  raise exception 'outbox failure was ignored';
 exception when check_violation then null; end;
end $$;
reset role;
drop trigger cms_test_outbox_failure on editorial_private.delivery_outbox;
drop function public.cms_test_outbox_failure();
do $$ begin
 if (select review_state from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000401')<>'publish_pending'
    or (select generation from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000401')<>1
    or exists(select 1 from editorial_private.publication_intents where request_id='00000000-0000-0000-0000-000000000534')
    or exists(select 1 from admin_private.staff_audit_events where request_id='00000000-0000-0000-0000-000000000534')
    then raise exception 'outbox failure left protected state or audit'; end if;
end $$;
