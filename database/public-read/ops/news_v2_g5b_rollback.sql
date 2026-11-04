-- News Collector V2 - G5b ROLLBACK (US Dev Notes replies #7, #8, #9). OPERATOR. Pure SQL (psql or SQL editor), one transaction. Fail-closed.
--
-- Replaces the obsolete G5 rollback (written when topic 2360696 had no rows: it deleted the tracked topic and restored legacy rows, which would now
-- destroy legitimate data). G5b only INSERTS three entries, so this rollback:
--   * deletes ONLY the three inserted entries (post:30624529, post:30634848, post:30732723) and their version rows;
--   * removes ONLY those three ids from pub.news_tracked_topics.official_post_ids of topic 2360696 (the row, its schedule and every other column stay);
--   * deletes EXACTLY the two G5b backfill run records you supply (never "all backfill runs").
-- It never touches the existing entries #1 / #10, the legacy rows, the Gamepad row or the suppressed rows.
-- PRECONDITIONS (abort, nothing changed): the two run ids are `mode='backfill'` succeeded runs of blizzard-bluepost-us; all three targets exist and
--   every target entry and version row fingerprints exactly as captured right after the apply (a later edit blocks the rollback); the tracked row
--   contains the three ids. A later UNRELATED change (e.g. a new reply #11) does not block it and survives.
-- POSTCONDITIONS (abort = nothing changed): targets and their versions gone, entries_total fell by 3, the three ids are gone from the tracked row,
--   the suppressed fingerprint is unchanged, exactly two backfill runs fewer.
-- NOT RESTORED: US news_sources freshness columns, news_verified_staff.last_seen_at, tracked-topic check scheduling (last_checked_at/next_check_at/state),
--   identity sequences (gaps), cron runs after the apply, net._http_response rows, website caches.
-- HOW TO USE: replace the four tokens between double angle brackets in the parameter block: RUN_IDS (two ids, comma separated), SUPPRESSED_MD5 (quoted)
--   and SUPPRESSED_COUNT from the PRE capture, POST_STATE_VALUES (the `post_state_values` column of the POST capture, verbatim).
begin;
set local role foreverdb_pub_owner;

create temp table g_params on commit drop as
select array[<<RUN_IDS>>]::bigint[] as run_ids, <<SUPPRESSED_MD5>>::text as suppressed_md5, <<SUPPRESSED_COUNT>>::integer as suppressed_count;
create temp table g_targets (source_entry_id text primary key) on commit drop;
insert into g_targets values ('post:30624529'), ('post:30634848'), ('post:30732723');
create temp table g_expect_post (kind text not null, id bigint not null, h text not null) on commit drop;
insert into g_expect_post (kind, id, h) values
<<POST_STATE_VALUES>>;

create temp table g_ids on commit drop as
select e.id from pub.news_entries e join g_targets t using (source_entry_id) where e.source_key = 'blizzard-bluepost-us';
create temp table g_cur on commit drop as
select 'entry'::text as kind, e.id::bigint as id, md5(e::text) as h from pub.news_entries e where e.id in (select id from g_ids)
union all
select 'version', v.id::bigint, md5(v::text) from pub.news_post_versions v where v.news_entry_id in (select id from g_ids);
create temp table g_state on commit drop as
select (select count(*) from pub.news_entries) as entries_before, (select count(*) from pub.news_sync_runs where mode = 'backfill') as runs_before;

do $g5b$
declare v_diff integer;
begin
    if (select cardinality(run_ids) from g_params) <> 2 then
        raise exception 'G5b rollback precondition failed: exactly two run ids are required';
    end if;
    if (select count(*) from pub.news_sync_runs r where r.id in (select unnest(run_ids) from g_params) and r.mode = 'backfill'
            and r.source_key = 'blizzard-bluepost-us' and r.status = 'succeeded') <> 2 then
        raise exception 'G5b rollback precondition failed: the run ids are not two succeeded backfill runs of blizzard-bluepost-us';
    end if;
    if (select count(*) from g_ids) <> 3 then
        raise exception 'G5b rollback precondition failed: expected the three inserted entries, found %', (select count(*) from g_ids);
    end if;
    select count(*) into v_diff from (
        (select kind, id, h from g_cur except select kind, id, h from g_expect_post)
        union all
        (select kind, id, h from g_expect_post except select kind, id, h from g_cur)) d;
    if v_diff <> 0 then
        raise exception 'G5b rollback precondition failed: % target row(s)/version(s) changed since the post-apply capture; refusing to overwrite legitimate later changes', v_diff;
    end if;
    if not exists (select 1 from pub.news_tracked_topics t where t.source_key = 'blizzard-bluepost-us' and t.topic_id = 'topic:2360696'
                    and t.official_post_ids @> array[30624529, 30634848, 30732723]::bigint[]) then
        raise exception 'G5b rollback precondition failed: the tracked topic row does not contain the three post ids';
    end if;
end
$g5b$;

delete from pub.news_post_versions where news_entry_id in (select id from g_ids);
delete from pub.news_entries where id in (select id from g_ids);
update pub.news_tracked_topics t
   set official_post_ids = coalesce((select array_agg(x order by x desc) from unnest(t.official_post_ids) x where x <> all (array[30624529, 30634848, 30732723]::bigint[])), '{}')
 where t.source_key = 'blizzard-bluepost-us' and t.topic_id = 'topic:2360696';
delete from pub.news_sync_runs where id in (select unnest(run_ids) from g_params) and mode = 'backfill' and source_key = 'blizzard-bluepost-us';

do $post$
begin
    if exists (select 1 from pub.news_entries where source_key = 'blizzard-bluepost-us' and source_entry_id in (select source_entry_id from g_targets)) then
        raise exception 'G5b rollback postcondition failed: a target entry is still present';
    end if;
    if (select entries_before from g_state) - (select count(*) from pub.news_entries) <> 3 then
        raise exception 'G5b rollback postcondition failed: entries_total did not fall by exactly 3';
    end if;
    if (select runs_before from g_state) - (select count(*) from pub.news_sync_runs where mode = 'backfill') <> 2 then
        raise exception 'G5b rollback postcondition failed: exactly two backfill run records must be gone';
    end if;
    if exists (select 1 from pub.news_tracked_topics t where t.source_key = 'blizzard-bluepost-us' and t.topic_id = 'topic:2360696' and t.official_post_ids && array[30624529, 30634848, 30732723]::bigint[])
       or not exists (select 1 from pub.news_tracked_topics t where t.source_key = 'blizzard-bluepost-us' and t.topic_id = 'topic:2360696') then
        raise exception 'G5b rollback postcondition failed: the tracked topic row is wrong';
    end if;
    if (select count(*) from pub.news_entries where suppressed_at is not null) <> (select suppressed_count from g_params)
       or (select md5(coalesce(string_agg(id || '|' || suppressed_at::text || '|' || suppression_reason || '|' || content_hash, ';' order by id), ''))
             from pub.news_entries where suppressed_at is not null) <> (select suppressed_md5 from g_params) then
        raise exception 'G5b rollback postcondition failed: the suppressed-row fingerprint changed';
    end if;
end
$post$;

commit;
