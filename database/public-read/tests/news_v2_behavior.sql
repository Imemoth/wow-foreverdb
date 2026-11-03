-- Run as a privileged test user after 0011_news_collector_v2.sql. Transactional:
-- every assertion runs inside one transaction that is rolled back, so no news
-- rows are left behind. A failing assertion raises and aborts the script.

begin;

create function pg_temp.h(p text) returns text language sql as $$ select md5(p) || md5(p || '#') $$;

-- One Blizzard forum post as the collector would send it.
create function pg_temp.post(
    p_region text, p_id bigint, p_topic bigint, p_post integer, p_title text, p_created timestamptz,
    p_extra jsonb default '{}'::jsonb
) returns jsonb language sql as $$
    select jsonb_build_object(
        'sourceEntryId', 'post:' || p_id, 'sourceTopicId', 'topic:' || p_topic,
        'sourcePostNumber', p_post, 'threadKey', p_region || ':topic:' || p_topic,
        'canonicalUrl', 'https://' || p_region || '.forums.blizzard.com/en/wow/t/t/' || p_topic || '/' || p_post,
        'title', p_title, 'author', 'Kaivax', 'region', p_region, 'publishedAt', p_created,
        'modifiedAt', null, 'excerpt', 'WoW Forever excerpt ' || p_id, 'category', 'bluepost',
        'relevance', 'relevant', 'status', 'published', 'contentHash', pg_temp.h('post:' || p_id)
    ) || p_extra
$$;

create function pg_temp.staff(p_uid bigint, p_group text default 'community-manager') returns jsonb language sql as
$$ select jsonb_build_object('userId', p_uid, 'username', 'Kaivax', 'group', p_group) $$;

create function pg_temp.sync(p_key text, p_region text, p_entries jsonb, p_run jsonb default '{}'::jsonb)
returns jsonb language sql as $$
    select pub_admin.news_apply_sync(jsonb_build_object(
        'source', jsonb_build_object('sourceKey', p_key, 'sourceType', 'bluepost', 'region', p_region,
                                     'endpointUrl', 'https://' || p_region || '.forums.blizzard.com/en/wow', 'enabled', true),
        'run', jsonb_build_object('status', 'succeeded', 'fetchedCount', jsonb_array_length(p_entries),
                                  'acceptedCount', 0, 'rejectedCount', 0, 'mode', 'normal', 'fetchOk', true) || p_run,
        'entries', p_entries))
$$;

create function pg_temp.snap() returns text language sql as $$
    select (select count(*) from pub.news_entries) || '/' || (select count(*) from pub.news_post_versions) || '/'
        || (select count(*) from pub.news_sync_runs) || '/' || (select count(*) from pub.news_verified_staff) || '/'
        || (select count(*) from pub.news_tracked_topics) || '/' || (select count(*) from pub.news_sources)
$$;

create function pg_temp.count_entries(p_key text) returns integer language sql as
$$ select count(*)::integer from pub.news_entries where source_key = p_key $$;

do $t$
declare
    r jsonb; n integer; v bigint; card record; e jsonb; before_counts text; after_counts text;
    opener_at timestamptz := '2026-09-24T22:23:24Z';
begin
    -- ----------------------------------------------------------------- 1
    -- New official topic opener by verified staff: inserted, version 1,
    -- tracked for revision, source freshness recorded.
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(
            pg_temp.post('us', 1001, 77, 1, 'WoW Forever Beta Development Notes', opener_at,
                         jsonb_build_object('authorUserId', 3390, 'authorGroup', 'community-manager',
                                            'threadOrigin', 'official', 'observedVia', 'feed'))),
         jsonb_build_object('verifiedStaff', jsonb_build_array(pg_temp.staff(3390))));
    assert (r ->> 'inserted')::int = 1, format('opener not inserted: %s', r);
    assert (select count(*) from pub.news_post_versions v join pub.news_entries e on e.id = v.news_entry_id where e.source_key = 't-us') = 1, 'first version missing';
    assert exists (select 1 from pub.news_tracked_topics where source_key = 't-us' and topic_id = 'topic:77'), 'topic not tracked';
    assert (select last_attempt_at is not null and last_fetch_ok_at is not null and last_official_post_at = opener_at
            from pub.news_sources where source_key = 't-us'), 'source freshness not recorded';
    raise notice 'PASS: official topic opener is inserted, versioned, tracked and freshness is recorded';

    -- ----------------------------------------------------------------- 2
    -- Official staff reply to an existing official topic: stored, ONE card per
    -- thread, original publication preserved, latest official update surfaced,
    -- card links to the staff post.
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(
            pg_temp.post('us', 1002, 77, 9, 'WoW Forever Beta Development Notes – Updated November 2', '2026-11-03T03:20:33Z',
                         jsonb_build_object('authorUserId', 3390, 'authorGroup', 'community-manager',
                                            'threadOrigin', 'official', 'observedVia', 'feed'))));
    assert (r ->> 'inserted')::int = 1 and (r ->> 'skippedUnverified')::int = 0, format('verified staff reply rejected: %s', r);
    select * into card from web_api.news_cards(null, '', 'us', false, 50, 0) c where c.thread_key = 'us:topic:77';
    assert card.update_count = 2, format('thread must aggregate 2 official updates, got %s', card.update_count);
    assert card.source_post_number = 9 and card.canonical_url like '%/77/9', 'card must link to the latest official post';
    assert card.thread_published_at = opener_at, 'original topic publication must be preserved';
    assert card.published_at = '2026-11-03T03:20:33Z' and card.official_updated_at = '2026-11-03T03:20:33Z', 'latest official update timestamp wrong';
    assert (select count(*) from web_api.news_cards(null, '', null, false, 50, 0) c where c.thread_key = 'us:topic:77') = 1, 'more than one card for one thread';
    assert card.entry_kind = 'official_update', 'reply kind must be official_update';
    raise notice 'PASS: official staff reply updates the single thread card without duplicating it';

    -- ----------------------------------------------------------------- 3
    -- Ordinary player reply (no provenance), spoofed username, unknown user id,
    -- non-allow-listed group, status other than published: none are stored.
    n := pg_temp.count_entries('t-us');
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(
        pg_temp.post('us', 2001, 77, 10, 'WoW Forever Beta Development Notes', '2026-11-04T00:00:00Z'),
        pg_temp.post('us', 2002, 77, 11, 'WoW Forever Beta Development Notes', '2026-11-04T00:01:00Z',
                     jsonb_build_object('author', 'Kaivax', 'authorUserId', 999999, 'authorGroup', 'community-manager', 'threadOrigin', 'official')),
        pg_temp.post('us', 2003, 77, 12, 'WoW Forever Beta Development Notes', '2026-11-04T00:02:00Z',
                     jsonb_build_object('authorUserId', 3390, 'authorGroup', 'trust_level_4', 'threadOrigin', 'official')),
        pg_temp.post('us', 2004, 77, 13, 'WoW Forever Beta Development Notes', '2026-11-04T00:03:00Z',
                     jsonb_build_object('authorUserId', 3390, 'authorGroup', 'community-manager')),
        pg_temp.post('us', 2005, 77, 14, 'WoW Forever Beta Development Notes', '2026-11-04T00:04:00Z',
                     jsonb_build_object('authorUserId', 3390, 'authorGroup', 'community-manager', 'threadOrigin', 'official', 'status', 'review'))));
    assert (r ->> 'inserted')::int = 0 and (r ->> 'skippedUnverified')::int = 5, format('unverified replies were not all rejected: %s', r);
    assert pg_temp.count_entries('t-us') = n, 'an unverified reply left a row behind';
    raise notice 'PASS: player replies, spoofed names, unknown ids, bad groups and unverified origins are rejected';

    -- ----------------------------------------------------------------- 4
    -- Region boundary: a US-verified id cannot authorise an EU reply, and the
    -- same numeric topic id in two regions yields two independent cards.
    r := pg_temp.sync('t-eu', 'eu', jsonb_build_array(
        pg_temp.post('eu', 5001, 77, 9, 'WoW Forever Beta Development Notes', '2026-11-03T03:21:28Z',
                     jsonb_build_object('authorUserId', 3390, 'authorGroup', 'community-manager', 'threadOrigin', 'official'))));
    assert (r ->> 'inserted')::int = 0 and (r ->> 'skippedUnverified')::int = 1, format('US identity authorised an EU reply: %s', r);
    r := pg_temp.sync('t-eu', 'eu', jsonb_build_array(
        pg_temp.post('eu', 5001, 77, 9, 'WoW Forever Beta Development Notes', '2026-11-03T03:21:28Z',
                     jsonb_build_object('authorUserId', 11548, 'authorGroup', 'community-manager', 'threadOrigin', 'official'))),
        jsonb_build_object('verifiedStaff', jsonb_build_array(pg_temp.staff(11548))));
    assert (r ->> 'inserted')::int = 1, format('EU verified staff reply rejected: %s', r);
    assert (select count(*) from web_api.news_cards(null, '', null, false, 50, 0) c where c.source_topic_id = 'topic:77') = 2, 'US and EU cards must stay separate';
    assert (select count(*) from web_api.news_cards(null, '', 'eu', false, 50, 0) c where c.source_topic_id = 'topic:77') = 1, 'region filter must isolate EU';
    assert (select count(*) from web_api.news_cards(null, '', 'us', false, 50, 0) c where c.source_topic_id = 'topic:77') = 1, 'region filter must isolate US';
    raise notice 'PASS: US/EU identities and cards stay isolated per region';

    -- ----------------------------------------------------------------- 5
    -- Official staff reply inside a PLAYER-created topic: the reply is stored
    -- as a staff_reply; the player opener is never created or promoted.
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(
        pg_temp.post('us', 3002, 88, 4, 'Question about Forever beta', '2026-11-02T10:00:00Z',
                     jsonb_build_object('authorUserId', 3390, 'authorGroup', 'community-manager', 'threadOrigin', 'community'))));
    assert (r ->> 'inserted')::int = 1, format('staff reply in community topic rejected: %s', r);
    assert not exists (select 1 from pub.news_entries where source_key = 't-us' and source_topic_id = 'topic:88' and source_post_number = 1), 'player opener must not exist';
    select * into card from web_api.news_cards(null, '', 'us', false, 50, 0) c where c.source_topic_id = 'topic:88';
    assert card.entry_kind = 'staff_reply' and card.thread_origin = 'community', 'staff reply in community thread must be labelled';
    raise notice 'PASS: staff reply in a player-created topic is stored; the player opener is never promoted';

    -- ----------------------------------------------------------------- 6
    -- Edited official post: same identity, new hash, official_updated_at moves,
    -- published_at/featured/importance are preserved, version history grows by one,
    -- no duplicate row; replaying the same edit is a no-op.
    update pub.news_entries set featured = true, importance = 77 where source_key = 't-us' and source_entry_id = 'post:1001';
    e := pg_temp.post('us', 1001, 77, 1, 'WoW Forever Beta Development Notes – Updated November 2', opener_at,
            jsonb_build_object('authorUserId', 3390, 'authorGroup', 'community-manager', 'threadOrigin', 'official', 'observedVia', 'topic',
                               'modifiedAt', '2026-11-03T03:20:46Z', 'officialUpdatedAt', '2026-11-03T03:20:46Z', 'sourceVersion', 6,
                               'contentHash', pg_temp.h('post:1001:v6')));
    n := pg_temp.count_entries('t-us');
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(e));
    assert (r ->> 'updated')::int = 1 and (r ->> 'inserted')::int = 0, format('edit not applied as update: %s', r);
    assert pg_temp.count_entries('t-us') = n, 'edit created a duplicate row';
    assert (select published_at = opener_at and featured and importance = 77 and official_updated_at = '2026-11-03T03:20:46Z' and source_version = 6
            from pub.news_entries where source_key = 't-us' and source_entry_id = 'post:1001'), 'edit changed published_at or editorial fields';
    assert (select count(*) from pub.news_post_versions v join pub.news_entries x on x.id = v.news_entry_id where x.source_entry_id = 'post:1001' and x.source_key = 't-us') = 2, 'version history must grow by exactly one';
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(e));
    assert (r ->> 'inserted')::int = 0 and (r ->> 'updated')::int = 0, format('replay must be a no-op: %s', r);
    -- A shorter FEED observation must not overwrite the richer TOPIC observation.
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(
        e || jsonb_build_object('observedVia', 'feed', 'excerpt', 'short feed excerpt', 'contentHash', pg_temp.h('post:1001:feed'))));
    assert (r ->> 'updated')::int = 0, format('feed observation overwrote topic content: %s', r);
    assert (select excerpt <> 'short feed excerpt' and observed_via = 'topic' from pub.news_entries where source_key = 't-us' and source_entry_id = 'post:1001'), 'topic content was clobbered';
    raise notice 'PASS: edits are idempotent, keep original dates/editorial fields and feed cannot clobber topic content';

    -- ----------------------------------------------------------------- 7
    -- Ordering: genuine official activity, not original publication, decides the
    -- chronological position. A thread with an old opener but a fresh official
    -- update sorts above a newer standalone announcement.
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(
        pg_temp.post('us', 4001, 99, 1, 'WoW Forever announcement', '2026-10-30T12:00:00Z',
                     jsonb_build_object('authorUserId', 3390, 'authorGroup', 'community-manager', 'threadOrigin', 'official'))));
    assert (select c.source_topic_id from web_api.news_cards(null, '', 'us', false, 50, 0) c limit 1) = 'topic:77',
        'thread with the freshest verified official update must sort first';
    assert (select c.published_at from web_api.news_cards(null, '', 'us', false, 50, 0) c where c.source_topic_id = 'topic:99') = '2026-10-30T12:00:00Z', 'original dates must not be altered';
    -- legacy 4-argument API returns the same ordering and is consistent with the featured API
    assert (select l.id from web_api.news_list(null, '', 50, 0) l limit 1) = (select c.id from web_api.news_cards(null, '', null, false, 50, 0) c limit 1), 'legacy news_list ordering diverges from news_cards';
    assert (select f.thread_key from web_api.news_featured(1) f) = 'us:topic:77', 'featured card must remain the editorially featured thread';
    raise notice 'PASS: chronological position follows verified official activity; legacy API agrees';

    -- ----------------------------------------------------------------- 8
    -- Pagination/search consistency: pages are disjoint and cover total_count.
    select count(*) into n from web_api.news_cards(null, '', null, false, 50, 0);
    assert n = (select total_count from web_api.news_cards(null, '', null, false, 1, 0)), 'total_count must equal the number of cards';
    assert (select count(distinct c.id) from (
              select * from web_api.news_cards(null, '', null, false, 2, 0)
              union all select * from web_api.news_cards(null, '', null, false, 2, 2)) c)
           = least(4, n), 'pages must be disjoint';
    assert (select count(*) from web_api.news_cards(null, 'announcement', null, false, 50, 0)) = 1, 'search must match the thread representative';
    raise notice 'PASS: pagination, totals and search are consistent';

    -- ----------------------------------------------------------------- 9
    -- Suppressed rows are never resurrected through ingestion.
    update pub.news_entries set suppressed_at = now(), suppression_reason = 'test' where source_key = 't-us' and source_entry_id = 'post:3002';
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(
        pg_temp.post('us', 3002, 88, 4, 'Question about Forever beta', '2026-11-02T10:00:00Z',
                     jsonb_build_object('authorUserId', 3390, 'authorGroup', 'community-manager', 'threadOrigin', 'community', 'excerpt', 'changed', 'contentHash', pg_temp.h('x')))));
    assert (r ->> 'updated')::int = 0 and (r ->> 'inserted')::int = 0, 'suppressed row was modified by ingestion';
    assert (select suppressed_at is not null from pub.news_entries where source_key = 't-us' and source_entry_id = 'post:3002'), 'suppression marker cleared';
    assert not exists (select 1 from web_api.news_cards(null, '', null, false, 50, 0) c where c.source_topic_id = 'topic:88'), 'suppressed thread leaked';
    raise notice 'PASS: suppressed records stay suppressed and immutable';

    -- ----------------------------------------------------------------- 10
    -- Missing/invalid metadata fails closed.
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(
        (pg_temp.post('us', 6001, 11, 1, 'WoW Forever x', now())) - 'sourcePostNumber'));
    assert (r ->> 'inserted')::int = 0 and (r ->> 'skipped')::int = 1, 'bluepost without a post number must be skipped';
    begin
        perform pg_temp.sync('t-us', 'us', jsonb_build_array(pg_temp.post('us', 6002, 11, 1, 'WoW Forever x', now(), jsonb_build_object('contentHash', 'nope'))));
        raise exception 'invalid hash accepted';
    exception when sqlstate '22023' then null; end;
    begin
        perform pg_temp.sync('t-us', 'us', jsonb_build_array(pg_temp.post('us', 6003, 11, 1, 'WoW Forever x', now(), jsonb_build_object('observedVia', 'rumor'))));
        raise exception 'invalid observedVia accepted';
    exception when sqlstate '22023' then null; end;
    begin
        perform pg_temp.sync('t-us', 'us', jsonb_build_array(pg_temp.post('us', 6004, 11, 1, 'WoW Forever x', now(), jsonb_build_object('threadOrigin', 'admin'))));
        raise exception 'invalid threadOrigin accepted';
    exception when sqlstate '22023' then null; end;
    begin
        perform pub_admin.news_apply_sync('{"source": {"sourceKey": "x"}}'::jsonb);
        raise exception 'invalid payload accepted';
    exception when sqlstate '22023' then null; end;
    raise notice 'PASS: missing or invalid source metadata fails closed';

    -- ----------------------------------------------------------------- 11
    -- Provenance is re-checked at READ time: even a reply row that somehow exists
    -- without verified provenance (e.g. a legacy row) is invisible.
    insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug,
            canonical_url, title, region, published_at, category, relevance, status, content_hash)
    values ('t-us', 'post:legacy-reply', 'topic:55', 3, 'us:topic:55', 'legacy-reply-fixture', 'https://example.com/t/55/3',
            'WoW Forever legacy reply', 'us', '2026-11-05T00:00:00Z', 'bluepost', 'relevant', 'published', pg_temp.h('legacy'));
    assert not exists (select 1 from web_api.news_cards(null, '', null, false, 50, 0) c where c.source_topic_id = 'topic:55'), 'reply without provenance was exposed';
    assert web_api.news_entry('legacy-reply-fixture') is null, 'reply without provenance exposed by news_entry';
    raise notice 'PASS: unverified reply rows are invisible at read time (fail closed)';

    -- ----------------------------------------------------------------- 12
    -- Future-dated official articles are hidden until their time arrives.
    insert into pub.news_sources (source_key, source_type, region, endpoint_url) values ('t-news', 'official_news', 'us', 'https://example.com/n');
    insert into pub.news_entries (source_key, source_entry_id, slug, canonical_url, title, region, published_at, category, relevance, status, content_hash)
    values ('t-news', 'article:1', 'future-article-fixture', 'https://example.com/n/1', 'World of Warcraft: Forever future', 'us',
            now() + interval '3 days', 'official_news', 'relevant', 'published', pg_temp.h('f'));
    assert not exists (select 1 from web_api.news_cards(null, '', null, false, 50, 0) c where c.source_key = 't-news'), 'future-dated article visible early';
    assert (pub_admin.news_health_snapshot() -> 'sources') @> '[{"sourceKey": "t-news", "futureDatedEntries": 1}]'::jsonb, 'health snapshot must count future-dated entries';
    raise notice 'PASS: future-dated articles are hidden until published';

    -- ----------------------------------------------------------------- 13
    -- Dry-run is read-only and reports the action per entry.
    before_counts := pg_temp.snap();
    r := pg_temp.sync('t-us', 'us', jsonb_build_array(
            pg_temp.post('us', 7001, 123, 1, 'WoW Forever dry run opener', '2026-11-01T00:00:00Z',
                         jsonb_build_object('authorUserId', 3390, 'authorGroup', 'community-manager', 'threadOrigin', 'official')),
            pg_temp.post('us', 7002, 123, 2, 'WoW Forever dry run opener', '2026-11-01T01:00:00Z',
                         jsonb_build_object('authorUserId', 424242, 'authorGroup', 'community-manager', 'threadOrigin', 'official')),
            e),
         jsonb_build_object('dryRun', true, 'verifiedStaff', jsonb_build_array(pg_temp.staff(3390))));
    after_counts := pg_temp.snap();
    assert before_counts = after_counts, 'dry-run wrote to the database';
    assert (r ->> 'dryRun')::boolean and (r ->> 'inserted')::int = 1 and (r ->> 'skippedUnverified')::int = 1, format('dry-run counts wrong: %s', r);
    assert (r -> 'report') @> '[{"sourceEntryId": "post:7001", "action": "insert"}, {"sourceEntryId": "post:7002", "action": "skip_unverified_reply"}, {"sourceEntryId": "post:1001", "action": "unchanged"}]'::jsonb, format('dry-run report wrong: %s', r -> 'report');
    raise notice 'PASS: dry-run is read-only and reports insert/update/skip per entry';

    -- ----------------------------------------------------------------- 14
    -- Revision tracking: due batch, tiering, back-off, region-scoped identities.
    update pub.news_tracked_topics set next_check_at = now() - interval '1 hour' where source_key = 't-us' and topic_id in ('topic:77', 'topic:99');
    r := pub_admin.news_revision_batch('t-us', 25);
    -- topic:88 was tracked on first sight and is therefore due immediately (new topics get a first check).
    assert jsonb_array_length(r -> 'dueTopics') = 3, format('due batch wrong: %s', r);
    assert jsonb_array_length(pub_admin.news_revision_batch('t-us', 1) -> 'dueTopics') = 1, 'batch must honour the limit';
    assert (r -> 'verifiedStaff') @> '[{"userId": 3390, "group": "community-manager"}]'::jsonb, 'verified staff missing';
    assert not ((pub_admin.news_revision_batch('t-eu', 25) -> 'verifiedStaff') @> '[{"userId": 3390}]'::jsonb), 'staff identities leaked across regions';
    r := pg_temp.sync('t-us', 'us', '[]'::jsonb, jsonb_build_object('mode', 'revision', 'topicChecks', jsonb_build_array(
        jsonb_build_object('topicId', 'topic:77', 'ok', true, 'httpStatus', 200, 'threadOrigin', 'official', 'openerUserId', 3390, 'topicCreatedAt', opener_at),
        jsonb_build_object('topicId', 'topic:88', 'ok', true, 'httpStatus', 200, 'threadOrigin', 'community'),
        jsonb_build_object('topicId', 'topic:99', 'ok', false, 'httpStatus', 429, 'error', 'source_http_429'))));
    assert (select next_check_at > now() + interval '5 hours' and consecutive_failures = 0 and topic_created_at = opener_at
            from pub.news_tracked_topics where source_key = 't-us' and topic_id = 'topic:77'), 'successful check must reschedule a full tier ahead';
    assert (select consecutive_failures = 1 and last_http_status = 429 and next_check_at > now() + interval '11 hours' and next_check_at <= now() + interval '48 hours'
            from pub.news_tracked_topics where source_key = 't-us' and topic_id = 'topic:99'), 'failed check must back off exponentially (bounded)';
    assert jsonb_array_length(pub_admin.news_revision_batch('t-us', 25) -> 'dueTopics') = 0, 'checked topics must not be due again immediately';
    begin perform pub_admin.news_revision_batch('t-news', 25); raise exception 'non-bluepost accepted';
    exception when sqlstate '22023' then null; end;
    begin perform pub_admin.news_revision_batch('t-us', 500); raise exception 'unbounded limit accepted';
    exception when sqlstate '22023' then null; end;
    -- an old topic that was not in any recent Tracker window is still revised once due
    update pub.news_tracked_topics set last_official_at = now() - interval '200 days', next_check_at = now() - interval '1 minute'
     where source_key = 't-us' and topic_id = 'topic:99';
    assert exists (select 1 from jsonb_array_elements(pub_admin.news_revision_batch('t-us', 25) -> 'dueTopics') d where d ->> 'topicId' = 'topic:99'), 'old active topic dropped out of revision coverage';
    raise notice 'PASS: persistent bounded revision tracking schedules, backs off and never drops old topics';

    -- ----------------------------------------------------------------- 15
    -- Run auditing and health counters.
    r := pg_temp.sync('t-us', 'us', '[]'::jsonb, jsonb_build_object('status', 'failed', 'fetchOk', false, 'errorCategory', 'http_503', 'httpStatus', 503, 'error', 'source_http_503'));
    assert (select last_error_category = 'http_503' and last_http_status = 503 and last_error is not null from pub.news_sources where source_key = 't-us'), 'failure category not recorded';
    assert (select fetch_ok = false and error_category = 'http_503' and http_status = 503 from pub.news_sync_runs where source_key = 't-us' order by id desc limit 1), 'failed run not audited';
    assert (select (s ->> 'consecutiveFailures')::int >= 1 from jsonb_array_elements(pub_admin.news_health_snapshot() -> 'sources') s where s ->> 'sourceKey' = 't-us'), 'consecutive failures not reported';
    raise notice 'PASS: failures are categorised, audited and surfaced in the health snapshot';

    -- ----------------------------------------------------------------- 16
    -- Detail view exposes thread context.
    e := web_api.news_entry((select slug from pub.news_entries where source_key = 't-us' and source_entry_id = 'post:1002'));
    assert (e ->> 'updateCount')::int = 2 and e ->> 'entryKind' = 'official_update' and jsonb_array_length(e -> 'updates') = 2, format('detail thread context wrong: %s', e);
    assert (e ->> 'threadPublishedAt')::timestamptz = opener_at, 'detail must expose original topic publication';
    raise notice 'PASS: detail page exposes thread context';
end
$t$;

rollback;
