-- ForeverDB PUBLIC READ MODEL 0010: reversible Bluepost reply suppression.
-- Collector admission is fixed separately and must be deployed before the
-- historical suppression operator script is run.

begin;
set local role foreverdb_pub_owner;

alter table pub.news_entries
    add column if not exists suppressed_at timestamptz,
    add column if not exists suppression_reason text;

create index if not exists news_entries_suppressed_idx
    on pub.news_entries (suppressed_at, source_key)
    where suppressed_at is not null;

create or replace function pub_admin.news_apply_sync(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_source jsonb := coalesce(p_payload -> 'source', '{}'::jsonb);
    v_run jsonb := coalesce(p_payload -> 'run', '{}'::jsonb);
    v_source_key text := v_source ->> 'sourceKey';
    v_source_type text := v_source ->> 'sourceType';
    v_run_id bigint;
    v_entry jsonb;
    v_entry_id bigint;
    v_old_hash text;
    v_existing_suppressed_at timestamptz;
    v_title text;
    v_source_entry_id text;
    v_slug text;
    v_hash text;
    v_write_applied boolean;
    v_upserted integer := 0;
    v_updated integer := 0;
begin
    if jsonb_typeof(p_payload) <> 'object'
       or v_source_key is null
       or v_source_type not in ('bluepost', 'official_news', 'azerdex')
       or v_source ->> 'region' not in ('us', 'eu', 'global')
       or (v_source ->> 'endpointUrl') is null then
        raise exception using errcode = '22023', message = 'invalid_news_sync_payload';
    end if;

    insert into pub.news_sources (source_key, source_type, region, endpoint_url, enabled, updated_at)
    values (v_source_key, v_source_type, v_source ->> 'region', v_source ->> 'endpointUrl',
            coalesce((v_source ->> 'enabled')::boolean, true), now())
    on conflict (source_key) do update set
        source_type = excluded.source_type,
        region = excluded.region,
        endpoint_url = excluded.endpoint_url,
        enabled = excluded.enabled,
        updated_at = now();

    insert into pub.news_sync_runs (source_key, started_at, status, fetched_count, accepted_count, rejected_count, error, diagnostics)
    values (v_source_key, coalesce((v_run ->> 'startedAt')::timestamptz, now()),
            'running', coalesce((v_run ->> 'fetchedCount')::integer, 0),
            coalesce((v_run ->> 'acceptedCount')::integer, 0),
            coalesce((v_run ->> 'rejectedCount')::integer, 0),
            nullif(v_run ->> 'error', ''), coalesce(v_run -> 'diagnostics', '{}'::jsonb))
    returning id into v_run_id;

    for v_entry in select value from jsonb_array_elements(coalesce(p_payload -> 'entries', '[]'::jsonb)) loop
        -- A Bluepost is only an authoritative topic opener. This guard is
        -- deliberately repeated at the persistence boundary so a stale or
        -- buggy collector cannot republish a reply.
        if v_source_type = 'bluepost' and coalesce(v_entry ->> 'sourcePostNumber', '') <> '1' then
            continue;
        end if;

        v_title := nullif(btrim(v_entry ->> 'title'), '');
        v_source_entry_id := nullif(btrim(v_entry ->> 'sourceEntryId'), '');
        v_hash := nullif(v_entry ->> 'contentHash', '');
        if v_title is null or v_source_entry_id is null or v_hash is null
           or v_hash !~ '^[0-9a-f]{64}$'
           or (v_entry ->> 'canonicalUrl') !~ '^https://'
           or (v_entry ->> 'status') not in ('published', 'review', 'rejected') then
            raise exception using errcode = '22023', message = 'invalid_news_entry';
        end if;

        select id, content_hash, suppressed_at into v_entry_id, v_old_hash, v_existing_suppressed_at
        from pub.news_entries
        where source_key = v_source_key and source_entry_id = v_source_entry_id;

        -- A previously suppressed row is immutable through ingestion. This
        -- prevents an accidental replay from clearing the historical marker.
        if v_existing_suppressed_at is not null then
            continue;
        end if;

        v_slug := left(trim(both '-' from regexp_replace(lower(v_title || '-' || v_source_key || '-' || v_source_entry_id), '[^a-z0-9]+', '-', 'g')), 140);
        v_write_applied := false;
        insert into pub.news_entries (
            source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug,
            canonical_url, title, author, region, published_at, modified_at, excerpt, category,
            relevance, status, importance, featured, content_hash
        ) values (
            v_source_key, v_source_entry_id, nullif(v_entry ->> 'sourceTopicId', ''),
            nullif(v_entry ->> 'sourcePostNumber', '')::integer, nullif(v_entry ->> 'threadKey', ''), v_slug,
            v_entry ->> 'canonicalUrl', v_title, nullif(v_entry ->> 'author', ''), v_entry ->> 'region',
            (v_entry ->> 'publishedAt')::timestamptz, nullif(v_entry ->> 'modifiedAt', '')::timestamptz,
            coalesce(v_entry ->> 'excerpt', ''), v_entry ->> 'category', v_entry ->> 'relevance',
            v_entry ->> 'status', coalesce((v_entry ->> 'importance')::smallint, 0),
            coalesce((v_entry ->> 'featured')::boolean, false), v_hash
        )
        on conflict (source_key, source_entry_id) do update set
            source_topic_id = excluded.source_topic_id,
            source_post_number = excluded.source_post_number,
            thread_key = excluded.thread_key,
            canonical_url = excluded.canonical_url,
            title = excluded.title,
            author = excluded.author,
            region = excluded.region,
            published_at = case when v_source_type = 'bluepost' then pub.news_entries.published_at else excluded.published_at end,
            modified_at = excluded.modified_at,
            excerpt = excluded.excerpt,
            category = excluded.category,
            relevance = excluded.relevance,
            status = excluded.status,
            importance = case when v_source_type = 'bluepost' then pub.news_entries.importance else excluded.importance end,
            featured = case when v_source_type = 'bluepost' then pub.news_entries.featured else excluded.featured end,
            content_hash = excluded.content_hash
        where pub.news_entries.content_hash is distinct from excluded.content_hash
        returning id into v_entry_id;

        v_write_applied := found;
        if not v_write_applied then
            select id into v_entry_id from pub.news_entries
            where source_key = v_source_key and source_entry_id = v_source_entry_id;
        else
            v_updated := v_updated + case when v_old_hash is null then 0 else 1 end;
            v_upserted := v_upserted + case when v_old_hash is null then 1 else 0 end;
        end if;

        if v_old_hash is distinct from v_hash then
            insert into pub.news_post_versions (news_entry_id, content_hash, snapshot)
            values (v_entry_id, v_hash, v_entry);
        end if;
    end loop;

    update pub.news_sync_runs
    set finished_at = coalesce((v_run ->> 'finishedAt')::timestamptz, now()),
        status = coalesce(v_run ->> 'status', 'succeeded'),
        updated_count = v_updated,
        error = nullif(v_run ->> 'error', ''),
        diagnostics = coalesce(v_run -> 'diagnostics', '{}'::jsonb)
    where id = v_run_id;

    update pub.news_sources
    set last_success_at = case when coalesce(v_run ->> 'status', 'succeeded') in ('succeeded', 'partial') then now() else last_success_at end,
        last_error_at = case when coalesce(v_run ->> 'status', 'succeeded') in ('failed', 'partial') then now() else last_error_at end,
        last_error = nullif(v_run ->> 'error', ''),
        updated_at = now()
    where source_key = v_source_key;

    return jsonb_build_object('runId', v_run_id, 'inserted', v_upserted, 'updated', v_updated);
end;
$$;

create or replace function web_api.news_list(p_category text, p_query text, p_limit integer, p_offset integer)
returns table (
    id bigint, slug text, source_type text, source_key text, source_entry_id text, source_topic_id text,
    thread_key text, canonical_url text, title text, author text, region text, published_at timestamptz,
    modified_at timestamptz, ingested_at timestamptz, excerpt text, category text, importance smallint,
    featured boolean, total_count bigint
)
language plpgsql stable security definer set search_path = ''
as $$
declare v_query text := lower(btrim(coalesce(p_query, '')));
begin
    if p_limit is null or p_limit < 1 or p_limit > 50 or p_offset is null or p_offset < 0 or p_offset > 5000
       or length(v_query) > 80 or v_query ~ '[%_\\]'
       or (p_category is not null and p_category not in ('bluepost', 'official_news', 'patch_notes', 'azerdex')) then
        raise exception using errcode = '22023', message = 'invalid_news_query';
    end if;
    return query
    select n.id, n.slug, s.source_type, n.source_key, n.source_entry_id, n.source_topic_id, n.thread_key,
           n.canonical_url, n.title, n.author, n.region, n.published_at, n.modified_at, n.ingested_at,
           n.excerpt, n.category, n.importance, n.featured, count(*) over ()
    from pub.news_entries n join pub.news_sources s using (source_key)
    where n.status = 'published'
      and n.suppressed_at is null
      and (s.source_type <> 'bluepost' or n.source_post_number = 1)
      and (p_category is null or n.category = p_category)
      and (v_query = '' or lower(n.title || ' ' || n.excerpt) like '%' || v_query || '%')
    order by n.published_at desc, n.id desc
    limit p_limit offset p_offset;
end;
$$;

create or replace function web_api.news_featured(p_limit integer)
returns table (
    id bigint, slug text, source_type text, source_key text, source_entry_id text, source_topic_id text,
    thread_key text, canonical_url text, title text, author text, region text, published_at timestamptz,
    modified_at timestamptz, ingested_at timestamptz, excerpt text, category text, importance smallint,
    featured boolean
)
language sql stable security definer set search_path = ''
as $$
    select n.id, n.slug, s.source_type, n.source_key, n.source_entry_id, n.source_topic_id, n.thread_key,
           n.canonical_url, n.title, n.author, n.region, n.published_at, n.modified_at, n.ingested_at,
           n.excerpt, n.category, n.importance, n.featured
    from pub.news_entries n join pub.news_sources s using (source_key)
    where n.status = 'published'
      and n.suppressed_at is null
      and (s.source_type <> 'bluepost' or n.source_post_number = 1)
    order by n.featured desc, n.importance desc, n.published_at desc, n.id desc
    limit least(greatest(coalesce(p_limit, 4), 1), 12);
$$;

create or replace function web_api.news_entry(p_slug text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
    select jsonb_build_object(
        'id', n.id, 'slug', n.slug, 'sourceType', s.source_type, 'sourceKey', n.source_key,
        'sourceEntryId', n.source_entry_id, 'sourceTopicId', n.source_topic_id, 'sourcePostNumber', n.source_post_number, 'threadKey', n.thread_key,
        'canonicalUrl', n.canonical_url, 'title', n.title, 'author', n.author, 'region', n.region,
        'publishedAt', n.published_at, 'modifiedAt', n.modified_at, 'ingestedAt', n.ingested_at,
        'excerpt', n.excerpt, 'category', n.category, 'importance', n.importance, 'featured', n.featured)
    from pub.news_entries n join pub.news_sources s using (source_key)
    where n.status = 'published'
      and n.suppressed_at is null
      and (s.source_type <> 'bluepost' or n.source_post_number = 1)
      and n.slug = p_slug;
$$;

do $verify$
begin
    if has_table_privilege('foreverdb_web_reader', 'pub.news_entries', 'select')
       or has_table_privilege('foreverdb_publisher', 'pub.news_entries', 'update') then
        raise exception 'News boundary FAILED after suppression migration';
    end if;
end
$verify$;

commit;
