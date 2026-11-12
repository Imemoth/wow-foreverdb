\set ON_ERROR_STOP on
-- The baseline fixture has two Owners and one Editor, all synthetic.
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000105","session_id":"00000000-0000-0000-0000-000000000205","aal":"aal2","exp":4102444800}';
do $t$ begin
  if public.fdb_admin_staff_prepare('00000000-0000-0000-0000-000000000104',
      'staff_onboarding')
     or public.fdb_admin_role_propose('00000000-0000-0000-0000-000000000104',
      'Administrator',90,'role_change') is not null then
    raise exception 'ordinary user obtained staff authority';
  end if;
end $t$;
reset role;

set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal1","exp":4102444800}';
do $t$ begin
  if public.fdb_admin_staff_prepare('00000000-0000-0000-0000-000000000104',
      'staff_onboarding') then raise exception 'AAL1 staff write'; end if;
end $t$;
reset role;

update auth.mfa_amr_claims set updated_at=clock_timestamp()-interval '16 minutes'
 where session_id='00000000-0000-0000-0000-000000000201';
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","iat":4102444700,"exp":4102444800}';
do $t$ begin
  if public.fdb_admin_staff_prepare('00000000-0000-0000-0000-000000000104',
      'staff_onboarding') then raise exception 'stale TOTP staff write'; end if;
end $t$;
reset role;
update auth.mfa_amr_claims set updated_at=clock_timestamp()
 where session_id='00000000-0000-0000-0000-000000000201';

update auth.sessions set not_after=clock_timestamp()-interval '1 second'
 where id='00000000-0000-0000-0000-000000000201';
set role authenticated;
do $t$ begin
  if public.fdb_admin_staff_prepare('00000000-0000-0000-0000-000000000104',
      'staff_onboarding') then raise exception 'expired Auth session staff write'; end if;
end $t$;
reset role;
update auth.sessions set not_after=null
 where id='00000000-0000-0000-0000-000000000201';

set role authenticated;
do $t$
declare target uuid:='00000000-0000-0000-0000-000000000103';
begin
  if public.fdb_admin_role_propose(target,null,30,'role_change') is not null
     or public.fdb_admin_role_propose(target,'Editor',31,'role_change') is not null
     or public.fdb_admin_grant_propose(target,'admin.enter','global',null,30,
       'grant_change') is not null
     or public.fdb_admin_grant_propose(target,'news.article.publish',
       'article','article-1',91,'grant_change') is not null
     or public.fdb_admin_grant_propose(target,'news.article.publish',
       'article',null,30,'grant_change') is not null
     or public.fdb_admin_grant_propose(target,'news.article.publish',
       'article','article-1',30,'secret_like_reason') is not null then
    raise exception 'role or grant ceiling failed';
  end if;
end $t$;
select public.fdb_admin_grant_propose(
  '00000000-0000-0000-0000-000000000103','news.article.publish',
  'article','article-1',30,'grant_change') as grant_id \gset
reset role;

set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_admin_grant_approve(:'grant_id'::uuid) as approved \gset
reset role;
do $t$ begin
  if not exists(select 1 from admin_private.direct_grants
       where user_id='00000000-0000-0000-0000-000000000103'
         and permission_key='news.article.publish' and status='active')
    then raise exception 'independent grant approval failed'; end if;
end $t$;

set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000103","session_id":"00000000-0000-0000-0000-000000000203","aal":"aal2","exp":4102444800}';
do $t$ begin
  if not admin_private.authorize_action('news.article.publish','staging',
      'article','article-1')
     or admin_private.authorize_action('news.article.publish','staging',
      'article','article-2')
     or admin_private.authorize_action('news.article.publish','production',
      'article','article-1') then
    raise exception 'scope/environment boundary failed';
  end if;
end $t$;
reset role;

-- Two *currently active* distinct Owners are required for Administrator
-- elevation. The proposer cannot approve their own proposal.
insert into admin_private.staff_subjects(user_id,status) values
 ('00000000-0000-0000-0000-000000000106','active');
insert into admin_private.role_assignments(user_id,role_name,policy_version_id,
 environment_scope,scope_kind,starts_at,review_due_at,status,approved_by,reason)
values('00000000-0000-0000-0000-000000000106','Owner',1,'staging','global',
 clock_timestamp()-interval '1 minute','infinity','active',
 '00000000-0000-0000-0000-000000000101','synthetic third owner');
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_admin_staff_prepare(
  '00000000-0000-0000-0000-000000000104','staff_onboarding') as prepared \gset
select public.fdb_admin_role_propose(
  '00000000-0000-0000-0000-000000000104','Administrator',90,
  'role_change') as admin_proposal \gset
select public.fdb_admin_role_approve(:'admin_proposal'::uuid) as self_approve \gset
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_admin_role_approve(:'admin_proposal'::uuid) as first_approve \gset
reset role;
do $t$ begin
  if exists(select 1 from admin_private.role_assignments where
      user_id='00000000-0000-0000-0000-000000000104'
      and role_name='Administrator' and status='active')
    then raise exception 'one Owner activated Administrator'; end if;
end $t$;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000106","session_id":"00000000-0000-0000-0000-000000000206","aal":"aal2","exp":4102444800}';
select public.fdb_admin_role_approve(:'admin_proposal'::uuid) as second_approve \gset
reset role;
do $t$ begin
  if not exists(select 1 from admin_private.role_assignments where
      user_id='00000000-0000-0000-0000-000000000104'
      and role_name='Administrator' and status='active')
    then raise exception 'two Owners did not activate Administrator'; end if;
end $t$;

-- An expired grant is denied immediately by the evaluator; the operator-only
-- expiry pass records the later durable revoked transition.
update admin_private.direct_grants
 set starts_at=clock_timestamp()-interval '2 days',
     expires_at=clock_timestamp()-interval '1 day'
 where grant_id=:'grant_id'::uuid;
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000103","session_id":"00000000-0000-0000-0000-000000000203","aal":"aal2","exp":4102444800}';
do $t$ begin
  if admin_private.authorize_action('news.article.publish','staging',
      'article','article-1') then raise exception 'expired grant authorized'; end if;
end $t$;
reset role;
select admin_private.expire_staff_authority() as expired_count \gset
do $t$ begin
  if not exists(select 1 from admin_private.staff_audit_events
      where action_key='staff.grant.expire')
     or exists(select 1 from admin_private.direct_grants
      where permission_key='news.article.publish' and status='active')
     then raise exception 'expired grant transition not audited'; end if;
end $t$;

-- A delegated Administrator approval grant cannot reinstate a suspended
-- Administrator, even when the subject's old assignment is revoked.
insert into admin_private.role_assignments(user_id,role_name,policy_version_id,
 environment_scope,scope_kind,starts_at,expires_at,review_due_at,status,
 approved_by,reason)
values('00000000-0000-0000-0000-000000000103','Administrator',1,
 'staging','global',clock_timestamp()-interval '1 minute',
 clock_timestamp()+interval '89 days',clock_timestamp()+interval '90 days',
 'active','00000000-0000-0000-0000-000000000102','synthetic delegated admin');
insert into admin_private.direct_grants(user_id,permission_key,
 policy_version_id,environment_scope,scope_kind,starts_at,expires_at,status,
 approved_by,reason)
values('00000000-0000-0000-0000-000000000103','staff.role.approve',1,
 'staging','global',clock_timestamp()-interval '1 minute',
 clock_timestamp()+interval '30 days','active',
 '00000000-0000-0000-0000-000000000102','synthetic delegation');
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_admin_staff_suspend(
  '00000000-0000-0000-0000-000000000104','emergency_revoke') as admin_suspended \gset
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000103","session_id":"00000000-0000-0000-0000-000000000203","aal":"aal2","exp":4102444800}';
select public.fdb_admin_staff_reinstate(
  '00000000-0000-0000-0000-000000000104','periodic_review') as delegated_reinstate \gset
reset role;
do $t$ begin
  if (select status from admin_private.staff_subjects
      where user_id='00000000-0000-0000-0000-000000000104')<>'suspended'
    then raise exception 'delegated Administrator crossed reinstatement ceiling'; end if;
end $t$;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_admin_staff_reinstate(
  '00000000-0000-0000-0000-000000000104','periodic_review') as owner_reinstate \gset
reset role;

-- Suspension revokes active and pending grants/assignments. Reinstatement
-- does not revive prior authority.
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_admin_grant_propose(
  '00000000-0000-0000-0000-000000000103','news.article.unpublish',
  'article','article-3',30,'grant_change') as pending_grant \gset
select public.fdb_admin_staff_suspend(
  '00000000-0000-0000-0000-000000000103','emergency_revoke') as suspended \gset
reset role;
select event_no as suspend_event from admin_private.staff_audit_events
 where action_key='staff.suspend'
   and target_id='00000000-0000-0000-0000-000000000103'
 order by event_no desc limit 1 \gset
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_admin_emergency_review(:'suspend_event'::bigint,true) as self_review \gset
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_admin_emergency_review(:'suspend_event'::bigint,true) as second_review \gset
reset role;
do $t$ begin
  if not exists(select 1 from admin_private.staff_emergency_reviews
      where target_id='00000000-0000-0000-0000-000000000103'
        and reviewer_id='00000000-0000-0000-0000-000000000102'
        and decision='accepted') then
    raise exception 'independent emergency review missing'; end if;
end $t$;
do $t$ begin
  if (select status from admin_private.staff_subjects
      where user_id='00000000-0000-0000-0000-000000000103')<>'suspended'
     or exists(select 1 from admin_private.direct_grants
       where user_id='00000000-0000-0000-0000-000000000103'
         and status in ('active','proposed'))
     or exists(select 1 from admin_private.role_assignments
       where user_id='00000000-0000-0000-0000-000000000103'
         and status in ('active','proposed')) then
    raise exception 'suspension left resumable authority'; end if;
end $t$;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_admin_staff_reinstate(
  '00000000-0000-0000-0000-000000000103','periodic_review') as reinstated \gset
select public.fdb_admin_grant_approve(:'pending_grant'::uuid) as stale_approval \gset
reset role;
set role admin_executor;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000103","session_id":"00000000-0000-0000-0000-000000000203","aal":"aal2","exp":4102444800}';
do $t$ begin
  if admin_private.authorize_action('news.article.publish','staging',
      'article','article-1') then raise exception 'old grant revived after reinstatement'; end if;
end $t$;
reset role;

-- Role revocation removes dependent grants. A later replacement assignment
-- cannot revive the old grant without a new two-person proposal.
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_admin_role_propose(
  '00000000-0000-0000-0000-000000000103','Editor',30,'role_change')
  as replacement_role \gset
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_admin_role_approve(:'replacement_role'::uuid) as replacement_approved \gset
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_admin_grant_propose(
  '00000000-0000-0000-0000-000000000103','news.article.publish',
  'article','article-2',30,'grant_change') as renewed_grant \gset
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000102","session_id":"00000000-0000-0000-0000-000000000202","aal":"aal2","exp":4102444800}';
select public.fdb_admin_grant_approve(:'renewed_grant'::uuid) as renewed_approved \gset
reset role;
set role authenticated;
set request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000201","aal":"aal2","exp":4102444800}';
select public.fdb_admin_role_revoke(:'replacement_role'::uuid,'emergency_revoke')
  as role_revoked \gset
reset role;
do $t$ begin
  if exists(select 1 from admin_private.direct_grants
    where user_id='00000000-0000-0000-0000-000000000103'
      and permission_key='news.article.publish' and status='active')
    then raise exception 'role revocation left dependent grant active'; end if;
end $t$;

-- Local hash is verifiable, but external immutable head anchoring remains an
-- activation gate. Application roles cannot UPDATE or DELETE audit rows.
do $t$
declare e record; expected bytea; payload jsonb;
begin
  for e in select * from admin_private.staff_audit_events order by event_no loop
    payload:=jsonb_build_object('n',e.event_no,'at',e.occurred_at,
      'actor',e.actor_id,'sid',e.session_id,'target',e.target_id,
      'action',e.action_key,'resource',e.resource_key,'policy',e.policy_version_id,
      'decision',e.decision,'outcome',e.outcome,'request',e.request_id,
      'before',e.before_state,'after',e.after_state,'reason',e.reason);
    expected:=sha256(e.previous_hash || convert_to(payload::text,'UTF8'));
    if expected is distinct from e.event_hash then
      raise exception 'audit payload/hash mismatch at %',e.event_no; end if;
  end loop;
end $t$;
