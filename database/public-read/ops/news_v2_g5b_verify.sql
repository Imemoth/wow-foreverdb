-- News Collector V2 - G5b: READ-ONLY post-apply verification. OPERATOR. Run as the platform admin right after the apply. Every row must say PASS.
-- Also compare `untouched_fp`, `entries_total` (+3), `versions_total` (+3) and `suppressed_md5` of ops/news_v2_g5b_capture.sql before/after.
begin read only;
set local role foreverdb_pub_owner;
with w(source_entry_id, pn, pub) as (values
    ('post:30624529', 7, '2026-10-26 20:35:27.223+00'::timestamptz), ('post:30634848', 8, '2026-10-27 15:37:37.304+00'::timestamptz), ('post:30732723', 9, '2026-11-03 03:20:33.21+00'::timestamptz)),
legacy(source_entry_id) as (values ('post:30623027'), ('post:30638690'), ('post:30639364'), ('post:30640021'), ('post:30644593'))
select name as check_name, expected, actual, case when ok then 'PASS' else 'FAIL' end as result from (
    select 1 ord, 'the three replies exist with verified provenance and their ORIGINAL publication times' as name, '3' as expected,
           (select count(*)::text from pub.news_entries n join w using (source_entry_id) where n.source_key = 'blizzard-bluepost-us' and n.source_topic_id = 'topic:2360696' and n.source_post_number = w.pn
              and n.published_at = w.pub and n.author_user_id = 3390 and n.author_group = 'community-manager' and n.thread_origin = 'official' and n.status = 'published' and n.suppressed_at is null) as actual,
           (select count(*) from pub.news_entries n join w using (source_entry_id) where n.source_key = 'blizzard-bluepost-us' and n.source_topic_id = 'topic:2360696' and n.source_post_number = w.pn
              and n.published_at = w.pub and n.author_user_id = 3390 and n.author_group = 'community-manager' and n.thread_origin = 'official' and n.status = 'published' and n.suppressed_at is null) = 3 as ok
    union all select 2, 'topic 2360696 now holds the opener and replies #7, #8, #9, #10 (+ any later reply)', '>= 5',
           (select count(*)::text from pub.news_entries where source_key = 'blizzard-bluepost-us' and source_topic_id = 'topic:2360696' and suppressed_at is null and status = 'published'),
           (select count(*) from pub.news_entries where source_key = 'blizzard-bluepost-us' and source_topic_id = 'topic:2360696' and suppressed_at is null and status = 'published') >= 5
              and (select count(distinct source_post_number) from pub.news_entries where source_key = 'blizzard-bluepost-us' and source_topic_id = 'topic:2360696' and source_post_number in (1, 7, 8, 9, 10)) = 5
    union all select 3, 'exactly ONE card for the thread (US view)', '1',
           (select count(*)::text from web_api.news_cards(null, '', 'us', false, 50, 0) c where c.thread_key = 'us:topic:2360696'),
           (select count(*) from web_api.news_cards(null, '', 'us', false, 50, 0) c where c.thread_key = 'us:topic:2360696') = 1
    union all select 4, 'the five legacy rejected rows were NOT touched (still no provenance: no unrequested update)', '5',
           (select count(*)::text from pub.news_entries n join legacy l using (source_entry_id) where n.source_key = 'blizzard-bluepost-us' and n.author_user_id is null and n.status = 'rejected'),
           (select count(*) from pub.news_entries n join legacy l using (source_entry_id) where n.source_key = 'blizzard-bluepost-us' and n.author_user_id is null and n.status = 'rejected') = 5
    union all select 5, 'the tracked topic row contains all five post ids (opener, #7, #8, #9, #10)', 'true',
           (select (t.official_post_ids @> array[30185131, 30624529, 30634848, 30732723, 30756539]::bigint[])::text from pub.news_tracked_topics t where t.source_key = 'blizzard-bluepost-us' and t.topic_id = 'topic:2360696'),
           coalesce((select t.official_post_ids @> array[30185131, 30624529, 30634848, 30732723, 30756539]::bigint[] from pub.news_tracked_topics t where t.source_key = 'blizzard-bluepost-us' and t.topic_id = 'topic:2360696'), false)
    union all select 6, 'each new entry equals its first version snapshot publishedAt (immutable publication time)', '0 violations',
           (select count(*)::text from pub.news_entries n join lateral (select (v.snapshot ->> 'publishedAt')::timestamptz as p from pub.news_post_versions v where v.news_entry_id = n.id order by v.id limit 1) f on true
             where n.source_entry_id in (select source_entry_id from w) and n.source_key = 'blizzard-bluepost-us' and n.published_at <> f.p),
           (select count(*) from pub.news_entries n join lateral (select (v.snapshot ->> 'publishedAt')::timestamptz as p from pub.news_post_versions v where v.news_entry_id = n.id order by v.id limit 1) f on true
             where n.source_entry_id in (select source_entry_id from w) and n.source_key = 'blizzard-bluepost-us' and n.published_at <> f.p) = 0
    union all select 7, 'every US reply is by a verified US staff identity', '0',
           (select count(*)::text from pub.news_entries n where n.source_key = 'blizzard-bluepost-us' and n.source_post_number > 1 and n.author_user_id is not null
              and not exists (select 1 from pub.news_verified_staff st where st.source_key = n.source_key and st.user_id = n.author_user_id)),
           (select count(*) from pub.news_entries n where n.source_key = 'blizzard-bluepost-us' and n.source_post_number > 1 and n.author_user_id is not null
              and not exists (select 1 from pub.news_verified_staff st where st.source_key = n.source_key and st.user_id = n.author_user_id)) = 0
    union all select 8, 'exactly two new G5b backfill runs, both succeeded', '2',
           (select count(*)::text from pub.news_sync_runs where mode = 'backfill' and source_key = 'blizzard-bluepost-us' and status = 'succeeded' and started_at > now() - interval '2 hours'),
           (select count(*) from pub.news_sync_runs where mode = 'backfill' and source_key = 'blizzard-bluepost-us' and status = 'succeeded' and started_at > now() - interval '2 hours') = 2
) q order by ord;
rollback;
