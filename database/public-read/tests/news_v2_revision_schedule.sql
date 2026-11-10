-- Run as a privileged test user after 0011_news_collector_v2.sql and 0012_news_revision_due_tolerance.sql. Transactional: every
-- assertion runs inside one transaction that is rolled back, so no news rows are left behind. A failing assertion raises.
--
-- Defect under test (observed in production on 2026-11-04): the revision cron job fires at exactly :00:00 every 6 hours, but a
-- topic's next_check_at is computed with now() INSIDE the apply, i.e. a few seconds to a few minutes AFTER that tick. The next
-- tick therefore found the topic "not yet due" (next_check_at > now()) and skipped it for a whole cycle: the 6 h tier ran every
-- 12 h, the 24 h tier every 30 h, the weekly tier every 7 d 6 h, and the failure back-offs 12/24/48 h ran 6 h late.
-- Contract: a topic whose due time falls within the tolerance AFTER a tick (15 minutes) is checked at that tick; a topic is never
-- pulled forward by a whole cycle (the tolerance is far below the shortest interval).

begin;

do $t$
declare
    c_period constant interval := interval '6 hours';       -- cron period of the revision job ('0 */6 * * *')
    c_tol    constant interval := interval '15 minutes';    -- documented tolerance
    v_tiers  constant text[][] := array[['1 day', '6 hours'], ['30 days', '24 hours'], ['120 days', '7 days']];
    v_i integer;
    v_f integer;
    v_interval interval;
    v_delay interval;
    v_delays interval[] := array[interval '0 seconds', interval '6 seconds', interval '59 seconds', interval '4 minutes',
                                 interval '14 minutes 59 seconds', c_tol];
    v_expected interval[] := array[interval '12 hours', interval '24 hours', interval '48 hours', interval '48 hours', interval '48 hours'];
    v_topic text;
    v_batch jsonb;
begin
    insert into pub.news_sources (source_key, source_type, region, endpoint_url)
    values ('rs-us', 'bluepost', 'us', 'https://example.com/us'), ('rs-eu', 'bluepost', 'eu', 'https://example.com/eu');

    -- Helper semantics: "the check finishes inside the apply", exactly like the Edge Function: news_apply_sync with topicChecks.
    -- ---------------------------------------------------------------- 1. the scheduled interval of every tier is a whole number of cron periods
    for v_i in 1 .. array_length(v_tiers, 1) loop
        v_topic := 'topic:' || (100 + v_i);
        insert into pub.news_tracked_topics (source_key, topic_id, thread_origin, last_official_at, next_check_at, official_post_ids)
        values ('rs-us', v_topic, 'official', now() - v_tiers[v_i][1]::interval, now() - interval '1 minute', array[v_i::bigint]);
        perform pub_admin.news_apply_sync(jsonb_build_object(
            'source', jsonb_build_object('sourceKey', 'rs-us', 'sourceType', 'bluepost', 'region', 'us', 'endpointUrl', 'https://example.com/us', 'enabled', true),
            'run', jsonb_build_object('status', 'succeeded', 'topicChecks', jsonb_build_array(jsonb_build_object('topicId', v_topic, 'ok', true, 'httpStatus', 200))),
            'entries', '[]'::jsonb));
        select next_check_at - now() into v_interval from pub.news_tracked_topics where source_key = 'rs-us' and topic_id = v_topic;
        assert v_interval = v_tiers[v_i][2]::interval, format('tier %s: scheduled %s, expected %s', v_tiers[v_i][1], v_interval, v_tiers[v_i][2]);
        assert extract(epoch from v_interval)::bigint % extract(epoch from c_period)::bigint = 0, 'every tier must be a whole number of cron periods';

        -- ------------------------------------------------------------ 2. the tick that falls v_delay BEFORE the stored due time must pick it up
        -- Emulated clock: the apply ran v_delay after a tick; the next tick (interval - v_delay later) sees "remaining = v_delay".
        foreach v_delay in array v_delays loop
            update pub.news_tracked_topics set next_check_at = now() + v_delay where source_key = 'rs-us' and topic_id = v_topic;
            v_batch := pub_admin.news_revision_batch('rs-us', 25);
            assert exists (select 1 from jsonb_array_elements(v_batch -> 'dueTopics') d where d ->> 'topicId' = v_topic),
                   format('tier %s: a topic due %s after the tick was skipped (the production defect)', v_tiers[v_i][1], v_delay);
        end loop;
        -- Boundary: one second beyond the tolerance is NOT due yet.
        update pub.news_tracked_topics set next_check_at = now() + c_tol + interval '1 second' where source_key = 'rs-us' and topic_id = v_topic;
        assert not exists (select 1 from jsonb_array_elements(pub_admin.news_revision_batch('rs-us', 25) -> 'dueTopics') d where d ->> 'topicId' = v_topic),
               'a topic due 15 minutes + 1 second after the tick must wait for the following tick';
        -- Never pulled forward by a whole cycle: the previous tick (one period earlier) must NOT see it.
        update pub.news_tracked_topics set next_check_at = now() + c_period + v_delays[2] where source_key = 'rs-us' and topic_id = v_topic;
        assert not exists (select 1 from jsonb_array_elements(pub_admin.news_revision_batch('rs-us', 25) -> 'dueTopics') d where d ->> 'topicId' = v_topic),
               format('tier %s: a topic was pulled forward by a whole cycle', v_tiers[v_i][1]);
    end loop;
    raise notice 'PASS: 6 h / 24 h / 7 d tiers are scheduled in whole cron periods and are picked up by the tick that follows the apply delay';

    -- ---------------------------------------------------------------- 3. failure back-off tiers (6 h x 2^(n+1), capped at 48 h)
    for v_f in 0 .. 4 loop
        v_topic := 'topic:' || (200 + v_f);
        insert into pub.news_tracked_topics (source_key, topic_id, thread_origin, last_official_at, next_check_at, consecutive_failures, official_post_ids)
        values ('rs-us', v_topic, 'official', now() - interval '1 day', now() - interval '1 minute', v_f, array[(200 + v_f)::bigint]);
        perform pub_admin.news_apply_sync(jsonb_build_object(
            'source', jsonb_build_object('sourceKey', 'rs-us', 'sourceType', 'bluepost', 'region', 'us', 'endpointUrl', 'https://example.com/us', 'enabled', true),
            'run', jsonb_build_object('status', 'partial', 'topicChecks', jsonb_build_array(jsonb_build_object('topicId', v_topic, 'ok', false, 'httpStatus', 503, 'error', 'source_http_503'))),
            'entries', '[]'::jsonb));
        select next_check_at - now() into v_interval from pub.news_tracked_topics where source_key = 'rs-us' and topic_id = v_topic;
        assert v_interval = v_expected[v_f + 1], format('back-off after %s earlier failures: scheduled %s, expected %s', v_f, v_interval, v_expected[v_f + 1]);
        assert extract(epoch from v_interval)::bigint % extract(epoch from c_period)::bigint = 0, 'every back-off must be a whole number of cron periods';
        foreach v_delay in array v_delays loop
            update pub.news_tracked_topics set next_check_at = now() + v_delay where source_key = 'rs-us' and topic_id = v_topic;
            assert exists (select 1 from jsonb_array_elements(pub_admin.news_revision_batch('rs-us', 25) -> 'dueTopics') d where d ->> 'topicId' = v_topic),
                   format('back-off %s: a topic due %s after the tick was skipped', v_expected[v_f + 1], v_delay);
        end loop;
    end loop;
    raise notice 'PASS: failure back-offs (12 / 24 / 48 h) are picked up by the tick that follows the apply delay';

    -- ---------------------------------------------------------------- 4. no over-eager rechecks, ordering, limit, isolation (unchanged behaviour)
    delete from pub.news_tracked_topics where source_key in ('rs-us', 'rs-eu');
    insert into pub.news_tracked_topics (source_key, topic_id, thread_origin, last_official_at, next_check_at, official_post_ids) values
        ('rs-us', 'topic:301', 'official', now(), now() - interval '3 hours', array[1]),
        ('rs-us', 'topic:302', 'official', now(), now() - interval '2 hours', array[2]),
        ('rs-us', 'topic:303', 'official', now(), now() + interval '10 minutes', array[3]),
        ('rs-us', 'topic:304', 'official', now(), now() + interval '16 minutes', array[4]),
        ('rs-us', 'topic:305', 'official', now(), now() + interval '5 hours', array[5]),
        ('rs-eu', 'topic:306', 'official', now(), now() - interval '9 hours', array[6]);
    v_batch := pub_admin.news_revision_batch('rs-us', 25);
    assert (select array_agg(d ->> 'topicId' order by ord) from jsonb_array_elements(v_batch -> 'dueTopics') with ordinality as x(d, ord))
           = array['topic:301', 'topic:302', 'topic:303'], format('due set / order wrong: %s', v_batch -> 'dueTopics');
    assert (select array_agg(d ->> 'topicId' order by ord) from jsonb_array_elements(pub_admin.news_revision_batch('rs-us', 2) -> 'dueTopics') with ordinality as x(d, ord))
           = array['topic:301', 'topic:302'], 'limit must keep the oldest-due-first order';
    assert not (v_batch -> 'dueTopics' @> '[{"topicId": "topic:306"}]'::jsonb), 'another source leaked into the batch';
    raise notice 'PASS: ordering, limit, isolation and "not due yet" topics are unchanged';

    -- ---------------------------------------------------------------- 5. security properties are unchanged by CREATE OR REPLACE
    assert (select provolatile = 's' and prosecdef and exists (select 1 from unnest(proconfig) c where c in ('search_path=""', 'search_path=')) from pg_proc where oid = 'pub_admin.news_revision_batch(text,integer)'::regprocedure),
           'news_revision_batch must stay STABLE SECURITY DEFINER with an empty search_path';
    assert has_function_privilege('azerdex_news_ingest', 'pub_admin.news_revision_batch(text,integer)', 'execute')
           and not has_function_privilege('foreverdb_web_reader', 'pub_admin.news_revision_batch(text,integer)', 'execute')
           and not has_function_privilege('anon', 'pub_admin.news_revision_batch(text,integer)', 'execute'),
           'news_revision_batch privileges changed';
    raise notice 'PASS: news_revision_batch keeps its security definition and ACL';
end
$t$;

rollback;
