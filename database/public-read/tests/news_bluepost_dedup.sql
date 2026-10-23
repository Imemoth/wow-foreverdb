-- Run as the public-read owner after 0010_news_bluepost_suppression.sql.
-- This is transactional and leaves no rows behind.

begin;
set local role foreverdb_pub_owner;

do $verify$
declare
    v_payload jsonb;
    v_result jsonb;
    v_reply_count integer;
    v_visible_count integer;
    v_versions integer;
    v_entry_id bigint;
begin
    v_payload := jsonb_build_object(
        'source', jsonb_build_object(
            'sourceKey', 'dedup-test-source', 'sourceType', 'bluepost', 'region', 'us',
            'endpointUrl', 'https://example.com/news', 'enabled', true
        ),
        'run', jsonb_build_object('status', 'succeeded', 'fetchedCount', 1, 'acceptedCount', 1, 'rejectedCount', 0),
        'entries', jsonb_build_array(jsonb_build_object(
            'sourceEntryId', 'post:reply-not-allowed', 'sourceTopicId', 'topic:dedup',
            'sourcePostNumber', 2, 'threadKey', 'us:topic:dedup',
            'canonicalUrl', 'https://example.com/t/dedup/1/2', 'title', 'World of Warcraft: Forever reply',
            'author', 'ordinary-player', 'region', 'us', 'publishedAt', '2026-10-22T00:00:00Z',
            'modifiedAt', null, 'excerpt', 'reply', 'category', 'bluepost', 'relevance', 'relevant',
            'status', 'published', 'importance', 0, 'featured', false, 'contentHash', repeat('a', 64)
        ))
    );

    select pub_admin.news_apply_sync(v_payload) into v_result;
    if (v_result ->> 'inserted')::integer <> 0 then
        raise exception 'Reply payload inserted a Bluepost row: %', v_result;
    end if;
    select count(*) into v_reply_count from pub.news_entries where source_key = 'dedup-test-source';
    if v_reply_count <> 0 then raise exception 'Reply payload left a row behind'; end if;

    -- A retry can encounter a historical version hash even when the current
    -- entry hash is older (for example, after a prior partial revision run).
    -- The migration must preserve that history without raising a duplicate-key
    -- error or creating another copy of the same version.
    v_payload := jsonb_set(v_payload, '{entries,0,sourceEntryId}', '"post:original"');
    v_payload := jsonb_set(v_payload, '{entries,0,sourcePostNumber}', '1');
    v_payload := jsonb_set(v_payload, '{entries,0,title}', '"World of Warcraft: Forever original"');
    v_payload := jsonb_set(v_payload, '{entries,0,canonicalUrl}', '"https://example.com/t/dedup/1/1"');
    v_payload := jsonb_set(v_payload, '{entries,0,contentHash}', to_jsonb(repeat('c', 64)));
    select pub_admin.news_apply_sync(v_payload) into v_result;
    if (v_result ->> 'inserted')::integer <> 1 then
        raise exception 'Original fixture did not insert: %', v_result;
    end if;
    select id into v_entry_id from pub.news_entries
    where source_key = 'dedup-test-source' and source_entry_id = 'post:original';
    insert into pub.news_post_versions(news_entry_id, content_hash, snapshot)
    values (v_entry_id, repeat('d', 64), jsonb_build_object('sourceEntryId', 'post:original'));
    v_payload := jsonb_set(v_payload, '{entries,0,contentHash}', to_jsonb(repeat('d', 64)));
    v_payload := jsonb_set(v_payload, '{entries,0,excerpt}', '"replayed revision"');
    select pub_admin.news_apply_sync(v_payload) into v_result;
    if (v_result ->> 'updated')::integer <> 1 then
        raise exception 'Historical version replay did not update the opener: %', v_result;
    end if;
    select count(*) into v_versions from pub.news_post_versions where news_entry_id = v_entry_id;
    if v_versions <> 2 then raise exception 'Historical version replay duplicated version history'; end if;

    insert into pub.news_sources(source_key, source_type, region, endpoint_url)
    values ('dedup-fixture-source', 'bluepost', 'us', 'https://example.com/news')
    on conflict (source_key) do nothing;
    insert into pub.news_entries(
        source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug,
        canonical_url, title, author, region, published_at, excerpt, category, relevance,
        status, content_hash, suppressed_at, suppression_reason
    ) values (
        'dedup-fixture-source', 'post:suppressed-reply', 'topic:dedup', 2, 'us:topic:dedup',
        'suppressed-reply-fixture', 'https://example.com/t/dedup/1/2', 'Suppressed reply fixture',
        'ordinary-player', 'us', '2026-10-22T00:00:00Z', 'reply', 'bluepost', 'relevant', 'published',
        repeat('b', 64), now(), 'bluepost_reply_dedup_v1:test'
    );
    insert into pub.news_post_versions(news_entry_id, content_hash, snapshot)
    select id, repeat('b', 64), jsonb_build_object('sourceEntryId', 'post:suppressed-reply')
    from pub.news_entries where source_entry_id = 'post:suppressed-reply';

    v_payload := jsonb_set(v_payload, '{source,sourceKey}', '"dedup-fixture-source"');
    select pub_admin.news_apply_sync(v_payload) into v_result;
    select count(*) into v_reply_count from pub.news_entries where source_entry_id = 'post:suppressed-reply';
    if v_reply_count <> 1 then raise exception 'Suppressed reply was duplicated'; end if;
    select count(*) into v_versions from pub.news_post_versions v join pub.news_entries e on e.id = v.news_entry_id where e.source_entry_id = 'post:suppressed-reply';
    if v_versions <> 1 then raise exception 'Suppressed reply version history changed'; end if;

    select count(*) into v_visible_count
    from web_api.news_list(null, '', 50, 0)
    where source_entry_id = 'post:suppressed-reply';
    if v_visible_count <> 0 then raise exception 'Suppressed reply leaked through news_list'; end if;
    if web_api.news_entry('suppressed-reply-fixture') is not null then
        raise exception 'Suppressed reply leaked through news_entry';
    end if;
end
$verify$;

rollback;
