-- News Collector V2 - G5 (US backfill): READ-ONLY state capture. OPERATOR. Run as the platform admin.
--
-- Run it TWICE: (1) immediately BEFORE the apply (pre-state evidence, suppressed fingerprint) and (2) immediately AFTER the apply
-- (its `post_state_values` output is pasted into the rollback script, which refuses to run unless the database still matches it).
-- Selects fingerprints (md5 of the full row text), ids and counts only: no excerpt text, no secret.
-- The ten posts are the agreed G5 write set (4 inserts + 6 updates on blizzard-bluepost-us).
with targets(source_entry_id) as (values
    ('post:30185131'), ('post:30624529'), ('post:30634848'), ('post:30732723'),
    ('post:30743268'), ('post:30623027'), ('post:30638690'), ('post:30639364'), ('post:30640021'), ('post:30644593')),
ids as (
    select e.id from pub.news_entries e join targets t using (source_entry_id) where e.source_key = 'blizzard-bluepost-us'),
cur as (
    select 'entry'::text as kind, e.id::bigint as id, md5(e::text) as h from pub.news_entries e where e.id in (select id from ids)
    union all
    select 'version', v.id::bigint, md5(v::text) from pub.news_post_versions v where v.news_entry_id in (select id from ids))
select (select count(*) from ids) as target_entries_present,
       (select count(*) from cur where kind = 'version') as target_versions,
       (select count(*) from pub.news_entries where source_key = 'blizzard-bluepost-us' and source_topic_id = 'topic:2360696') as us_topic_2360696_rows,
       (select count(*) from pub.news_entries where suppressed_at is not null) as suppressed_count,
       (select md5(coalesce(string_agg(id || '|' || suppressed_at::text || '|' || suppression_reason || '|' || content_hash, ';' order by id), ''))
          from pub.news_entries where suppressed_at is not null) as suppressed_md5,
       (select count(*) from pub.news_entries) as entries_total,
       (select count(*) from pub.news_post_versions) as versions_total,
       (select count(*) from pub.news_sync_runs where mode = 'backfill') as backfill_runs,
       (select string_agg(format('(%L, %s, %L)', kind, id, h), E',\n' order by kind desc, id) from cur) as post_state_values;
