\set ON_ERROR_STOP on
-- ADM-03B/03C hotfix, phase 2 (AFTER migration 0028): the two repaired functions, stale-revision semantics and fail-closed highlighted delivery.
\set c101 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}'
\set c104 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000104","session_id":"00000000-0000-0000-0000-000000000204","aal":"aal2","exp":4102444800}'
\set c105 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000105","session_id":"00000000-0000-0000-0000-000000000205","aal":"aal2","exp":4102444800}'

-- ---- the defects were really present before (reproduced by before.sql) ...
do $$ begin
  if (select v from repairtest.state where k='stale_edit_sqlstate_before')<>'40001' then perform repairtest.fail('baseline stale SQLSTATE'); end if;
  if (select v from repairtest.state where k='highlighted_qualify_sqlstate_before')<>'42702' then perform repairtest.fail('baseline ambiguity not reproduced'); end if;
end $$;

-- ---- ... and the repair changed EXACTLY the intended text, nothing else (owner, ACL, SECURITY DEFINER/INVOKER, search_path are preserved).
do $$
declare o record; n record; expected text;
begin
  select * into o from repairtest.fp where sig like 'editorial_private.run_action%';
  select p.oid::regprocedure::text sig,pg_get_userbyid(p.proowner) owner,coalesce(p.proacl::text,'') acl,p.prosecdef secdef,coalesce(p.proconfig,'{}'::text[]) config,p.prosrc src
    into n from pg_proc p where p.oid='editorial_private.run_action(text,uuid,uuid,jsonb,text,text,uuid)'::regprocedure;
  expected:=replace(o.src,$q$errcode='40001'$q$,$q$errcode='PT409'$q$);
  if n.src is distinct from expected or n.src=o.src then perform repairtest.fail('run_action differs from the old text by more than the two SQLSTATEs'); end if;
  if n.owner<>o.owner or n.acl<>o.acl or n.secdef<>o.secdef or n.config<>o.config or o.owner<>'admin_executor' or o.secdef or n.config<>array['search_path=""']
    then perform repairtest.fail('run_action owner/ACL/security/search_path changed'); end if;
  if n.src like '%40001%' then perform repairtest.fail('run_action still raises 40001'); end if;

  select * into o from repairtest.fp where sig='editorial_private.delivery_eligible(uuid)';
  select p.oid::regprocedure::text sig,pg_get_userbyid(p.proowner) owner,coalesce(p.proacl::text,'') acl,p.prosecdef secdef,coalesce(p.proconfig,'{}'::text[]) config,p.prosrc src
    into n from pg_proc p where p.oid='editorial_private.delivery_eligible(uuid)'::regprocedure;
  expected:=replace(o.src,
    $q$select ap.* into ap from editorial_private.approvals ap
        join editorial_private.approval_uses u on u.approval_id=ap.approval_id
        where u.intent_id=i.intent_id and ap.article_id=i.article_id
          and ap.revision_id=i.revision_id and ap.policy_version_id=pol;$q$,
    $q$select appr.* into ap from editorial_private.approvals appr
        join editorial_private.approval_uses u on u.approval_id=appr.approval_id
        where u.intent_id=i.intent_id and appr.article_id=i.article_id
          and appr.revision_id=i.revision_id and appr.policy_version_id=pol;$q$);
  if n.src is distinct from expected or n.src=o.src then perform repairtest.fail('delivery_eligible differs from the old text by more than the alias rename'); end if;
  if n.owner<>o.owner or n.acl<>o.acl or n.secdef<>o.secdef or n.config<>o.config or o.owner<>'admin_executor' or not o.secdef
    then perform repairtest.fail('delivery_eligible owner/ACL/security/search_path changed'); end if;
  -- the independence and eligibility checks are untouched
  if position('ap.approver_id=i.requested_by' in n.src)=0 or position('editorial_private.eligible_approver(ap.approver_id,i.article_id,pol,ap.grant_id)' in n.src)=0
    then perform repairtest.fail('approval independence / eligibility checks were altered'); end if;
  -- no API role gained any access to the repaired functions
  if has_function_privilege('authenticated','editorial_private.delivery_eligible(uuid)','EXECUTE')
     or has_function_privilege('anon','editorial_private.delivery_eligible(uuid)','EXECUTE')
     or has_function_privilege('azerdex_cms_dispatch','editorial_private.delivery_eligible(uuid)','EXECUTE')
     or has_function_privilege('authenticated','editorial_private.run_action(text,uuid,uuid,jsonb,text,text,uuid)','EXECUTE')
     or has_function_privilege('anon','editorial_private.run_action(text,uuid,uuid,jsonb,text,text,uuid)','EXECUTE')
    then perform repairtest.fail('an API role can execute an internal function'); end if;
  if exists(select 1 from pg_roles where rolname in ('admin_executor') and rolcanlogin) then perform repairtest.fail('executor can log in'); end if;
  if has_schema_privilege('admin_executor','editorial_private','CREATE')::text<>(select v from repairtest.state where k='executor_create')
     or pg_has_role('fdb_migrator','admin_executor','MEMBER')::text<>(select v from repairtest.state where k='executor_member')
    then perform repairtest.fail('migration left temporary privileges behind'); end if;
end $$;

-- ---- Fix 1: a stale edit / stale submit raises PT409 (never 40001), rolls back completely and does not touch the audit chain.
select count(*) as s_revs0 from editorial_private.revisions where article_id='00000000-0000-0000-0000-000000000701' \gset
select count(*) as s_events0 from admin_private.staff_audit_events \gset
select current_revision_id as s_head from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000701' \gset
select r.revision_id as s_r1 from editorial_private.revisions r where r.article_id='00000000-0000-0000-0000-000000000701' and r.revision_no=1 \gset
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
\set ON_ERROR_STOP off
select public.fdb_cms_edit_draft('00000000-0000-0000-0000-000000000701',:'s_r1',
  '{"title":"Stale after repair","summary":"A synthetic article for the stale revision regression.","body_markdown":"Stale body.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000821');
\set stale_edit :LAST_ERROR_SQLSTATE
select public.fdb_cms_submit_review('00000000-0000-0000-0000-000000000701',:'s_r1','00000000-0000-0000-0000-000000000822');
\set stale_submit :LAST_ERROR_SQLSTATE
\set ON_ERROR_STOP on
reset role;
select repairtest.fail('stale edit SQLSTATE '||:'stale_edit') where :'stale_edit'<>'PT409';
select repairtest.fail('stale submit SQLSTATE '||:'stale_submit') where :'stale_submit'<>'PT409';
select repairtest.fail('a stale request left state behind') where
     (select count(*) from editorial_private.revisions where article_id='00000000-0000-0000-0000-000000000701')<>:s_revs0
  or (select current_revision_id from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000701')<>:'s_head'::uuid
  or (select count(*) from admin_private.staff_audit_events)<>:s_events0
  or exists(select 1 from editorial_private.review_events where article_id='00000000-0000-0000-0000-000000000701' and decision='submit' and revision_id=:'s_r1'::uuid);
-- positive control: the same actor, from the CURRENT head, still edits and submits
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_edit_draft('00000000-0000-0000-0000-000000000701',:'s_head',
  '{"title":"Repair stale article v3","summary":"A synthetic article for the stale revision regression.","body_markdown":"Third body.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000823');
reset role;
select current_revision_id as s_head2 from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000701' \gset
select repairtest.fail('edit from the current head did not create a revision') where :'s_head2'=:'s_head';
-- an uneditable state (publish_pending) is also a controlled conflict, and the first conflict code is NOT a permission denial (42501 stays for denials)
set role authenticated;
select set_config('request.jwt.claims',:'c101',false);
select public.fdb_cms_submit_review('00000000-0000-0000-0000-000000000701',:'s_head2','00000000-0000-0000-0000-000000000824');
select public.fdb_cms_publish_intent('00000000-0000-0000-0000-000000000701',:'s_head2','00000000-0000-0000-0000-000000000825');
\set ON_ERROR_STOP off
select public.fdb_cms_edit_draft('00000000-0000-0000-0000-000000000701',:'s_head2',
  '{"title":"Edit while pending","summary":"A synthetic article for the stale revision regression.","body_markdown":"No.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000826');
\set uneditable :LAST_ERROR_SQLSTATE
\set ON_ERROR_STOP on
reset role;
select repairtest.fail('uneditable state SQLSTATE '||:'uneditable') where :'uneditable'<>'PT409';
-- a denied (unauthorised) actor still gets 42501, not the conflict code
set role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000103","session_id":"00000000-0000-0000-0000-000000000203","aal":"aal2","exp":4102444800}',false);
\set ON_ERROR_STOP off
select public.fdb_cms_edit_draft('00000000-0000-0000-0000-000000000701',:'s_r1',
  '{"title":"Unauthorised","summary":"A synthetic article for the stale revision regression.","body_markdown":"No.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000827');
\set denied :LAST_ERROR_SQLSTATE
\set ON_ERROR_STOP on
reset role;
select repairtest.fail('denial SQLSTATE '||:'denied') where :'denied'<>'42501';

-- ---- Fix 2: the highlighted publication now qualifies, claims and is eligible; independence and eligibility still fail CLOSED.
select intent_id as h_intent from editorial_private.publication_intents where request_id='00000000-0000-0000-0000-000000000814' \gset
-- (qualify/claim themselves are left to the real worker in cms-delivery/test/repair-worker.mjs: qualify mutates the ledger row to "eligible")
select repairtest.fail('highlighted intent is not eligible after the repair') where not editorial_private.delivery_eligible(:'h_intent'::uuid);
set role azerdex_cms_dispatch;
select repairtest.fail('highlighted intent is not a dispatch candidate') where not exists(select 1 from editorial_private.cms_dispatch_candidates(20) c where c=:'h_intent'::uuid);
reset role;

-- Variants use the helper variant.sql (a complete highlighted flow: author 101 creates and submits, :appr approves, 101 publishes) and then
-- break exactly one precondition of the approval. delivery_eligible must say NO for each, and the intent must never be qualifiable/claimable.

-- (a) the approver's authority ends before dispatch
\set article 00000000-0000-0000-0000-000000000704
\set slug repair-approver-revoked
\set appr :c105
\ir variant.sql
\set what 'approver-revoked'
select repairtest.fail('a legitimate independent approval is not eligible') where not editorial_private.delivery_eligible(:'v_intent'::uuid);
update admin_private.role_assignments set status='revoked',revoked_at=clock_timestamp()
  where user_id='00000000-0000-0000-0000-000000000105' and role_name='Administrator' and status='active';
select repairtest.fail('revoked approver still eligible') where editorial_private.delivery_eligible(:'v_intent'::uuid);
set role azerdex_cms_dispatch;
select repairtest.fail('revoked-approver intent is qualifiable') where editorial_private.cms_dispatch_qualify(:'v_intent'::uuid);
reset role;

-- (b) approver == requester (independence): tamper the immutable approval row (test-only, triggers disabled for the statement)
\set article 00000000-0000-0000-0000-000000000705
\set slug repair-approver-self
\set appr :c104
\ir variant.sql
select repairtest.fail('legitimate approval (b) not eligible') where not editorial_private.delivery_eligible(:'v_intent'::uuid);
alter table editorial_private.approvals disable trigger all;
update editorial_private.approvals set approver_id='00000000-0000-0000-0000-000000000101' where article_id=:'article'::uuid;
alter table editorial_private.approvals enable trigger all;
select repairtest.fail('self-approval is eligible') where editorial_private.delivery_eligible(:'v_intent'::uuid);

-- (c) the intent has no bound approval use
\set article 00000000-0000-0000-0000-000000000706
\set slug repair-approval-missing
\set appr :c104
\ir variant.sql
select repairtest.fail('legitimate approval (c) not eligible') where not editorial_private.delivery_eligible(:'v_intent'::uuid);
alter table editorial_private.approval_uses disable trigger all;
delete from editorial_private.approval_uses where intent_id=:'v_intent'::uuid;
alter table editorial_private.approval_uses enable trigger all;
select repairtest.fail('unbound approval is eligible') where editorial_private.delivery_eligible(:'v_intent'::uuid);

-- (d) a stale approval: the approval is for a DIFFERENT revision than the one being published
\set article 00000000-0000-0000-0000-000000000707
\set slug repair-approval-stale
\set appr :c104
\ir variant.sql
select repairtest.fail('legitimate approval (d) not eligible') where not editorial_private.delivery_eligible(:'v_intent'::uuid);
alter table editorial_private.approvals disable trigger all;
update editorial_private.approvals set revision_id=gen_random_uuid() where article_id=:'article'::uuid;
alter table editorial_private.approvals enable trigger all;
select repairtest.fail('approval of another revision is eligible') where editorial_private.delivery_eligible(:'v_intent'::uuid);

-- (e) the approver is suspended (staff status) after approving
\set article 00000000-0000-0000-0000-000000000708
\set slug repair-approver-suspended
\set appr :c104
\ir variant.sql
select repairtest.fail('legitimate approval (e) not eligible') where not editorial_private.delivery_eligible(:'v_intent'::uuid);
alter table admin_private.staff_subjects disable trigger all;
update admin_private.staff_subjects set status='suspended' where user_id='00000000-0000-0000-0000-000000000104';
alter table admin_private.staff_subjects enable trigger all;
select repairtest.fail('suspended approver is eligible') where editorial_private.delivery_eligible(:'v_intent'::uuid);
alter table admin_private.staff_subjects disable trigger all;
update admin_private.staff_subjects set status='active' where user_id='00000000-0000-0000-0000-000000000104';
alter table admin_private.staff_subjects enable trigger all;
