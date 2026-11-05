-- News Collector V2 - G5b ROLLBACK / PARTIAL-APPLY RECOVERY (US Dev Notes replies #7, #8, #9). OPERATOR. Pure SQL, ONE transaction. Fail-closed.
--
-- Replaces the obsolete G5 rollback and the first G5b rollback (which assumed two succeeded runs and a byte-identical state). G5b only INSERTS
-- three entries, so this script works from the ACTUAL state, whatever subset of the two windows ran (A ok / B failed, B timed out with an unknown
-- outcome, B retried, a revision cycle touched a target, ...):
--   * it first LOCKS pub.news_sync_runs, news_entries, news_post_versions and news_tracked_topics in SHARE ROW EXCLUSIVE mode (readers - the website -
--     are not blocked; collector / revision writes wait). Every precondition below is evaluated AFTER the lock, so a concurrent collector operation
--     can neither slip a change between the checks and the deletes nor be half-visible to them. lock_timeout is 5 s: if a collector write holds a lock
--     the script FAILS (nothing changed) - retry in a quiet moment. Lock order runs -> entries -> versions -> tracked follows news_apply_sync.
--   * per target (post:30624529 #7, post:30634848 #8, post:30732723 #9) it classifies the live row:
--       absent     never inserted (e.g. window B failed)                              -> nothing to do
--       unchanged  inserted by G5b, ONE version, entry fingerprint = POST capture    -> deleted (entry + its versions) and its id removed from the tracked row
--       modified   a later legitimate change (revision cycle / retry edited it)      -> KEPT with its versions and its tracked id (policy 'keep'), or the whole
--                                                                                       script aborts (policy 'abort')
--       anything else aborts: the entry id <= PRE_MAX_ENTRY_ID (it existed before G5b: never ours), or it is not in the POST capture (stale capture).
--   * the G5b RUN RECORDS are discovered, not assumed: every backfill run of blizzard-bluepost-us with id > PRE_MAX_RUN_ID whose diagnostics carry one of the two
--     approved windows (any status: failed and retried runs included). That set must EQUAL the RUN_IDS you supply (an unlisted retry or a wrong id aborts);
--     a 'running' record or any other backfill run of this source after the PRE capture aborts. The run records are deleted only when no target is KEPT
--     (otherwise they stay as the audit trail of the kept rows).
--   * non-interference is PROVEN inside the transaction: a fingerprint of every other entry / version / tracked topic (the tracked row except its
--     official_post_ids) / sync run is taken under the lock before and after the deletes and must be identical. This replaces a fixed 'untouched' fingerprint,
--     so legitimate later changes (reply #11, a revision of #1 / #10, the tracked schedule) neither block the rollback nor are touched. Opener #1 and
--     Kaivax reply #10 are never touched.
-- NOT RESTORED: news_sources freshness, news_verified_staff.last_seen_at, tracked-topic scheduling columns, identity sequences (gaps), cron runs, net._http_response, caches.
-- HOW TO USE: take a fresh capture (ops/news_v2_g5b_capture.sql) with BACKFILL FLAG OFF and no apply in flight, then replace the five tokens between double
--   angle brackets: RUN_IDS = `g5b_run_ids` of the capture (comma separated, may be empty), PRE_MAX_ENTRY_ID / PRE_MAX_RUN_ID = `max_entry_id` / `max_run_id` of the PRE
--   capture, POST_STATE_VALUES = `post_state_values` of that fresh capture (verbatim), MODIFIED_POLICY = 'keep' or 'abort' (quoted).
begin;
set local role foreverdb_pub_owner;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

lock table pub.news_sync_runs, pub.news_entries, pub.news_post_versions, pub.news_tracked_topics in share row exclusive mode;
-- @after-lock

create temp table g_params on commit drop as
select array[<<RUN_IDS>>]::bigint[] as run_ids, <<PRE_MAX_ENTRY_ID>>::bigint as pre_max_entry, <<PRE_MAX_RUN_ID>>::bigint as pre_max_run, <<MODIFIED_POLICY>>::text as policy;
create temp table g_expect_post (kind text not null, id bigint not null, h text not null) on commit drop;
insert into g_expect_post (kind, id, h) values
<<POST_STATE_VALUES>>;

do $pre$
declare v_unlisted bigint[]; v_listed bigint[];
begin
    if (select policy from g_params) not in ('keep', 'abort') then raise exception 'rollback precondition failed: MODIFIED_POLICY must be keep or abort'; end if;
    if (select cardinality(run_ids) <> cardinality(array(select distinct x from unnest(run_ids) x)) from g_params) then
        raise exception 'rollback precondition failed: duplicate run ids';
    end if;
end
$pre$;

create temp table g_runs on commit drop as
select r.id, r.status from pub.news_sync_runs r, g_params p
where r.mode = 'backfill' and r.source_key = 'blizzard-bluepost-us' and r.id > p.pre_max_run
  and (r.diagnostics ->> 'since', r.diagnostics ->> 'until') in (('2026-10-26T19:00:00Z', '2026-10-27T18:00:00Z'), ('2026-11-03T03:00:00Z', '2026-11-03T04:00:00Z'));

do $runs$
begin
    if exists (select 1 from g_runs where status = 'running') then
        raise exception 'rollback precondition failed: a G5b run record is still running (an apply is in flight): wait, re-capture, retry';
    end if;
    if exists (select 1 from g_runs where id not in (select unnest(run_ids) from g_params)) or exists (select 1 from unnest((select run_ids from g_params)) x where x <> all (array(select id from g_runs))) then
        raise exception 'rollback precondition failed: the supplied run ids % are not exactly the G5b window runs found now % (a retry committed after the capture, or a wrong id)',
            (select run_ids from g_params), array(select id from g_runs order by id);
    end if;
    if exists (select 1 from pub.news_sync_runs r, g_params p where r.mode = 'backfill' and r.source_key = 'blizzard-bluepost-us' and r.id > p.pre_max_run and r.id <> all (array(select id from g_runs))) then
        raise exception 'rollback precondition failed: another backfill run of blizzard-bluepost-us was recorded after the PRE capture (not part of G5b): stop and review';
    end if;
end
$runs$;

create temp table g_state on commit drop as
with t(source_entry_id) as (values ('post:30624529'), ('post:30634848'), ('post:30732723')),
cur as (
    select t.source_entry_id, e.id as entry_id, e.content_hash, md5(e::text) as h_entry,
           (select count(*) from pub.news_post_versions v where v.news_entry_id = e.id) as n_versions,
           (select count(*) from pub.news_post_versions v where v.news_entry_id = e.id and v.content_hash = e.content_hash) as n_current_versions,
           (select md5(coalesce(string_agg(v.id || ':' || md5(v::text), ',' order by v.id), '')) from pub.news_post_versions v where v.news_entry_id = e.id) as h_versions
    from t left join pub.news_entries e on e.source_key = 'blizzard-bluepost-us' and e.source_entry_id = t.source_entry_id)
select c.source_entry_id, c.entry_id,
       case when c.entry_id is null then 'absent'
            when c.entry_id <= (select pre_max_entry from g_params) then 'preexisting'
            when not exists (select 1 from g_expect_post x where x.kind = 'entry' and x.id = c.entry_id) then 'stale'
            when c.h_entry = (select h from g_expect_post x where x.kind = 'entry' and x.id = c.entry_id)
             and c.n_versions = 1 and c.n_current_versions = 1
             and c.h_versions = (select md5(coalesce(string_agg(x.id || ':' || x.h, ',' order by x.id), '')) from g_expect_post x
                                  where x.kind = 'version' and x.id in (select v.id from pub.news_post_versions v where v.news_entry_id = c.entry_id))
            then 'unchanged'
            else 'modified' end as state
from cur c;

do $state$
declare v_unchanged integer; v_modified integer;
begin
    if exists (select 1 from g_state where state = 'preexisting') then
        raise exception 'rollback precondition failed: target % existed before G5b (entry id <= PRE_MAX_ENTRY_ID): it is not ours to delete', (select source_entry_id from g_state where state = 'preexisting' limit 1);
    end if;
    if exists (select 1 from g_state where state = 'stale') then
        raise exception 'rollback precondition failed: target % is not in the POST capture (the capture is stale: a window committed after it): re-capture and retry', (select source_entry_id from g_state where state = 'stale' limit 1);
    end if;
    select count(*) filter (where state = 'unchanged'), count(*) filter (where state = 'modified') into v_unchanged, v_modified from g_state;
    if v_modified > 0 and (select policy from g_params) = 'abort' then
        raise exception 'rollback precondition failed: target % changed since the post-apply capture (policy abort)', (select source_entry_id from g_state where state = 'modified' limit 1);
    end if;
    if v_unchanged = 0 and not exists (select 1 from g_runs) then
        raise exception 'rollback precondition failed: nothing to roll back (no unchanged target entry and no G5b run record)';
    end if;
    if v_unchanged > 0 and not exists (
        select 1 from pub.news_tracked_topics t where t.source_key = 'blizzard-bluepost-us' and t.topic_id = 'topic:2360696'
           and t.official_post_ids @> array(select substring(source_entry_id from 6)::bigint from g_state where state = 'unchanged')) then
        raise exception 'rollback precondition failed: the tracked row of topic 2360696 does not contain the target ids to remove';
    end if;
end
$state$;

create temp table g_plan on commit drop as
select (select coalesce(array_agg(entry_id), '{}') from g_state where state = 'unchanged') as del_entries,
       (select coalesce(array_agg(substring(source_entry_id from 6)::bigint), '{}') from g_state where state = 'unchanged') as del_post_ids,
       (select count(*) from g_state where state = 'modified') as kept,
       (select coalesce(array_agg(id), '{}') from g_runs) as run_ids_all;

-- Non-interference proof: fingerprint of everything the rollback must NOT touch, under the lock, before ...
create function pg_temp.untouched() returns text language sql as $f$
    select md5(
        coalesce((select string_agg(e::text, ';' order by e.id) from pub.news_entries e where e.id not in (select unnest(del_entries) from g_plan)), '') || '|' ||
        coalesce((select string_agg(v::text, ';' order by v.id) from pub.news_post_versions v where v.news_entry_id not in (select unnest(del_entries) from g_plan)), '') || '|' ||
        coalesce((select string_agg(t::text, ';' order by t.source_key, t.topic_id) from pub.news_tracked_topics t where not (t.source_key = 'blizzard-bluepost-us' and t.topic_id = 'topic:2360696')), '') || '|' ||
        coalesce((select string_agg((to_jsonb(t) - 'official_post_ids')::text, ';') from pub.news_tracked_topics t where t.source_key = 'blizzard-bluepost-us' and t.topic_id = 'topic:2360696'), '') || '|' ||
        coalesce((select string_agg(r::text, ';' order by r.id) from pub.news_sync_runs r where r.id not in (select unnest(run_ids_all) from g_plan)), ''))
$f$;
create temp table g_proof on commit drop as
select pg_temp.untouched() as before_fp,
       (select official_post_ids from pub.news_tracked_topics where source_key = 'blizzard-bluepost-us' and topic_id = 'topic:2360696') as before_ids,
       (select count(*) from pub.news_entries) as before_entries,
       (select count(*) from pub.news_sync_runs) as before_runs;

delete from pub.news_post_versions where news_entry_id in (select unnest(del_entries) from g_plan);
delete from pub.news_entries where id in (select unnest(del_entries) from g_plan) and source_key = 'blizzard-bluepost-us';
update pub.news_tracked_topics t set official_post_ids = array(select x from unnest(t.official_post_ids) x where x not in (select unnest(del_post_ids) from g_plan))
 where t.source_key = 'blizzard-bluepost-us' and t.topic_id = 'topic:2360696' and cardinality((select del_post_ids from g_plan)) > 0;
delete from pub.news_sync_runs where id in (select unnest(run_ids_all) from g_plan) and (select kept from g_plan) = 0;

-- ... and after: nothing else may have changed, and exactly the planned rows are gone.
do $post$
declare p g_plan%rowtype;
begin
    select * into p from g_plan;
    if pg_temp.untouched() is distinct from (select before_fp from g_proof) then
        raise exception 'rollback postcondition failed: a row outside the plan changed (fingerprint of untouched entries / versions / topics / runs differs)';
    end if;
    if (select count(*) from pub.news_entries) <> (select before_entries from g_proof) - cardinality(p.del_entries)
       or exists (select 1 from pub.news_entries e where e.id = any (p.del_entries))
       or exists (select 1 from pub.news_post_versions v where v.news_entry_id = any (p.del_entries)) then
        raise exception 'rollback postcondition failed: the planned entries / versions are not exactly gone';
    end if;
    if (select count(*) from pub.news_entries e where e.source_key = 'blizzard-bluepost-us' and e.source_entry_id in (select source_entry_id from g_state where state = 'modified')) <> p.kept then
        raise exception 'rollback postcondition failed: a modified target that had to be kept is missing';
    end if;
    if cardinality(p.del_post_ids) > 0 and (
        (select official_post_ids from pub.news_tracked_topics where source_key = 'blizzard-bluepost-us' and topic_id = 'topic:2360696')
        is distinct from array(select x from unnest((select before_ids from g_proof)) x where x <> all (p.del_post_ids))) then
        raise exception 'rollback postcondition failed: the tracked row must lose exactly the deleted target ids';
    end if;
    if (select count(*) from pub.news_sync_runs) <> (select before_runs from g_proof) - (p.kept = 0)::int * cardinality(p.run_ids_all) then
        raise exception 'rollback postcondition failed: unexpected number of run records removed';
    end if;
end
$post$;

select source_entry_id, state, case state when 'unchanged' then 'deleted' when 'modified' then 'KEPT (legitimate later change)' else 'nothing to do' end as action from g_state order by source_entry_id;
select (select count(*) from g_runs) as g5b_runs_found, case when (select kept from g_plan) = 0 then 'deleted' else 'kept (audit trail for kept rows)' end as run_records;
commit;
