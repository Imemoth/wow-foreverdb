-- Run as a privileged test user after 0013_news_global_story_grouping.sql. Transactional: everything runs inside one transaction that
-- is rolled back. A failing assertion raises. Production-shaped fixtures: verified Blizzard openers in two regions, cross-posts into
-- several forum categories, near-misses, verified updates, suppressed and unverified rows.
begin;

create function pg_temp.h(p text) returns text language sql as $$ select md5(p) || md5(p || '#') $$;
create function pg_temp.ensure_sources() returns void language sql as $$
    insert into pub.news_sources (source_key, source_type, region, endpoint_url) values
        ('sg-us', 'bluepost', 'us', 'https://example.com/us'), ('sg-eu', 'bluepost', 'eu', 'https://example.com/eu'),
        ('sg-news', 'official_news', 'us', 'https://example.com/news') on conflict do nothing
$$;
-- A verified Blizzard opener (post 1). The excerpt is long enough to count as evidence unless the test passes a short one.
create function pg_temp.opener(p_region text, p_topic bigint, p_title text, p_pub timestamptz, p_excerpt text default null, p_author text default 'Blizzard Entertainment')
returns void language sql as $$
    insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug, canonical_url, title, author, region,
                                  published_at, excerpt, category, relevance, status, content_hash, author_user_id, author_group, thread_origin, observed_via)
    values ('sg-' || p_region, 'post:' || (p_topic * 10), 'topic:' || p_topic, 1, p_region || ':topic:' || p_topic, 'sg-' || p_region || '-' || p_topic || '-1',
            'https://' || p_region || '.forums.blizzard.com/en/wow/t/x/' || p_topic || '/1', p_title, p_author, p_region, p_pub,
            coalesce(p_excerpt, 'World of Warcraft Forever official announcement text that is long enough to be evidence ' || p_title),
            'bluepost', 'relevant', 'published', pg_temp.h('o' || p_region || p_topic), 520262, 'api_users', 'official', 'topic')
$$;
-- A verified staff reply (post n > 1) with full provenance.
create function pg_temp.update_post(p_region text, p_topic bigint, p_post integer, p_pub timestamptz, p_excerpt text, p_verified boolean default true)
returns void language sql as $$
    insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug, canonical_url, title, author, region,
                                  published_at, official_updated_at, excerpt, category, relevance, status, content_hash, author_user_id, author_group, thread_origin, observed_via)
    values ('sg-' || p_region, 'post:' || (p_topic * 10 + p_post), 'topic:' || p_topic, p_post, p_region || ':topic:' || p_topic, 'sg-' || p_region || '-' || p_topic || '-' || p_post,
            'https://' || p_region || '.forums.blizzard.com/en/wow/t/x/' || p_topic || '/' || p_post, 'Update', 'Kaivax', p_region, p_pub, p_pub, p_excerpt,
            'bluepost', 'relevant', 'published', pg_temp.h('u' || p_region || p_topic || p_post),
            case when p_verified then 3390 end, case when p_verified then 'community-manager' end, case when p_verified then 'official' end, 'topic')
$$;
create function pg_temp.fp() returns text language sql as $$
    select md5(coalesce((select string_agg(e::text, ';' order by e.id) from pub.news_entries e), '') ||
               coalesce((select string_agg(v::text, ';' order by v.id) from pub.news_post_versions v), '') ||
               coalesce((select string_agg(t::text, ';' order by t.source_key, t.topic_id) from pub.news_tracked_topics t), ''))
$$;
do $t$
declare
    t0 constant timestamptz := now() - interval '3 days';
    r jsonb; before_fp text; cnt integer; c record; ids bigint[]; p1 bigint[]; p2 bigint[];
begin
    perform pg_temp.ensure_sources();

    -- ---------------------------------------------------------------- fixtures
    -- F1 global announcement, identical in both regions (2.2 min apart)
    perform pg_temp.opener('us', 1001, 'Explore WoW: Forever with a Gamepad', t0);
    perform pg_temp.opener('eu', 2001, 'Explore WoW: Forever with a Gamepad', t0 + interval '130 seconds');
    -- F2 US-only, F3 EU-only
    perform pg_temp.opener('us', 1002, 'US Only Maintenance Notice for Forever Realms', t0 + interval '1 hour');
    perform pg_temp.opener('eu', 2003, 'EU Only Server Merge Announcement for Forever', t0 + interval '2 hours');
    -- F4 similar titles, different meaning (different title / different content)
    perform pg_temp.opener('us', 1004, 'The WoW Forever Podcast: Episode 5', t0 + interval '3 hours');
    perform pg_temp.opener('eu', 2004, 'The WoW Forever Podcast: Episode 6', t0 + interval '3 hours');
    perform pg_temp.opener('us', 1005, 'Hotfixes for WoW Forever', t0 + interval '4 hours', 'Fixed a quest that could not be completed in the Forever starting zones this week.');
    perform pg_temp.opener('eu', 2005, 'Hotfixes for WoW Forever', t0 + interval '4 hours', 'Adjusted the drop rate of a dungeon item and fixed a crash in the auction house.');
    -- F5 same title repeated within one region: a recurring title a week apart (never merged) and a same-minute cross-post (same content)
    perform pg_temp.opener('us', 1006, 'Weekly Reset Reminder for WoW Forever', t0 + interval '5 hours');
    perform pg_temp.opener('us', 1007, 'Weekly Reset Reminder for WoW Forever', t0 + interval '5 hours' - interval '7 days');
    perform pg_temp.opener('us', 1008, 'Cross Posted Announcement in Two Categories', t0 + interval '6 hours');
    perform pg_temp.opener('us', 1009, 'Cross Posted Announcement in Two Categories', t0 + interval '6 hours' + interval '30 seconds');
    -- F6 different wording / dates: same title+time but different text -> review; titles differing only by date wording -> not even a candidate
    perform pg_temp.opener('us', 1010, 'Beta Celebration Underway', t0 + interval '7 hours', 'Join the celebration on 10/22 at 5pm Eastern time to unlock the Forever beta rewards for everyone.');
    perform pg_temp.opener('eu', 2010, 'Beta Celebration Underway', t0 + interval '7 hours', 'Join the celebration on 22/10 at 22:00 BST to unlock the Forever beta rewards for everyone.');
    perform pg_temp.opener('us', 1011, 'WoW Forever Beta Development Notes - Updated November 2', t0 + interval '8 hours', 'Development notes for the Forever beta: systems, classes and dungeons are listed below in detail.');
    perform pg_temp.opener('eu', 2011, 'WoW Forever Beta Development Notes - Updated 3 November', t0 + interval '8 hours' + interval '14 minutes', 'Development notes for the Forever beta: systems, classes and dungeons are listed below in detail.');
    -- F7 a clique failure: A~B (10 min), B~C (10 min), A !~ C (20 min)
    perform pg_temp.opener('us', 1012, 'Chain Of Three Similar Announcements', t0 + interval '9 hours');
    perform pg_temp.opener('eu', 2012, 'Chain Of Three Similar Announcements', t0 + interval '9 hours' + interval '10 minutes');
    perform pg_temp.opener('us', 1013, 'Chain Of Three Similar Announcements', t0 + interval '9 hours' + interval '20 minutes');
    -- F8 four-way cross-post (2 per region, different categories): one story
    perform pg_temp.opener('us', 1014, 'Thank You For Testing the WoW Forever Beta', t0 + interval '10 hours');
    perform pg_temp.opener('us', 1015, 'Thank You For Testing the WoW Forever Beta', t0 + interval '10 hours' + interval '31 seconds');
    perform pg_temp.opener('eu', 2014, 'Thank You For Testing the WoW Forever Beta', t0 + interval '10 hours' + interval '3 seconds');
    perform pg_temp.opener('eu', 2015, 'Thank You For Testing the WoW Forever Beta', t0 + interval '10 hours' + interval '57 seconds');
    -- Official News (no thread, never grouped)
    insert into pub.news_entries (source_key, source_entry_id, slug, canonical_url, title, region, published_at, category, relevance, status, content_hash, excerpt)
    values ('sg-news', 'article:1', 'sg-news-1', 'https://example.com/n/1', 'WoW Forever Official News Story', 'us', t0 + interval '11 hours', 'official_news', 'relevant', 'published', pg_temp.h('n1'), 'x');

    select count(*) into cnt from pub.news_story_members;
    assert cnt = 0, 'no story links may exist before linking';

    -- ---------------------------------------------------------------- 0. compatibility with no links: identical to news_cards
    assert (select array_agg(s.id order by s.official_updated_at desc, s.id desc) from web_api.news_stories(null, '', null, false, 50, 0) s)
         = (select array_agg(nc.id order by nc.official_updated_at desc, nc.id desc) from web_api.news_cards(null, '', null, false, 50, 0) nc),
         'with no links news_stories must equal news_cards';
    assert (select max(total_count) from web_api.news_stories(null, '', null, false, 50, 0)) = (select max(total_count) from web_api.news_cards(null, '', null, false, 50, 0)), 'totals must match without links';
    raise notice 'PASS: without links news_stories == news_cards';

    -- ---------------------------------------------------------------- 1. dry-run is read-only and explains itself
    before_fp := pg_temp.fp();
    r := pub_admin.news_link_stories(false);
    assert pg_temp.fp() = before_fp and (select count(*) from pub.news_story_members) = 0, 'dry-run wrote something';
    assert (r ->> 'applied')::boolean = false and r ->> 'ruleVersion' = 'exact_content_v1', 'dry-run header wrong';
    -- confirmed stories: F1 (2), F5 cross-post (2), F8 (4)  => 3 stories, 8 threads
    assert jsonb_array_length(r -> 'stories') = 3 and (r ->> 'newMembers')::int = 8, format('expected 3 stories / 8 threads, got %s', r);
    assert (select count(*) from jsonb_array_elements(r -> 'stories') s where (s ->> 'memberCount')::int = 4) = 1, 'the four-way cross-post must be ONE story of 4 threads';
    -- near misses are reported for review, never merged: F4 hotfixes (content differs), F6 beta celebration (content differs)
    assert (select count(*) from jsonb_array_elements(r -> 'review') x where x ->> 'title' in ('Hotfixes for WoW Forever', 'Beta Celebration Underway')) = 2, format('review list wrong: %s', r -> 'review');
    -- clique failure F7 is ambiguous and not linked
    assert jsonb_array_length(r -> 'ambiguous') = 1, format('expected 1 ambiguous component, got %s', r -> 'ambiguous');
    raise notice 'PASS: dry-run is read-only; 3 confirmed stories (8 threads), 2 review pairs, 1 ambiguous clique';

    -- ---------------------------------------------------------------- 2. apply: immutability of every source row
    before_fp := pg_temp.fp();
    r := pub_admin.news_link_stories(true);
    assert pg_temp.fp() = before_fp, 'linking changed an entry, version or tracked-topic row';
    assert (select count(*) from pub.news_story_members) = 8, 'apply must link exactly the 8 confirmed threads';
    assert (select count(distinct story_key) from pub.news_story_members) = 3, 'three stories';
    assert (pub_admin.news_link_stories(true) ->> 'newMembers')::int = 0 and (select count(*) from pub.news_story_members) = 8, 'second apply must be a no-op (idempotent)';
    assert not exists (select 1 from pub.news_story_members m where m.thread_key like '%:topic:1006' or m.thread_key like '%:topic:1007'), 'same title one week apart must NEVER merge';
    assert not exists (select 1 from pub.news_story_members m where m.thread_key in ('us:topic:1012', 'eu:topic:2012', 'us:topic:1013')), 'a non-clique chain must not merge';
    assert not exists (select 1 from pub.news_story_members where thread_key in ('us:topic:1004', 'eu:topic:2004', 'us:topic:1005', 'eu:topic:2005', 'us:topic:1010', 'eu:topic:2010', 'us:topic:1011', 'eu:topic:2011')),
           'similar titles / different meaning / different wording must stay separate';
    assert (select story_key from pub.news_story_members where thread_key = 'eu:topic:2001') = 'story:us:topic:1001', 'story key must be the earliest thread (canonical)';
    raise notice 'PASS: apply links exactly the confirmed threads, never touches source rows, and is idempotent';

    -- ---------------------------------------------------------------- 3. cards: one per story; US-only / EU-only / global; totals before paging
    -- threads: 8 linked into 3 stories + unlinked: 1002,2003,1004,2004,1005,2005,1006,1007,1010,2010,1011,2011,1012,2012,1013 (15) + 1 official news
    select count(*) into cnt from web_api.news_stories(null, '', null, false, 50, 0);
    assert cnt = 3 + 15 + 1, format('all-regions cards: expected 19, got %s', cnt);
    assert (select max(total_count) from web_api.news_stories(null, '', null, false, 50, 0)) = 19, 'total must count stories, not threads';
    select * into c from web_api.news_stories(null, '', null, false, 50, 0) s where s.thread_key in ('us:topic:1001', 'eu:topic:2001');
    assert c.regions = array['eu', 'us'] and c.member_count = 2 and c.story_key = 'story:us:topic:1001', format('global card wrong: %s', c);
    assert (select canonical_slug from web_api.news_stories(null, '', null, false, 50, 0) s where s.story_key = 'story:us:topic:1001') = 'sg-us-1001-1', 'canonical_slug must be the canonical thread opener';
    assert (select canonical_slug from web_api.news_stories(null, '', null, false, 50, 0) s where s.thread_key = 'us:topic:1002') = 'sg-us-1002-1', 'unlinked cards are their own canonical';
    -- region filters: a story appears in a region iff it has a member there, with that region's own content
    assert (select count(*) from web_api.news_stories(null, '', 'us', false, 50, 0) s where s.story_key = 'story:us:topic:1001' and s.region = 'us' and s.thread_key = 'us:topic:1001') = 1, 'US view must use the US member';
    assert (select count(*) from web_api.news_stories(null, '', 'eu', false, 50, 0) s where s.story_key = 'story:us:topic:1001' and s.region = 'eu' and s.thread_key = 'eu:topic:2001') = 1, 'EU view must use the EU member';
    assert (select count(*) from web_api.news_stories(null, '', 'us', false, 50, 0) s where s.thread_key like 'eu:%') = 0 and (select count(*) from web_api.news_stories(null, '', 'eu', false, 50, 0) s where s.thread_key like 'us:%') = 0, 'region filter leaked';
    -- US-only / EU-only stay single-region
    assert (select regions from web_api.news_stories(null, '', null, false, 50, 0) s where s.thread_key = 'us:topic:1002') = array['us'], 'US-only story must list only US';
    assert (select regions from web_api.news_stories(null, '', null, false, 50, 0) s where s.thread_key = 'eu:topic:2003') = array['eu'], 'EU-only story must list only EU';
    assert not exists (select 1 from web_api.news_stories(null, '', 'eu', false, 50, 0) s where s.thread_key = 'us:topic:1002'), 'US-only story shown in the EU view';
    -- totals and pages per filter; pagination never repeats or drops a story
    assert (select max(total_count) from web_api.news_stories(null, '', 'us', false, 50, 0)) = (select count(*) from web_api.news_stories(null, '', 'us', false, 50, 0)), 'US total mismatch';
    assert (select max(total_count) from web_api.news_stories(null, '', 'eu', false, 50, 0)) = (select count(*) from web_api.news_stories(null, '', 'eu', false, 50, 0)), 'EU total mismatch';
    select array_agg(s.id order by s.official_updated_at desc, s.id desc) into ids from web_api.news_stories(null, '', null, false, 50, 0) s;
    select array_agg(s.id order by s.official_updated_at desc, s.id desc) into p1 from (select * from web_api.news_stories(null, '', null, false, 7, 0)) s;
    select array_agg(s.id order by s.official_updated_at desc, s.id desc) into p2 from (select * from web_api.news_stories(null, '', null, false, 7, 7)) s;
    assert (p1 || p2 || coalesce((select array_agg(s.id order by s.official_updated_at desc, s.id desc) from web_api.news_stories(null, '', null, false, 7, 14) s), '{}')) = ids, 'pagination must be a partition of the story list';
    raise notice 'PASS: one card per story; US/EU/global views, totals and pagination are correct';

    -- ---------------------------------------------------------------- 4. a new verified update in ONE region; suppressed / unverified replies stay invisible
    perform pg_temp.update_post('us', 1001, 2, t0 + interval '2 days', 'US-only addendum: the zebrafish gamepad calibration setting was renamed in the US client.');
    perform pg_temp.update_post('us', 1001, 3, t0 + interval '2 days' + interval '1 minute', 'This reply has no verified provenance and must never show.', false);
    insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug, canonical_url, title, author, region, published_at, excerpt, category, relevance, status, content_hash,
                                  suppressed_at, suppression_reason)
    values ('sg-eu', 'post:20019', 'topic:2001', 9, 'eu:topic:2001', 'sg-eu-2001-9', 'https://eu.forums.blizzard.com/en/wow/t/x/2001/9', 'Suppressed legacy reply fixture', 'Kaivax', 'eu', t0 + interval '2 days', 'suppressed legacy reply zebrafish', 'bluepost', 'relevant', 'published', pg_temp.h('sup'),
            now(), 'bluepost_reply_dedup_v1:test');
    select * into c from web_api.news_stories(null, '', null, false, 50, 0) s where s.story_key = 'story:us:topic:1001';
    assert c.region = 'us' and c.slug = 'sg-us-1001-2' and c.update_count = 2 and c.regions = array['eu', 'us'], format('the story card must follow the latest verified update (US): %s', c);
    assert (select count(*) from web_api.news_stories(null, '', 'eu', false, 50, 0) s where s.story_key = 'story:us:topic:1001' and s.slug = 'sg-eu-2001-1' and s.update_count = 1) = 1, 'the EU view must keep the EU content (no US update leaks)';
    assert not exists (select 1 from pub.news_card_entries where slug in ('sg-us-1001-3', 'sg-eu-2001-9')), 'unverified/suppressed replies must be invisible';
    -- detail: both sources, per-region verified updates, no hidden rows
    r := web_api.news_story_entry('sg-us-1001-2');
    assert jsonb_array_length(r #> '{story,members}') = 2 and r #> '{story,regions}' = '["eu", "us"]'::jsonb, format('detail members wrong: %s', r -> 'story');
    assert (select count(*) from jsonb_array_elements(r #> '{story,members}') m where m ->> 'sourceUrl' like 'https://%.forums.blizzard.com/%') = 2, 'both official source links must be exposed';
    assert (select jsonb_array_length(m -> 'updates') from jsonb_array_elements(r #> '{story,members}') m where m ->> 'region' = 'us') = 2
       and (select jsonb_array_length(m -> 'updates') from jsonb_array_elements(r #> '{story,members}') m where m ->> 'region' = 'eu') = 1, 'per-region update history wrong';
    assert not (r::text like '%no verified provenance%') and not (r::text like '%suppressed legacy%'), 'hidden content leaked into the story detail';
    raise notice 'PASS: a one-region update surfaces for that region only; suppressed/unverified replies stay invisible';

    -- ---------------------------------------------------------------- 5. search matches verified content from either regional source
    assert (select count(*) from web_api.news_stories(null, 'zebrafish', null, false, 50, 0) s where s.story_key = 'story:us:topic:1001') = 1, 'search must find the story through its US update';
    assert (select count(*) from web_api.news_stories(null, 'zebrafish', 'us', false, 50, 0) s where s.story_key = 'story:us:topic:1001') = 1, 'US view must match US content';
    assert (select count(*) from web_api.news_stories(null, 'zebrafish', 'eu', false, 50, 0)) = 0, 'EU view must not match US-only content (suppressed EU text must not match either)';
    assert (select max(total_count) from web_api.news_stories(null, 'zebrafish', null, false, 50, 0)) = 1, 'search totals must count stories';
    raise notice 'PASS: search covers both regional sources and respects the region filter';

    -- ---------------------------------------------------------------- 6. URLs: every old entry URL still resolves and points to ONE canonical story URL
    for c in select slug from pub.news_card_entries where thread_key in ('us:topic:1001', 'eu:topic:2001', 'us:topic:1014', 'eu:topic:2015') loop
        r := web_api.news_story_entry(c.slug);
        assert r is not null and r ->> 'slug' = c.slug, format('old URL %s no longer resolves', c.slug);
        assert r #>> '{story,canonicalSlug}' in ('sg-us-1001-1', 'sg-us-1014-1'), format('canonical slug wrong for %s: %s', c.slug, r #>> '{story,canonicalSlug}');
    end loop;
    assert (web_api.news_story_entry('sg-us-1002-1') -> 'story') = 'null'::jsonb and web_api.news_story_entry('sg-us-1002-1') ->> 'slug' = 'sg-us-1002-1', 'an unlinked entry keeps working with story = null';
    assert web_api.news_story_entry('does-not-exist') is null, 'unknown slug must stay null';
    raise notice 'PASS: old URLs resolve; one canonical slug per story; unlinked entries unchanged';

    -- ---------------------------------------------------------------- 7. overrides: allow forces a reviewed merge, deny forbids an automatic one
    insert into pub.news_story_overrides (thread_a, thread_b, decision, reason, decided_by) values ('eu:topic:2011', 'us:topic:1011', 'allow', 'Same development notes thread; title wording differs only by date format', 'owner');
    r := pub_admin.news_link_stories(false);
    assert (select count(*) from jsonb_array_elements(r -> 'stories') s where s #>> '{members,0,threadKey}' in ('us:topic:1011', 'eu:topic:2011')) = 1, format('allow override must create the Dev Notes story: %s', r -> 'stories');
    r := pub_admin.news_link_stories(true);
    assert (select basis from pub.news_story_members where thread_key = 'eu:topic:2011') = 'manual_allow', 'override links must be marked manual_allow';
    insert into pub.news_story_overrides (thread_a, thread_b, decision, reason, decided_by) values ('eu:topic:2012', 'us:topic:1012', 'deny', 'Reviewed: these are two different announcements', 'owner');
    assert not exists (select 1 from pub.news_story_members a join pub.news_story_members b on b.story_key = a.story_key where a.thread_key = 'us:topic:1012' and b.thread_key = 'eu:topic:2012'), 'a denied pair must never share a story';
    -- a bad override is rejected by the table
    begin insert into pub.news_story_overrides values ('us:topic:2', 'eu:topic:1', 'allow', 'long enough reason', 'owner'); raise exception 'unordered pair accepted';
    exception when check_violation then null; end;
    begin insert into pub.news_story_overrides values ('eu:topic:1', 'us:topic:2', 'allow', 'short', 'owner'); raise exception 'reason-less override accepted';
    exception when check_violation then null; end;
    raise notice 'PASS: reviewed allow/deny overrides work and are validated';

    -- ---------------------------------------------------------------- 8. input validation and privileges
    begin perform web_api.news_stories('nope', '', null, false, 10, 0); raise exception 'bad category accepted'; exception when sqlstate '22023' then null; end;
    begin perform web_api.news_stories(null, '', 'asia', false, 10, 0); raise exception 'bad region accepted'; exception when sqlstate '22023' then null; end;
    begin perform web_api.news_stories(null, '', null, false, 500, 0); raise exception 'unbounded limit accepted'; exception when sqlstate '22023' then null; end;
    begin perform web_api.news_stories(null, '50%', null, false, 10, 0); raise exception 'wildcard accepted'; exception when sqlstate '22023' then null; end;
    assert has_function_privilege('foreverdb_web_reader', 'web_api.news_stories(text,text,text,boolean,integer,integer)', 'execute')
       and not has_function_privilege('foreverdb_web_reader', 'pub_admin.news_link_stories(boolean)', 'execute')
       and not has_function_privilege('azerdex_news_ingest', 'pub_admin.news_link_stories(boolean)', 'execute')
       and not has_table_privilege('foreverdb_web_reader', 'pub.news_story_members', 'select'), 'privilege model wrong';
    raise notice 'PASS: validation and privileges';
end
$t$;

rollback;
