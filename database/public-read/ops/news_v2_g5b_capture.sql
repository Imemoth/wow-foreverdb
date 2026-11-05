-- News Collector V2 - G5b (US Dev Notes replies #7, #8, #9): READ-ONLY state capture. OPERATOR. Run as the platform admin.
-- Run it BEFORE the apply (pre-state: suppressed fingerprint, untouched fingerprint, tracked-topic ids, `max_entry_id`, `max_run_id`) and after EVERY step /
-- before any rollback (its `post_state_values` and `g5b_run_ids` go into news_v2_g5b_rollback.sql). Fingerprints (md5 of the full row text), ids and counts only.
-- Write set: INSERT of post:30624529 (#7), post:30634848 (#8), post:30732723 (#9) in US topic 2360696 (window A: 2026-10-26T19:00Z-2026-10-27T18:00Z
-- gives #7 + #8; window B: 2026-11-03T03:00Z-04:00Z gives #9). No update to any existing entry is expected.
with targets(source_entry_id) as (values ('post:30624529'), ('post:30634848'), ('post:30732723')),
ids as (select e.id from pub.news_entries e join targets t using (source_entry_id) where e.source_key = 'blizzard-bluepost-us'),
cur as (
    select 'entry'::text as kind, e.id::bigint as id, md5(e::text) as h from pub.news_entries e where e.id in (select id from ids)
    union all
    select 'version', v.id::bigint, md5(v::text) from pub.news_post_versions v where v.news_entry_id in (select id from ids)),
untouched as (
    -- every OTHER US entry the apply must leave alone: the whole Dev Notes thread except the targets, the five legacy rejected rows, the Gamepad row
    select e.id, e::text as t from pub.news_entries e
    where e.source_key = 'blizzard-bluepost-us'
      and (e.source_topic_id = 'topic:2360696' or e.source_entry_id in ('post:30623027','post:30638690','post:30639364','post:30640021','post:30644593','post:30743268'))
      and e.id not in (select id from ids))
select (select count(*) from ids) as targets_present,
       (select count(*) from pub.news_entries where source_key = 'blizzard-bluepost-us' and source_topic_id = 'topic:2360696') as us_topic_2360696_rows,
       (select md5(coalesce(string_agg(t, ';' order by id), '')) from untouched) as untouched_fp,
       (select count(*) from untouched) as untouched_rows,
       (select official_post_ids::text from pub.news_tracked_topics where source_key = 'blizzard-bluepost-us' and topic_id = 'topic:2360696') as tracked_official_post_ids,
       (select count(*) from pub.news_entries where suppressed_at is not null) as suppressed_count,
       (select md5(coalesce(string_agg(id || '|' || suppressed_at::text || '|' || suppression_reason || '|' || content_hash, ';' order by id), ''))
          from pub.news_entries where suppressed_at is not null) as suppressed_md5,
       (select count(*) from pub.news_entries) as entries_total,
       (select count(*) from pub.news_post_versions) as versions_total,
       (select count(*) from pub.news_sync_runs where mode = 'backfill') as backfill_runs,
       -- ONE line, always starts with a sentinel so it is never empty (partial states have fewer than three targets)
       (select string_agg(format('(%L, %s, %L)', kind, id, h), ', ' order by kind desc, id) from (select 'none'::text as kind, 0::bigint as id, ''::text as h union all select kind, id, h from cur) q) as post_state_values,
       -- IDENTITY HIGH-WATER MARKS: take the PRE capture right before the apply. A target whose entry id is <= pre_max_entry_id existed before G5b and is never deleted.
       (select coalesce(max(id), 0) from pub.news_entries) as max_entry_id,
       (select coalesce(max(id), 0) from pub.news_sync_runs) as max_run_id,
       -- every backfill run of the US source recorded for one of the two approved windows (ANY status: failed and retried runs included).
       (select coalesce(string_agg(r.id::text, ', ' order by r.id), '') from pub.news_sync_runs r
         where r.mode = 'backfill' and r.source_key = 'blizzard-bluepost-us'
           and (r.diagnostics ->> 'since', r.diagnostics ->> 'until') in (('2026-10-26T19:00:00Z', '2026-10-27T18:00:00Z'), ('2026-11-03T03:00:00Z', '2026-11-03T04:00:00Z'))) as g5b_run_ids,
       (select coalesce(string_agg(r.id || ':' || r.status || ':' || coalesce(r.diagnostics ->> 'since', '?'), ', ' order by r.id), '') from pub.news_sync_runs r
         where r.mode = 'backfill' and r.source_key = 'blizzard-bluepost-us'
           and (r.diagnostics ->> 'since', r.diagnostics ->> 'until') in (('2026-10-26T19:00:00Z', '2026-10-27T18:00:00Z'), ('2026-11-03T03:00:00Z', '2026-11-03T04:00:00Z'))) as g5b_runs_detail;
