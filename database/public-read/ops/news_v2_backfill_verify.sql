-- News Collector V2 backfill: READ-ONLY verification. OPERATOR. Run as the platform admin before and after the backfill and
-- keep both outputs in the change record. Selects counts, ids and timestamps only (no excerpt text, no secret).
-- Window: 2026-10-30 .. 2026-11-03 inclusive (UTC). Edit :since / :until to reuse for another window.

\set since '2026-10-30T00:00:00Z'
\set until '2026-11-04T00:00:00Z'

begin read only;
set local role foreverdb_pub_owner;

-- 1. Inventory of News records whose original publication OR latest verified official update falls inside the window.
select n.source_key, n.source_topic_id, n.source_post_number as post, n.status,
       case when n.suppressed_at is not null then 'suppressed' else 'live' end as marker,
       n.author_user_id, n.thread_origin, n.observed_via,
       n.published_at, n.official_updated_at, n.ingested_at,
       (select count(*) from pub.news_post_versions v where v.news_entry_id = n.id) as versions
  from pub.news_entries n
 where (n.published_at >= :'since'::timestamptz and n.published_at < :'until'::timestamptz)
    or (n.official_updated_at >= :'since'::timestamptz and n.official_updated_at < :'until'::timestamptz)
 order by n.source_key, n.source_topic_id, n.source_post_number;

-- 2. The two Dev Notes threads the investigation is about (US topic 2360696, EU topic 631316), every stored post.
select n.source_key, n.source_topic_id, n.source_post_number as post, n.status,
       (n.suppressed_at is not null) as suppressed, n.published_at, n.official_updated_at
  from pub.news_entries n
 where n.source_topic_id in ('topic:2360696', 'topic:631316')
 order by n.source_key, n.source_post_number;

-- 3. INVARIANTS - every query below must return ZERO rows (a non-empty result is a stop-the-line finding).
-- 3a. A visible reply without complete verified provenance.
select 'visible_reply_without_provenance' as violation, n.id, n.source_key, n.source_entry_id
  from pub.news_entries n join pub.news_sources s using (source_key)
 where s.source_type = 'bluepost' and n.source_post_number > 1 and n.status = 'published' and n.suppressed_at is null
   and (n.author_user_id is null or n.author_group is null or n.thread_origin is null)
   and exists (select 1 from pub.news_card_entries c where c.id = n.id);
-- 3b. A reply whose author id is not a verified staff identity of THAT region.
select 'reply_by_unverified_identity' as violation, n.id, n.source_key, n.source_entry_id
  from pub.news_entries n
 where n.source_post_number > 1 and n.author_user_id is not null
   and not exists (select 1 from pub.news_verified_staff st where st.source_key = n.source_key and st.user_id = n.author_user_id);
-- 3c. More than one card per region/topic (cannot happen by construction; asserted on the real data).
select 'duplicate_cards_for_thread' as violation, c.thread_key, count(*)
  from web_api.news_cards(null, '', null, false, 50, 0) c group by c.thread_key having count(*) > 1;
-- 3d. A suppressed row that lost its marker, or one touched by V2 provenance columns.
select 'suppressed_row_modified' as violation, n.id, n.source_key, n.source_entry_id
  from pub.news_entries n where n.suppression_reason like 'bluepost_reply_dedup_v1:%'
   and (n.suppressed_at is null or n.author_user_id is not null or n.observed_via is not null);
-- 3e. An entry whose original publication time moved (published_at must equal its first version snapshot).
select 'published_at_changed' as violation, n.id, n.source_entry_id
  from pub.news_entries n
  join lateral (select (v.snapshot ->> 'publishedAt')::timestamptz as first_pub from pub.news_post_versions v
                 where v.news_entry_id = n.id order by v.id asc limit 1) f on true
 where n.source_entry_id like 'post:%' and n.published_at <> f.first_pub;

-- 4. Before/after counters to compare: only `live_entries`, `versions` and `tracked_topics` may grow; `suppressed` must not change.
select (select count(*) from pub.news_entries) as entries,
       (select count(*) from pub.news_entries where suppressed_at is not null) as suppressed,
       (select count(*) from pub.news_entries where suppressed_at is null) as live_entries,
       (select count(*) from pub.news_post_versions) as versions,
       (select count(*) from pub.news_tracked_topics) as tracked_topics,
       (select count(*) from pub.news_verified_staff) as verified_staff,
       (select count(*) from web_api.news_cards(null, '', null, false, 50, 0)) as first_page_cards;

rollback;
