-- News Collector V2 - G5 (US backfill): READ-ONLY post-apply verification. OPERATOR. Run as the platform admin right after the apply.
-- Every row must say PASS. Independent of database size (no absolute card/entry totals: compare those with the capture outputs).
-- Selects names, counts, ids and timestamps only (no excerpt text, no secret).
begin read only;
set local role foreverdb_pub_owner;

with w(source_entry_id, pn, pub, uid, grp) as (values
    ('post:30185131', 1, '2026-09-24 22:23:24.849+00'::timestamptz, 3390, 'community-manager'),
    ('post:30624529', 7, '2026-10-26 20:35:27.223+00', 3390, 'community-manager'),
    ('post:30634848', 8, '2026-10-27 15:37:37.304+00', 3390, 'community-manager'),
    ('post:30732723', 9, '2026-11-03 03:20:33.21+00', 3390, 'community-manager')),
legacy(source_entry_id, pub, ing, title_md5, excerpt_md5, uid, grp) as (values
    ('post:30623027', '2026-10-26 18:00:12.133+00'::timestamptz, '2026-10-26 18:10:02.251988+00'::timestamptz, 'aec06c063a', '4c953c8046', 520262, 'api_users'),
    ('post:30638690', '2026-10-27 19:30:27.238+00', '2026-10-27 19:40:02.444581+00', 'd36729a5a8', 'e14e200a2e', 520262, 'api_users'),
    ('post:30639364', '2026-10-27 20:02:47.505+00', '2026-10-27 20:10:03.561174+00', '92199a39c5', '2740db0121', 3390, 'community-manager'),
    ('post:30640021', '2026-10-27 20:14:19.238+00', '2026-10-27 20:20:04.811231+00', 'd4667f8dd2', '53d9d5f5df', 520262, 'api_users'),
    ('post:30644593', '2026-10-27 21:52:26.003+00', '2026-10-27 22:00:03.377007+00', '72d7b0e427', '746998923a', 3390, 'community-manager')),
cards as (select * from web_api.news_cards(null, '', null, false, 50, 0)
          union all select * from web_api.news_cards(null, '', null, false, 50, 50)
          union all select * from web_api.news_cards(null, '', null, false, 50, 100)
          union all select * from web_api.news_cards(null, '', null, false, 50, 150))
select name as check_name, expected, actual, case when ok then 'PASS' else 'FAIL' end as result from (
    select 1 ord, 'the four Dev Notes rows exist with verified provenance and their ORIGINAL publication times' as name, '4' as expected,
           (select count(*)::text from pub.news_entries n join w using (source_entry_id)
             where n.source_key = 'blizzard-bluepost-us' and n.source_topic_id = 'topic:2360696' and n.source_post_number = w.pn and n.published_at = w.pub
               and n.author_user_id = w.uid and n.author_group = w.grp and n.thread_origin = 'official' and n.status = 'published' and n.suppressed_at is null) as actual,
           (select count(*) from pub.news_entries n join w using (source_entry_id)
             where n.source_key = 'blizzard-bluepost-us' and n.source_topic_id = 'topic:2360696' and n.source_post_number = w.pn and n.published_at = w.pub
               and n.author_user_id = w.uid and n.author_group = w.grp and n.thread_origin = 'official' and n.status = 'published' and n.suppressed_at is null) = 4 as ok
    union all select 2, 'topic 2360696 holds exactly those four rows', '4',
           (select count(*)::text from pub.news_entries where source_key = 'blizzard-bluepost-us' and source_topic_id = 'topic:2360696'),
           (select count(*) from pub.news_entries where source_key = 'blizzard-bluepost-us' and source_topic_id = 'topic:2360696') = 4
    union all select 3, 'one card for us:topic:2360696, represented by reply #9, updated >= Nov 4 02:12:27 UTC', '1',
           (select count(*)::text from cards where thread_key = 'us:topic:2360696' and source_post_number = 9 and official_updated_at >= '2026-11-04 02:12:27.46+00'),
           (select count(*) from cards where thread_key = 'us:topic:2360696' and source_post_number = 9 and official_updated_at >= '2026-11-04 02:12:27.46+00') = 1
              and (select count(*) from cards where thread_key = 'us:topic:2360696') = 1
    union all select 4, 'no thread has more than one card (NULL thread keys = Official News are not threads)', '0',
           (select count(*)::text from (select thread_key from cards where thread_key is not null group by 1 having count(*) > 1) d),
           (select count(*) from (select thread_key from cards where thread_key is not null group by 1 having count(*) > 1) d) = 0
    union all select 5, 'five legacy rows: provenance added; status/relevance/publication+ingestion time/title/excerpt/slug/importance/featured UNCHANGED; still rejected',
           '5',
           (select count(*)::text from pub.news_entries n join legacy l using (source_entry_id)
             where n.source_key = 'blizzard-bluepost-us' and n.status = 'rejected' and n.relevance = 'irrelevant' and n.published_at = l.pub and n.ingested_at = l.ing
               and left(md5(n.title), 10) = l.title_md5 and left(md5(n.excerpt), 10) = l.excerpt_md5 and n.importance = 0 and n.featured = false and n.suppressed_at is null
               and n.author_user_id = l.uid and n.author_group = l.grp and n.thread_origin = 'official' and n.observed_via = 'feed'
               and n.modified_at is null and n.official_updated_at is null and n.source_version is null),
           (select count(*) from pub.news_entries n join legacy l using (source_entry_id)
             where n.source_key = 'blizzard-bluepost-us' and n.status = 'rejected' and n.relevance = 'irrelevant' and n.published_at = l.pub and n.ingested_at = l.ing
               and left(md5(n.title), 10) = l.title_md5 and left(md5(n.excerpt), 10) = l.excerpt_md5 and n.importance = 0 and n.featured = false and n.suppressed_at is null
               and n.author_user_id = l.uid and n.author_group = l.grp and n.thread_origin = 'official' and n.observed_via = 'feed'
               and n.modified_at is null and n.official_updated_at is null and n.source_version is null) = 5
    union all select 6, 'the five legacy rows are still invisible on the site', '0',
           (select count(*)::text from pub.news_card_entries c join legacy l on true join pub.news_entries n on n.id = c.id and n.source_entry_id = l.source_entry_id and n.source_key = 'blizzard-bluepost-us'),
           (select count(*) from pub.news_card_entries c join legacy l on true join pub.news_entries n on n.id = c.id and n.source_entry_id = l.source_entry_id and n.source_key = 'blizzard-bluepost-us') = 0
    union all select 7, 'Gamepad post 30743268: original publication and ingestion time unchanged', '1',
           (select count(*)::text from pub.news_entries where source_key = 'blizzard-bluepost-us' and source_entry_id = 'post:30743268'
              and published_at = '2026-11-03 20:00:09.24+00' and ingested_at = '2026-11-03 20:10:03.573543+00' and status = 'published'),
           (select count(*) from pub.news_entries where source_key = 'blizzard-bluepost-us' and source_entry_id = 'post:30743268'
              and published_at = '2026-11-03 20:00:09.24+00' and ingested_at = '2026-11-03 20:10:03.573543+00' and status = 'published') = 1
    union all select 8, 'every write-set entry still equals its first version snapshot publishedAt (immutable publication time)', '0 violations',
           (select count(*)::text from pub.news_entries n
              join lateral (select (v.snapshot ->> 'publishedAt')::timestamptz as first_pub from pub.news_post_versions v where v.news_entry_id = n.id order by v.id asc limit 1) f on true
             where n.source_key = 'blizzard-bluepost-us' and n.source_entry_id in ('post:30185131','post:30624529','post:30634848','post:30732723','post:30743268','post:30623027','post:30638690','post:30639364','post:30640021','post:30644593')
               and n.published_at <> f.first_pub),
           (select count(*) from pub.news_entries n
              join lateral (select (v.snapshot ->> 'publishedAt')::timestamptz as first_pub from pub.news_post_versions v where v.news_entry_id = n.id order by v.id asc limit 1) f on true
             where n.source_key = 'blizzard-bluepost-us' and n.source_entry_id in ('post:30185131','post:30624529','post:30634848','post:30732723','post:30743268','post:30623027','post:30638690','post:30639364','post:30640021','post:30644593')
               and n.published_at <> f.first_pub) = 0
    union all select 9, 'every US reply is by a verified US staff identity', '0',
           (select count(*)::text from pub.news_entries n where n.source_key = 'blizzard-bluepost-us' and n.source_post_number > 1 and n.author_user_id is not null
              and not exists (select 1 from pub.news_verified_staff st where st.source_key = n.source_key and st.user_id = n.author_user_id)),
           (select count(*) from pub.news_entries n where n.source_key = 'blizzard-bluepost-us' and n.source_post_number > 1 and n.author_user_id is not null
              and not exists (select 1 from pub.news_verified_staff st where st.source_key = n.source_key and st.user_id = n.author_user_id)) = 0
    union all select 10, 'no suppressed row carries V2 provenance or lost its marker', '0',
           (select count(*)::text from pub.news_entries n where n.suppression_reason like 'bluepost_reply_dedup_v1:%' and (n.suppressed_at is null or n.author_user_id is not null or n.observed_via is not null)),
           (select count(*) from pub.news_entries n where n.suppression_reason like 'bluepost_reply_dedup_v1:%' and (n.suppressed_at is null or n.author_user_id is not null or n.observed_via is not null)) = 0
    union all select 11, 'exactly one new G5 backfill run exists and it succeeded', '1 run (mode backfill, blizzard-bluepost-us, succeeded)',
           (select count(*)::text from pub.news_sync_runs where mode = 'backfill' and source_key = 'blizzard-bluepost-us' and status = 'succeeded' and started_at > now() - interval '2 hours'),
           (select count(*) from pub.news_sync_runs where mode = 'backfill' and source_key = 'blizzard-bluepost-us' and status = 'succeeded' and started_at > now() - interval '2 hours') = 1
) q order by ord;
rollback;
