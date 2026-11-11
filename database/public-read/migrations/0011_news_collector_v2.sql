-- ForeverDB PUBLIC READ MODEL 0011: News Collector V2 (verified official updates).
--
-- Additive and backward compatible with the deployed V1 collector and website:
--   * the previous payload shape is still accepted (openers, no provenance);
--   * web_api.news_list / news_featured / news_entry keep their signatures and
--     columns, so the current website keeps working between this migration and
--     the website deployment;
--   * no historical row is rewritten, no row or version is deleted, and rows
--     carrying suppressed_at remain immutable through ingestion.
--
-- What changes:
--   1. Verified Blizzard staff replies may be stored (post_number > 1) but ONLY
--      with provenance proven at the persistence boundary: an allow-listed
--      Blizzard group, a numeric user id that the collector observed in the
--      region's authoritative Blizzard Tracker feed, and a verified thread
--      origin. Display names and usernames are never an authority.
--   2. Public read functions return ONE card per region/topic (thread) ordered
--      by the latest verified official activity. published_at is never
--      modified; official_updated_at is a separate column.
--   3. Persistent, bounded revision tracking (pub.news_tracked_topics) and a
--      read-only RPC that hands the collector its due batch.
--   4. Source freshness/health columns and a read-only health snapshot.
--   5. Editorial featured/importance are never overwritten by ingestion.
--   6. A feed observation can no longer overwrite richer topic-JSON content
--      (fixes the hash flip-flop that rewrote ~25 rows per revision cycle).

begin;
set local role foreverdb_pub_owner;

-- ---------------------------------------------------------------------------
-- 1. Schema additions (all nullable / defaulted).
-- ---------------------------------------------------------------------------
alter table pub.news_entries
    add column if not exists source_version integer,
    add column if not exists author_user_id bigint,
    add column if not exists author_group text,
    add column if not exists thread_origin text,
    add column if not exists official_updated_at timestamptz,
    add column if not exists observed_via text;

alter table pub.news_entries drop constraint if exists news_entries_thread_origin_chk;
alter table pub.news_entries add constraint news_entries_thread_origin_chk
    check (thread_origin is null or thread_origin in ('official', 'community'));
alter table pub.news_entries drop constraint if exists news_entries_observed_via_chk;
alter table pub.news_entries add constraint news_entries_observed_via_chk
    check (observed_via is null or observed_via in ('feed', 'topic'));

alter table pub.news_sources
    add column if not exists last_attempt_at timestamptz,
    add column if not exists last_fetch_ok_at timestamptz,
    add column if not exists last_official_post_at timestamptz,
    add column if not exists last_http_status smallint,
    add column if not exists last_error_category text;

alter table pub.news_sync_runs
    add column if not exists mode text,
    add column if not exists inserted_count integer not null default 0,
    add column if not exists skipped_count integer not null default 0,
    add column if not exists fetch_ok boolean,
    add column if not exists error_category text,
    add column if not exists http_status smallint;

create table if not exists pub.news_official_groups (
    group_name text primary key check (group_name ~ '^[a-z0-9_-]{2,60}$')
);
insert into pub.news_official_groups (group_name)
values ('community-manager'), ('api_users'), ('wow-developer')
on conflict do nothing;

-- Region-scoped verified Blizzard staff identities (a numeric forum user id is
-- only meaningful inside one region's forum; the same person has a different id
-- on the EU forum). Rows are written exclusively by pub_admin.news_apply_sync
-- from identities the collector observed in that region's Tracker feed.
create table if not exists pub.news_verified_staff (
    source_key text not null references pub.news_sources(source_key),
    user_id bigint not null,
    username text,
    group_name text not null references pub.news_official_groups(group_name),
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    primary key (source_key, user_id)
);

-- Persistent revision schedule. A topic stays tracked as long as it has a
-- verified official post, independent of the Tracker's newest-20 window.
create table if not exists pub.news_tracked_topics (
    source_key text not null references pub.news_sources(source_key),
    topic_id text not null check (topic_id ~ '^topic:[0-9]{1,12}$'),
    thread_key text,
    thread_origin text check (thread_origin is null or thread_origin in ('official', 'community')),
    opener_user_id bigint,
    topic_created_at timestamptz,
    first_seen_at timestamptz not null default now(),
    last_official_at timestamptz,
    last_checked_at timestamptz,
    next_check_at timestamptz not null default now(),
    consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
    last_http_status smallint,
    last_error text,
    state text not null default 'active' check (state in ('active', 'warm', 'dormant')),
    official_post_ids bigint[] not null default '{}',
    primary key (source_key, topic_id)
);
alter table pub.news_tracked_topics add column if not exists official_post_ids bigint[] not null default '{}';
create index if not exists news_tracked_topics_due_idx
    on pub.news_tracked_topics (source_key, next_check_at);

-- Seed revision tracking with the verified openers that already exist, staggered 2 minutes apart. Idempotent.
insert into pub.news_tracked_topics (source_key, topic_id, thread_key, thread_origin, last_official_at, official_post_ids, next_check_at)
select q.source_key, q.source_topic_id, q.thread_key, 'official', q.last_official_at, array[q.post_id],
       now() + (row_number() over (order by q.published_at desc)) * interval '2 minutes'
from (
    select n.source_key, n.source_topic_id, n.thread_key, n.published_at,
           greatest(n.published_at, coalesce(n.modified_at, n.published_at)) as last_official_at,
           substring(n.source_entry_id from 6)::bigint as post_id
    from pub.news_entries n
    join pub.news_sources s using (source_key)
    where s.source_type = 'bluepost' and n.source_post_number = 1 and n.status = 'published' and n.suppressed_at is null
      and n.source_topic_id ~ '^topic:[0-9]{1,12}$' and n.source_entry_id ~ '^post:[0-9]{1,15}$'
) q
on conflict (source_key, topic_id) do nothing;

alter table pub.news_official_groups enable row level security;
alter table pub.news_verified_staff enable row level security;
alter table pub.news_tracked_topics enable row level security;
revoke all on pub.news_official_groups, pub.news_verified_staff, pub.news_tracked_topics from public;
revoke all on pub.news_official_groups, pub.news_verified_staff, pub.news_tracked_topics
    from foreverdb_web_reader, foreverdb_publisher;

-- ---------------------------------------------------------------------------
-- 2. The only rows the public API may ever expose. Internal: not granted to any
--    API role; read exclusively by the SECURITY DEFINER web_api functions.
--    Replies are visible only with complete verified provenance (fail closed);
--    suppressed rows stay hidden; future-dated rows (an official article that is
--    published in advance) are hidden until their time arrives.
-- ---------------------------------------------------------------------------
create or replace view pub.news_card_entries as
select n.id, n.slug, s.source_type, n.source_key, n.source_entry_id, n.source_topic_id,
       n.source_post_number, n.thread_key, n.canonical_url, n.title, n.author, n.region,
       n.published_at, n.modified_at, n.official_updated_at, n.ingested_at, n.excerpt,
       n.category, n.importance, n.featured, n.thread_origin, n.source_version,
       greatest(n.published_at, coalesce(n.official_updated_at, n.published_at)) as official_at,
       coalesce(n.thread_key, 'entry:' || n.id::text) as card_key,
       case
           when n.source_post_number is null then 'article'
           when n.source_post_number = 1 then 'announcement'
           when n.thread_origin = 'official' then 'official_update'
           else 'staff_reply'
       end as entry_kind
from pub.news_entries n
join pub.news_sources s using (source_key)
where n.status = 'published'
  and n.suppressed_at is null
  and (
      s.source_type <> 'bluepost'
      or n.source_post_number = 1
      or (n.source_post_number > 1
          and n.author_user_id is not null
          and n.author_group is not null
          and n.thread_origin is not null)
  )
  and greatest(n.published_at, coalesce(n.official_updated_at, n.published_at)) <= now() + interval '15 minutes';

revoke all on pub.news_card_entries from public, foreverdb_web_reader, foreverdb_publisher;

-- ---------------------------------------------------------------------------
-- 3. Persistence boundary. Same signature as 0010; result is a superset.
-- ---------------------------------------------------------------------------
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
    v_dry boolean := coalesce((v_run ->> 'dryRun')::boolean, false);
    v_run_id bigint;
    v_entry jsonb;
    v_staff jsonb;
    v_check jsonb;
    v_entry_id bigint;
    v_old_hash text;
    v_old_via text;
    v_existing_suppressed_at timestamptz;
    v_exists boolean;
    v_title text;
    v_source_entry_id text;
    v_slug text;
    v_hash text;
    v_post_number integer;
    v_is_reply boolean;
    v_uid bigint;
    v_group text;
    v_origin text;
    v_via text;
    v_official_at timestamptz;
    v_newest_official timestamptz;
    v_topic_id text;
    v_staff_ok boolean;
    v_write_applied boolean;
    v_inserted integer := 0;
    v_updated integer := 0;
    v_skipped integer := 0;
    v_skipped_unverified integer := 0;
    v_action text;
    v_report jsonb := '[]'::jsonb;
    v_group_ok boolean;
    v_failures integer;
    v_status text := coalesce(v_run ->> 'status', 'succeeded');
begin
    if jsonb_typeof(p_payload) <> 'object'
       or v_source_key is null
       or v_source_type not in ('bluepost', 'official_news', 'azerdex')
       or v_source ->> 'region' not in ('us', 'eu', 'global')
       or (v_source ->> 'endpointUrl') is null then
        raise exception using errcode = '22023', message = 'invalid_news_sync_payload';
    end if;
    if v_status not in ('succeeded', 'partial', 'failed') then
        raise exception using errcode = '22023', message = 'invalid_news_sync_payload';
    end if;

    if not v_dry then
        insert into pub.news_sources (source_key, source_type, region, endpoint_url, enabled, updated_at)
        values (v_source_key, v_source_type, v_source ->> 'region', v_source ->> 'endpointUrl',
                coalesce((v_source ->> 'enabled')::boolean, true), now())
        on conflict (source_key) do update set
            source_type = excluded.source_type,
            region = excluded.region,
            endpoint_url = excluded.endpoint_url,
            enabled = excluded.enabled,
            updated_at = now();

        insert into pub.news_sync_runs (source_key, started_at, status, fetched_count, accepted_count, rejected_count,
                                        error, diagnostics, mode, fetch_ok, error_category, http_status)
        values (v_source_key, coalesce((v_run ->> 'startedAt')::timestamptz, now()),
                'running', coalesce((v_run ->> 'fetchedCount')::integer, 0),
                coalesce((v_run ->> 'acceptedCount')::integer, 0),
                coalesce((v_run ->> 'rejectedCount')::integer, 0),
                nullif(v_run ->> 'error', ''), coalesce(v_run -> 'diagnostics', '{}'::jsonb),
                nullif(v_run ->> 'mode', ''), (v_run ->> 'fetchOk')::boolean,
                nullif(left(v_run ->> 'errorCategory', 60), ''), nullif(v_run ->> 'httpStatus', '')::smallint)
        returning id into v_run_id;

        -- Region-scoped staff identities observed in this region's Tracker feed.
        -- Only allow-listed Blizzard groups are recorded; anything else is ignored.
        for v_staff in select value from jsonb_array_elements(coalesce(v_run -> 'verifiedStaff', '[]'::jsonb)) loop
            v_uid := nullif(v_staff ->> 'userId', '')::bigint;
            v_group := nullif(v_staff ->> 'group', '');
            if v_uid is null or v_uid <= 0 or v_group is null then continue; end if;
            if not exists (select 1 from pub.news_official_groups g where g.group_name = v_group) then continue; end if;
            insert into pub.news_verified_staff (source_key, user_id, username, group_name)
            values (v_source_key, v_uid, left(nullif(v_staff ->> 'username', ''), 80), v_group)
            on conflict (source_key, user_id) do update set
                username = coalesce(excluded.username, pub.news_verified_staff.username),
                group_name = excluded.group_name,
                last_seen_at = now();
        end loop;
    end if;

    for v_entry in select value from jsonb_array_elements(coalesce(p_payload -> 'entries', '[]'::jsonb)) loop
        v_action := null;
        v_post_number := nullif(v_entry ->> 'sourcePostNumber', '')::integer;
        v_source_entry_id := nullif(btrim(v_entry ->> 'sourceEntryId'), '');

        -- Blueposts require a numeric post number. Reply (> 1) admission is
        -- re-verified here so a stale or buggy collector cannot publish a player
        -- reply or an unverified staff claim.
        v_is_reply := v_source_type = 'bluepost' and coalesce(v_post_number, 0) <> 1;
        if v_source_type = 'bluepost' and v_post_number is null then
            v_skipped := v_skipped + 1;
            v_action := 'skip_missing_post_number';
        elsif v_is_reply then
            v_uid := nullif(v_entry ->> 'authorUserId', '')::bigint;
            v_group := nullif(v_entry ->> 'authorGroup', '');
            v_origin := nullif(v_entry ->> 'threadOrigin', '');
            select exists (select 1 from pub.news_official_groups g where g.group_name = v_group) into v_group_ok;
            v_staff_ok := v_uid is not null and (
                exists (select 1 from pub.news_verified_staff st
                        join pub.news_official_groups g on g.group_name = st.group_name
                        where st.source_key = v_source_key and st.user_id = v_uid)
                or (v_dry and exists (
                        select 1 from jsonb_array_elements(coalesce(v_run -> 'verifiedStaff', '[]'::jsonb)) vs
                        join pub.news_official_groups g on g.group_name = vs.value ->> 'group'
                        where nullif(vs.value ->> 'userId', '')::bigint = v_uid)));
            if v_uid is null or v_group is null or not v_group_ok
               or v_origin is null or v_origin not in ('official', 'community')
               or coalesce(v_entry ->> 'status', '') <> 'published'
               or not coalesce(v_staff_ok, false) then
                v_skipped := v_skipped + 1;
                v_skipped_unverified := v_skipped_unverified + 1;
                v_action := 'skip_unverified_reply';
            end if;
        end if;

        if v_action is not null then
            if v_dry and jsonb_array_length(v_report) < 500 then
                v_report := v_report || jsonb_build_object('sourceEntryId', v_source_entry_id, 'action', v_action);
            end if;
            continue;
        end if;

        v_title := nullif(btrim(v_entry ->> 'title'), '');
        v_hash := nullif(v_entry ->> 'contentHash', '');
        if v_title is null or v_source_entry_id is null or v_hash is null
           or v_hash !~ '^[0-9a-f]{64}$'
           or (v_entry ->> 'canonicalUrl') !~ '^https://'
           or (v_entry ->> 'status') not in ('published', 'review', 'rejected') then
            raise exception using errcode = '22023', message = 'invalid_news_entry';
        end if;

        v_via := nullif(v_entry ->> 'observedVia', '');
        if v_via is not null and v_via not in ('feed', 'topic') then
            raise exception using errcode = '22023', message = 'invalid_news_entry';
        end if;
        v_uid := nullif(v_entry ->> 'authorUserId', '')::bigint;
        v_group := nullif(v_entry ->> 'authorGroup', '');
        v_origin := nullif(v_entry ->> 'threadOrigin', '');
        if v_origin is not null and v_origin not in ('official', 'community') then
            raise exception using errcode = '22023', message = 'invalid_news_entry';
        end if;
        v_official_at := nullif(v_entry ->> 'officialUpdatedAt', '')::timestamptz;

        select true, id, content_hash, suppressed_at, observed_via
          into v_exists, v_entry_id, v_old_hash, v_existing_suppressed_at, v_old_via
        from pub.news_entries
        where source_key = v_source_key and source_entry_id = v_source_entry_id;
        v_exists := coalesce(v_exists, false);

        -- A previously suppressed row is immutable through ingestion, so a
        -- replay can never resurrect it or clear its historical marker.
        if v_exists and v_existing_suppressed_at is not null then
            v_skipped := v_skipped + 1;
            if v_dry and jsonb_array_length(v_report) < 500 then
                v_report := v_report || jsonb_build_object('sourceEntryId', v_source_entry_id, 'action', 'skip_suppressed');
            end if;
            continue;
        end if;

        if v_dry then
            v_action := case
                when not v_exists then 'insert'
                when v_old_hash = v_hash then 'unchanged'
                when coalesce(v_old_via, '') = 'topic' and coalesce(v_via, '') = 'feed' then 'skip_feed_over_topic'
                else 'update'
            end;
            if v_action = 'insert' then v_inserted := v_inserted + 1;
            elsif v_action = 'update' then v_updated := v_updated + 1;
            else v_skipped := v_skipped + 1; end if;
            if jsonb_array_length(v_report) < 500 then
                v_report := v_report || jsonb_build_object('sourceEntryId', v_source_entry_id, 'action', v_action,
                    'status', v_entry ->> 'status', 'postNumber', v_post_number);
            end if;
            continue;
        end if;

        v_slug := left(trim(both '-' from regexp_replace(lower(v_title || '-' || v_source_key || '-' || v_source_entry_id), '[^a-z0-9]+', '-', 'g')), 140);
        v_write_applied := false;
        insert into pub.news_entries (
            source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug,
            canonical_url, title, author, region, published_at, modified_at, excerpt, category,
            relevance, status, importance, featured, content_hash,
            source_version, author_user_id, author_group, thread_origin, official_updated_at, observed_via
        ) values (
            v_source_key, v_source_entry_id, nullif(v_entry ->> 'sourceTopicId', ''),
            v_post_number, nullif(v_entry ->> 'threadKey', ''), v_slug,
            v_entry ->> 'canonicalUrl', v_title, nullif(v_entry ->> 'author', ''), v_entry ->> 'region',
            (v_entry ->> 'publishedAt')::timestamptz, nullif(v_entry ->> 'modifiedAt', '')::timestamptz,
            coalesce(v_entry ->> 'excerpt', ''), v_entry ->> 'category', v_entry ->> 'relevance',
            v_entry ->> 'status', coalesce((v_entry ->> 'importance')::smallint, 0),
            coalesce((v_entry ->> 'featured')::boolean, false), v_hash,
            nullif(v_entry ->> 'sourceVersion', '')::integer, v_uid, v_group, v_origin, v_official_at, v_via
        )
        on conflict (source_key, source_entry_id) do update set
            source_topic_id = excluded.source_topic_id,
            source_post_number = excluded.source_post_number,
            thread_key = excluded.thread_key,
            canonical_url = excluded.canonical_url,
            title = excluded.title,
            author = excluded.author,
            region = excluded.region,
            -- Original publication time is immutable for forum posts.
            published_at = case when v_source_type = 'bluepost' then pub.news_entries.published_at else excluded.published_at end,
            modified_at = excluded.modified_at,
            excerpt = excluded.excerpt,
            category = excluded.category,
            relevance = excluded.relevance,
            status = excluded.status,
            -- Editorial fields are never owned by the collector.
            importance = pub.news_entries.importance,
            featured = pub.news_entries.featured,
            content_hash = excluded.content_hash,
            source_version = coalesce(excluded.source_version, pub.news_entries.source_version),
            author_user_id = coalesce(excluded.author_user_id, pub.news_entries.author_user_id),
            author_group = coalesce(excluded.author_group, pub.news_entries.author_group),
            thread_origin = coalesce(excluded.thread_origin, pub.news_entries.thread_origin),
            official_updated_at = greatest(excluded.official_updated_at, pub.news_entries.official_updated_at),
            observed_via = case when excluded.observed_via = 'topic' or pub.news_entries.observed_via is null
                                then excluded.observed_via else pub.news_entries.observed_via end
        where pub.news_entries.content_hash is distinct from excluded.content_hash
          -- A shorter feed excerpt must never overwrite richer topic content.
          and not (coalesce(pub.news_entries.observed_via, '') = 'topic' and coalesce(excluded.observed_via, '') = 'feed')
        returning id into v_entry_id;

        v_write_applied := found;
        if not v_write_applied then
            select id into v_entry_id from pub.news_entries
            where source_key = v_source_key and source_entry_id = v_source_entry_id;
            v_skipped := v_skipped + 1;
        else
            v_updated := v_updated + case when v_old_hash is null then 0 else 1 end;
            v_inserted := v_inserted + case when v_old_hash is null then 1 else 0 end;
            insert into pub.news_post_versions (news_entry_id, content_hash, snapshot)
            values (v_entry_id, v_hash, v_entry)
            on conflict (news_entry_id, content_hash) do nothing;
        end if;

        if v_source_type = 'bluepost' and v_entry ->> 'status' = 'published' then
            v_topic_id := nullif(v_entry ->> 'sourceTopicId', '');
            v_newest_official := greatest(v_newest_official,
                greatest((v_entry ->> 'publishedAt')::timestamptz, coalesce(v_official_at, (v_entry ->> 'publishedAt')::timestamptz)));
            if v_topic_id ~ '^topic:[0-9]{1,12}$' and v_source_entry_id ~ '^post:[0-9]{1,15}$' then
                insert into pub.news_tracked_topics (source_key, topic_id, thread_key, thread_origin, last_official_at, official_post_ids)
                values (v_source_key, v_topic_id, nullif(v_entry ->> 'threadKey', ''), v_origin,
                        greatest((v_entry ->> 'publishedAt')::timestamptz, coalesce(v_official_at, (v_entry ->> 'publishedAt')::timestamptz)),
                        array[substring(v_source_entry_id from 6)::bigint])
                on conflict (source_key, topic_id) do update set
                    last_official_at = greatest(pub.news_tracked_topics.last_official_at, excluded.last_official_at),
                    thread_origin = coalesce(pub.news_tracked_topics.thread_origin, excluded.thread_origin),
                    -- bounded: the 50 newest official post ids per topic
                    official_post_ids = (select coalesce(array_agg(x order by x desc), '{}')
                                         from (select distinct x from unnest(pub.news_tracked_topics.official_post_ids || excluded.official_post_ids) x
                                               order by x desc limit 50) q);
            end if;
        elsif v_source_type <> 'bluepost' and v_entry ->> 'status' = 'published' then
            v_newest_official := greatest(v_newest_official, (v_entry ->> 'publishedAt')::timestamptz);
        end if;
    end loop;

    if v_dry then
        return jsonb_build_object('dryRun', true, 'inserted', v_inserted, 'updated', v_updated,
                                  'skipped', v_skipped, 'skippedUnverified', v_skipped_unverified, 'report', v_report);
    end if;

    -- Per-topic revision outcomes: schedule the next check (bounded, tiered,
    -- exponential back-off on failure; never an unbounded retry loop).
    for v_check in select value from jsonb_array_elements(coalesce(v_run -> 'topicChecks', '[]'::jsonb)) loop
        v_topic_id := nullif(v_check ->> 'topicId', '');
        continue when v_topic_id is null or v_topic_id !~ '^topic:[0-9]{1,12}$';
        v_origin := nullif(v_check ->> 'threadOrigin', '');
        if v_origin is not null and v_origin not in ('official', 'community') then v_origin := null; end if;
        if coalesce((v_check ->> 'ok')::boolean, false) then
            update pub.news_tracked_topics t set
                last_checked_at = now(),
                consecutive_failures = 0,
                last_http_status = nullif(v_check ->> 'httpStatus', '')::smallint,
                last_error = null,
                thread_origin = coalesce(v_origin, t.thread_origin),
                opener_user_id = coalesce(nullif(v_check ->> 'openerUserId', '')::bigint, t.opener_user_id),
                topic_created_at = coalesce(nullif(v_check ->> 'topicCreatedAt', '')::timestamptz, t.topic_created_at),
                state = case when now() - coalesce(t.last_official_at, t.first_seen_at) < interval '14 days' then 'active'
                             when now() - coalesce(t.last_official_at, t.first_seen_at) < interval '90 days' then 'warm'
                             else 'dormant' end,
                next_check_at = now() + case
                    when now() - coalesce(t.last_official_at, t.first_seen_at) < interval '14 days' then interval '6 hours'
                    when now() - coalesce(t.last_official_at, t.first_seen_at) < interval '90 days' then interval '24 hours'
                    else interval '7 days' end
            where t.source_key = v_source_key and t.topic_id = v_topic_id;
        else
            update pub.news_tracked_topics t set
                last_checked_at = now(),
                consecutive_failures = t.consecutive_failures + 1,
                last_http_status = nullif(v_check ->> 'httpStatus', '')::smallint,
                last_error = left(nullif(v_check ->> 'error', ''), 120),
                next_check_at = now() + least(interval '6 hours' * power(2, least(t.consecutive_failures + 1, 4)), interval '48 hours')
            where t.source_key = v_source_key and t.topic_id = v_topic_id;
        end if;
    end loop;

    update pub.news_sync_runs
    set finished_at = coalesce((v_run ->> 'finishedAt')::timestamptz, now()),
        status = v_status,
        updated_count = v_updated,
        inserted_count = v_inserted,
        skipped_count = v_skipped,
        error = nullif(v_run ->> 'error', ''),
        diagnostics = coalesce(v_run -> 'diagnostics', '{}'::jsonb)
    where id = v_run_id;

    update pub.news_sources
    set last_attempt_at = now(),
        last_fetch_ok_at = case when coalesce((v_run ->> 'fetchOk')::boolean, v_status = 'succeeded') then now() else last_fetch_ok_at end,
        last_official_post_at = greatest(last_official_post_at, v_newest_official),
        last_http_status = nullif(v_run ->> 'httpStatus', '')::smallint,
        last_error_category = nullif(left(v_run ->> 'errorCategory', 60), ''),
        last_success_at = case when v_status in ('succeeded', 'partial') then now() else last_success_at end,
        last_error_at = case when v_status in ('failed', 'partial') then now() else last_error_at end,
        last_error = nullif(v_run ->> 'error', ''),
        updated_at = now()
    where source_key = v_source_key;

    return jsonb_build_object('runId', v_run_id, 'inserted', v_inserted, 'updated', v_updated,
                              'skipped', v_skipped, 'skippedUnverified', v_skipped_unverified);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Read-only batch for the collector: due topics + region-scoped verified
--    identities + already-known thread origins. No table access for the caller.
-- ---------------------------------------------------------------------------
create or replace function pub_admin.news_revision_batch(p_source_key text, p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_type text;
begin
    if p_source_key is null or p_limit is null or p_limit < 1 or p_limit > 50 then
        raise exception using errcode = '22023', message = 'invalid_news_revision_request';
    end if;
    select source_type into v_type from pub.news_sources where source_key = p_source_key;
    if v_type is distinct from 'bluepost' then
        raise exception using errcode = '22023', message = 'invalid_news_revision_request';
    end if;
    return jsonb_build_object(
        'verifiedStaff', coalesce((
            select jsonb_agg(jsonb_build_object('userId', s.user_id, 'group', s.group_name))
            from pub.news_verified_staff s
            join pub.news_official_groups g on g.group_name = s.group_name
            where s.source_key = p_source_key), '[]'::jsonb),
        'dueTopics', coalesce((
            select jsonb_agg(jsonb_build_object('topicId', d.topic_id, 'threadOrigin', d.thread_origin,
                                                'consecutiveFailures', d.consecutive_failures,
                                                'lastOfficialAt', d.last_official_at, 'firstSeenAt', d.first_seen_at,
                                                'officialPostIds', to_jsonb(d.official_post_ids)) order by d.next_check_at)
            from (select t.* from pub.news_tracked_topics t
                  where t.source_key = p_source_key and t.next_check_at <= now()
                  order by t.next_check_at asc, t.topic_id limit p_limit) d), '[]'::jsonb),
        'knownOrigins', coalesce((
            select jsonb_agg(jsonb_build_object('topicId', k.topic_id, 'threadOrigin', k.thread_origin))
            from (select t.topic_id, t.thread_origin from pub.news_tracked_topics t
                  where t.source_key = p_source_key and t.thread_origin is not null
                  order by t.last_official_at desc nulls last limit 500) k), '[]'::jsonb)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Public read functions: ONE card per region/topic, ordered by the latest
--    verified official activity. Old signatures keep their exact columns.
-- ---------------------------------------------------------------------------
create or replace function web_api.news_cards(
    p_category text, p_query text, p_region text, p_featured boolean, p_limit integer, p_offset integer
)
returns table (
    id bigint, slug text, source_type text, source_key text, source_entry_id text, source_topic_id text,
    source_post_number integer, thread_key text, canonical_url text, title text, author text, region text,
    published_at timestamptz, modified_at timestamptz, ingested_at timestamptz, excerpt text, category text,
    importance smallint, featured boolean, thread_published_at timestamptz, official_updated_at timestamptz,
    update_count integer, thread_origin text, entry_kind text, total_count bigint
)
language plpgsql stable security definer set search_path = ''
as $$
declare v_query text := lower(btrim(coalesce(p_query, '')));
begin
    if p_limit is null or p_limit < 1 or p_limit > 50 or p_offset is null or p_offset < 0 or p_offset > 5000
       or length(v_query) > 80 or v_query ~ '[%_\\]'
       or (p_category is not null and p_category not in ('bluepost', 'official_news', 'patch_notes', 'azerdex'))
       or (p_region is not null and p_region not in ('us', 'eu', 'global')) then
        raise exception using errcode = '22023', message = 'invalid_news_query';
    end if;
    return query
    with ranked as (
        select c.*,
               row_number() over (partition by c.card_key order by c.official_at desc, c.id desc) as rn,
               min(c.published_at) filter (where c.source_post_number = 1) over (partition by c.card_key) as opener_pub,
               min(c.published_at) over (partition by c.card_key) as first_pub,
               count(*) over (partition by c.card_key) as upd,
               bool_or(c.featured) over (partition by c.card_key) as any_featured,
               max(c.importance) over (partition by c.card_key) as max_importance,
               -- a query matches the thread when ANY verified update in it matches (not only the newest post)
               bool_or(v_query = '' or lower(c.title || ' ' || c.excerpt) like '%' || v_query || '%') over (partition by c.card_key) as q_match
        from pub.news_card_entries c
    ), cards as (
        select r.* from ranked r
        where r.rn = 1
          and (p_category is null or r.category = p_category)
          and (p_region is null or r.region = p_region)
          and r.q_match
    )
    select cd.id, cd.slug, cd.source_type, cd.source_key, cd.source_entry_id, cd.source_topic_id,
           cd.source_post_number, cd.thread_key, cd.canonical_url, cd.title, cd.author, cd.region,
           cd.published_at, cd.modified_at, cd.ingested_at, cd.excerpt, cd.category,
           cd.max_importance::smallint, cd.any_featured,
           coalesce(cd.opener_pub, cd.first_pub), cd.official_at, cd.upd::integer, cd.thread_origin,
           cd.entry_kind, count(*) over ()
    from cards cd
    order by case when p_featured then cd.any_featured end desc nulls last,
             case when p_featured then cd.max_importance end desc nulls last,
             cd.official_at desc, cd.id desc
    limit p_limit offset p_offset;
end;
$$;

create or replace function web_api.news_list(p_category text, p_query text, p_limit integer, p_offset integer)
returns table (
    id bigint, slug text, source_type text, source_key text, source_entry_id text, source_topic_id text,
    thread_key text, canonical_url text, title text, author text, region text, published_at timestamptz,
    modified_at timestamptz, ingested_at timestamptz, excerpt text, category text, importance smallint,
    featured boolean, total_count bigint
)
language sql stable security definer set search_path = ''
as $$
    select c.id, c.slug, c.source_type, c.source_key, c.source_entry_id, c.source_topic_id, c.thread_key,
           c.canonical_url, c.title, c.author, c.region, c.published_at, c.modified_at, c.ingested_at,
           c.excerpt, c.category, c.importance, c.featured, c.total_count
    from web_api.news_cards(p_category, p_query, null, false, p_limit, p_offset) c;
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
    select c.id, c.slug, c.source_type, c.source_key, c.source_entry_id, c.source_topic_id, c.thread_key,
           c.canonical_url, c.title, c.author, c.region, c.published_at, c.modified_at, c.ingested_at,
           c.excerpt, c.category, c.importance, c.featured
    from web_api.news_cards(null, '', null, true, least(greatest(coalesce(p_limit, 4), 1), 12), 0) c;
$$;

create or replace function web_api.news_entry(p_slug text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
    with target as (
        select e.* from pub.news_card_entries e where e.slug = p_slug
    ), thread as (
        select c.* from pub.news_card_entries c join target t on c.card_key = t.card_key
    )
    select jsonb_build_object(
        'id', t.id, 'slug', t.slug, 'sourceType', t.source_type, 'sourceKey', t.source_key,
        'sourceEntryId', t.source_entry_id, 'sourceTopicId', t.source_topic_id,
        'sourcePostNumber', t.source_post_number, 'threadKey', t.thread_key,
        'canonicalUrl', t.canonical_url, 'title', t.title, 'author', t.author, 'region', t.region,
        'publishedAt', t.published_at, 'modifiedAt', t.modified_at, 'ingestedAt', t.ingested_at,
        'excerpt', t.excerpt, 'category', t.category, 'importance', t.importance, 'featured', t.featured,
        'officialUpdatedAt', t.official_at, 'threadOrigin', t.thread_origin, 'entryKind', t.entry_kind,
        'threadPublishedAt', (select coalesce(min(x.published_at) filter (where x.source_post_number = 1), min(x.published_at)) from thread x),
        'threadOfficialUpdatedAt', (select max(x.official_at) from thread x),
        'updateCount', (select count(*) from thread x),
        'updates', coalesce((
            select jsonb_agg(jsonb_build_object(
                'slug', u.slug, 'postNumber', u.source_post_number, 'canonicalUrl', u.canonical_url,
                'publishedAt', u.published_at, 'officialUpdatedAt', u.official_at, 'author', u.author,
                'entryKind', u.entry_kind) order by u.official_at desc, u.id desc)
            from (select * from thread order by official_at desc, id desc limit 10) u), '[]'::jsonb))
    from target t;
$$;

-- ---------------------------------------------------------------------------
-- 6. Read-only health snapshot for operators (counts and timestamps only).
-- ---------------------------------------------------------------------------
create or replace function pub_admin.news_health_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    select jsonb_build_object(
        'generatedAt', now(),
        'sources', coalesce((
            select jsonb_agg(jsonb_build_object(
                'sourceKey', s.source_key, 'sourceType', s.source_type, 'region', s.region, 'enabled', s.enabled,
                'lastAttemptAt', s.last_attempt_at, 'lastFetchOkAt', s.last_fetch_ok_at,
                'lastSuccessAt', s.last_success_at, 'lastErrorAt', s.last_error_at,
                'lastOfficialPostAt', s.last_official_post_at, 'lastHttpStatus', s.last_http_status,
                'lastErrorCategory', s.last_error_category,
                'recent', (select jsonb_build_object(
                        'runs', count(*), 'failedRuns', count(*) filter (where r.status = 'failed'),
                        'partialRuns', count(*) filter (where r.status = 'partial'),
                        'fetched', coalesce(sum(r.fetched_count), 0), 'accepted', coalesce(sum(r.accepted_count), 0),
                        'rejected', coalesce(sum(r.rejected_count), 0), 'inserted', coalesce(sum(r.inserted_count), 0),
                        'updated', coalesce(sum(r.updated_count), 0), 'skipped', coalesce(sum(r.skipped_count), 0))
                    from pub.news_sync_runs r
                    where r.source_key = s.source_key and r.started_at > now() - interval '24 hours'),
                'consecutiveFailures', (
                    select count(*) from pub.news_sync_runs r
                    where r.source_key = s.source_key and r.status = 'failed'
                      and r.id > coalesce((
                          select max(r2.id) from pub.news_sync_runs r2
                          where r2.source_key = s.source_key and r2.finished_at is not null and r2.status <> 'failed'), 0)),
                'trackedTopics', (select count(*) from pub.news_tracked_topics t where t.source_key = s.source_key),
                'overdueTopics', (select count(*) from pub.news_tracked_topics t
                                  where t.source_key = s.source_key and t.next_check_at < now() - interval '12 hours'),
                'oldestOverdueAt', (select min(t.next_check_at) from pub.news_tracked_topics t
                                    where t.source_key = s.source_key and t.next_check_at < now() - interval '12 hours'),
                'publishedEntries', (select count(*) from pub.news_entries n
                                     where n.source_key = s.source_key and n.status = 'published' and n.suppressed_at is null),
                'visibleEntries', (select count(*) from pub.news_card_entries c where c.source_key = s.source_key),
                'futureDatedEntries', (select count(*) from pub.news_entries n
                                       where n.source_key = s.source_key and n.status = 'published' and n.suppressed_at is null
                                         and greatest(n.published_at, coalesce(n.official_updated_at, n.published_at)) > now() + interval '15 minutes')
            ) order by s.source_key)
            from pub.news_sources s), '[]'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants. New functions are revoked from PUBLIC explicitly: PostgreSQL
--    grants EXECUTE to PUBLIC by default.
-- ---------------------------------------------------------------------------
revoke all on function pub_admin.news_revision_batch(text, integer) from public;
revoke all on function pub_admin.news_health_snapshot() from public;
revoke all on function web_api.news_cards(text, text, text, boolean, integer, integer) from public;
grant execute on function pub_admin.news_revision_batch(text, integer) to azerdex_news_ingest;
grant execute on function web_api.news_cards(text, text, text, boolean, integer, integer) to foreverdb_web_reader;

do $grants$
begin
    if exists (select 1 from pg_roles where rolname = 'postgres') then
        execute 'grant usage on schema pub_admin to postgres';
        execute 'grant execute on function pub_admin.news_health_snapshot() to postgres';
    end if;
end
$grants$;

do $verify$
begin
    if has_table_privilege('foreverdb_web_reader', 'pub.news_entries', 'select')
       or has_table_privilege('foreverdb_web_reader', 'pub.news_card_entries', 'select')
       or has_table_privilege('foreverdb_web_reader', 'pub.news_tracked_topics', 'select')
       or has_table_privilege('foreverdb_web_reader', 'pub.news_verified_staff', 'select')
       or has_table_privilege('foreverdb_publisher', 'pub.news_entries', 'update')
       or has_table_privilege('azerdex_news_ingest', 'pub.news_card_entries', 'select')
       or has_table_privilege('azerdex_news_ingest', 'pub.news_tracked_topics', 'select') then
        raise exception 'News boundary FAILED after V2 migration';
    end if;
    if not has_function_privilege('azerdex_news_ingest', 'pub_admin.news_revision_batch(text,integer)', 'execute')
       or has_function_privilege('azerdex_news_ingest', 'pub_admin.news_health_snapshot()', 'execute')
       or has_function_privilege('foreverdb_web_reader', 'pub_admin.news_revision_batch(text,integer)', 'execute') then
        raise exception 'News V2 RPC grants are wrong';
    end if;
end
$verify$;

commit;
