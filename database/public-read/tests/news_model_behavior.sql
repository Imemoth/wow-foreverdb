-- Run as the public-read owner after 0001_public_read_model.sql and
-- 0002_news_model.sql. The transaction is rolled back, so this is safe for a
-- disposable verification database and leaves no news rows behind.

begin;

do $verify$
declare
    v_payload jsonb;
    v_entry jsonb;
    v_result jsonb;
    v_versions integer;
    v_sync_error text;
begin
    v_entry := jsonb_build_object(
        'sourceEntryId', 'post:test-1',
        'sourceTopicId', 'topic:test-1',
        'sourcePostNumber', 1,
        'threadKey', 'us:topic:test-1',
        'canonicalUrl', 'https://example.com/news/test-1',
        'title', 'World of Warcraft: Forever test entry',
        'author', 'AzerDex test',
        'region', 'us',
        'publishedAt', '2026-10-22T00:00:00Z',
        'modifiedAt', null,
        'excerpt', 'A disposable persistence test.',
        'category', 'bluepost',
        'relevance', 'relevant',
        'status', 'published',
        'importance', 0,
        'featured', false,
        'contentHash', repeat('a', 64)
    );
    v_payload := jsonb_build_object(
        'source', jsonb_build_object(
            'sourceKey', 'test-news-source', 'sourceType', 'bluepost', 'region', 'us',
            'endpointUrl', 'https://example.com/news', 'enabled', true
        ),
        'run', jsonb_build_object(
            'startedAt', '2026-10-22T00:00:00Z', 'finishedAt', '2026-10-22T00:00:01Z',
            'status', 'succeeded', 'fetchedCount', 1, 'acceptedCount', 1,
            'rejectedCount', 0, 'diagnostics', jsonb_build_object('pages', 1, 'mode', 'normal')
        ),
        'entries', jsonb_build_array(v_entry)
    );

    select pub_admin.news_apply_sync(v_payload) into v_result;
    if (v_result ->> 'inserted')::integer <> 1 then
        raise exception 'Expected first sync to insert one row: %', v_result;
    end if;
    select count(*) into v_versions from pub.news_post_versions v
    join pub.news_entries e on e.id = v.news_entry_id
    where e.source_key = 'test-news-source' and e.source_entry_id = 'post:test-1';
    if v_versions <> 1 then raise exception 'Expected one initial version, got %', v_versions; end if;

    select pub_admin.news_apply_sync(v_payload) into v_result;
    if (v_result ->> 'inserted')::integer <> 0 or (v_result ->> 'updated')::integer <> 0 then
        raise exception 'Identical sync was not a no-op: %', v_result;
    end if;
    select count(*) into v_versions from pub.news_post_versions v
    join pub.news_entries e on e.id = v.news_entry_id
    where e.source_key = 'test-news-source' and e.source_entry_id = 'post:test-1';
    if v_versions <> 1 then raise exception 'Identical sync created a version: %', v_versions; end if;

    v_entry := jsonb_set(v_entry, '{contentHash}', to_jsonb(repeat('b', 64)));
    v_entry := jsonb_set(v_entry, '{excerpt}', to_jsonb('The updated disposable test.'::text));
    v_payload := jsonb_set(v_payload, '{entries}', jsonb_build_array(v_entry));
    select pub_admin.news_apply_sync(v_payload) into v_result;
    if (v_result ->> 'updated')::integer <> 1 then
        raise exception 'Changed sync did not update one row: %', v_result;
    end if;
    select count(*) into v_versions from pub.news_post_versions v
    join pub.news_entries e on e.id = v.news_entry_id
    where e.source_key = 'test-news-source' and e.source_entry_id = 'post:test-1';
    if v_versions <> 2 then raise exception 'Changed sync did not create a second version: %', v_versions; end if;

    v_payload := jsonb_set(v_payload, '{entries}', '[]'::jsonb);
    v_payload := jsonb_set(v_payload, '{run,status}', '"partial"'::jsonb);
    v_payload := jsonb_set(v_payload, '{run,error}', '"topic revision unavailable"'::jsonb);
    select pub_admin.news_apply_sync(v_payload) into v_result;
    select error into v_sync_error from pub.news_sync_runs
    where source_key = 'test-news-source' order by id desc limit 1;
    if v_sync_error <> 'topic revision unavailable' then raise exception 'Sync error was not audited'; end if;
    if not exists (select 1 from pub.news_sources where source_key = 'test-news-source' and last_error_at is not null) then
        raise exception 'Partial sync did not update source error health';
    end if;
end
$verify$;

rollback;
