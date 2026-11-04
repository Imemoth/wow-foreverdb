-- News Collector V2 - G5b (US Dev Notes replies #7, #8, #9): READ-ONLY state capture. OPERATOR. Run as the platform admin.
-- Run it BEFORE the apply (pre-state: suppressed fingerprint, untouched fingerprint, tracked-topic ids) and right AFTER (its
-- `post_state_values` goes into news_v2_g5b_rollback.sql). Fingerprints (md5 of the full row text), ids and counts only.
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
       (select string_agg(format('(%L, %s, %L)', kind, id, h), E',\n' order by kind desc, id) from cur) as post_state_values;
