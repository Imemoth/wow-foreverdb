\set ON_ERROR_STOP on
-- Migrations 0027 (ADM-04 reads) and 0028 (ADM-03B/03C hotfix) TOGETHER, on the state reads.sql left behind (article a01 has revision 2; revision 1 is stale).
-- The stale revision must raise PT409 (never the PostgREST-retried 40001) through the very RPC the Admin UI calls, change nothing, and the 0027 reads
-- must still answer from the unchanged head.
\set e1 '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000101","session_id":"00000000-0000-0000-0000-000000000301","aal":"aal2","exp":4102444800}'
select r.revision_id as a1r1 from editorial_private.revisions r where r.article_id='00000000-0000-0000-0000-000000000a01' and r.revision_no=1 \gset
select current_revision_id as a1head from editorial_private.articles where article_id='00000000-0000-0000-0000-000000000a01' \gset
select count(*) as ev0 from admin_private.staff_audit_events \gset
select count(*) as rv0 from editorial_private.revisions where article_id='00000000-0000-0000-0000-000000000a01' \gset
set role authenticated;
select set_config('request.jwt.claims',:'e1',false);
\set ON_ERROR_STOP off
select public.fdb_cms_edit_draft('00000000-0000-0000-0000-000000000a01',:'a1r1',
  '{"title":"Stale after 0028","summary":"A synthetic normal summary for the read tests.","body_markdown":"Stale.","classification":"normal"}',
  '00000000-0000-0000-0000-000000000b90');
\set st :LAST_ERROR_SQLSTATE
\set ON_ERROR_STOP on
-- the read RPC still answers, from the unchanged head
select public.fdb_cms_article_detail('00000000-0000-0000-0000-000000000a01')->'article'->>'current_revision_id' as seen_head \gset
reset role;
select 1/(case when :'st'='PT409' then 1 else 0 end) as stale_is_pt409;
select 1/(case when :'seen_head'=:'a1head' then 1 else 0 end) as head_unchanged;
select 1/(case when (select count(*) from admin_private.staff_audit_events)=:ev0
              and (select count(*) from editorial_private.revisions where article_id='00000000-0000-0000-0000-000000000a01')=:rv0 then 1 else 0 end) as nothing_written;
-- both migrations leave the internal functions closed to the API roles
select 1/(case when not has_function_privilege('authenticated','editorial_private.run_action(text,uuid,uuid,jsonb,text,text,uuid)','EXECUTE')
              and not has_schema_privilege('authenticated','editorial_private','USAGE') then 1 else 0 end) as internals_closed;
