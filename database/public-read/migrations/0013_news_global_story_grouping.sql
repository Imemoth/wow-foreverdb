-- ForeverDB PUBLIC READ MODEL 0013: News global story grouping (EU/US cross-region deduplication in the shared read model).
--
-- The same Blizzard announcement is posted as separate forum topics per region (and sometimes cross-posted into several forum
-- categories of one region). Each stays a distinct, untouched pub.news_entries thread. This migration adds ONLY a presentation layer:
--   * pub.news_story_members   - which threads belong to one global story (story_key is stable; its suffix is the canonical thread);
--   * pub.news_story_overrides - reviewed human decisions: 'allow' (merge although the automatic rule does not hold) and 'deny';
--   * pub_admin.news_link_stories(p_apply) - the ONLY writer: a conservative, explainable, deterministic matcher run on demand
--     (dry-run by default); it never runs in the read path and is independent of ingestion (news_apply_sync is NOT touched);
--   * web_api.news_stories / web_api.news_story_entry - read functions that group thread cards into story cards. The existing
--     web_api.news_cards / news_list / news_featured / news_entry keep their signatures and behaviour.
--
-- Nothing is copied, re-keyed, rewritten or deleted: no news_entries / news_post_versions / news_tracked_topics row changes, no
-- hash, provenance, suppression marker or timestamp is touched. With no rows in news_story_members every story is a single thread and
-- web_api.news_stories returns exactly the cards of web_api.news_cards (+ regions/member count). Additive and idempotent.
--
-- AUTOMATIC RULE (exact_content_v1). Two verified Blue Post thread openers belong together only if ALL hold:
--   1. identical normalized title (case, punctuation, curly quotes, HTML entities ignored; must be non-empty);
--   2. identical normalized author (non-empty);
--   3. opener publication times at most 15 minutes apart;
--   4. identical normalized excerpt of at least 40 characters (an empty/short excerpt is never evidence).
-- The set of threads joined by passing pairs must be a CLIQUE (every pair passes) and may touch at most one existing story; anything
-- else is reported as ambiguous and stays separate. Near-misses (equal title and time but different content/author) are reported
-- as `review`. A reviewed override can force a merge ('allow') or forbid one ('deny'). Official News articles (no thread) are never grouped.
begin;
set local role foreverdb_pub_owner;

create table if not exists pub.news_story_members (
    thread_key text primary key check (thread_key ~ '^(us|eu):topic:[0-9]{1,12}$'),
    story_key  text not null check (story_key ~ '^story:(us|eu):topic:[0-9]{1,12}$'),
    basis      text not null check (basis in ('exact_content', 'manual_allow')),
    evidence   jsonb not null default '{}'::jsonb,
    linked_at  timestamptz not null default now()
);
create index if not exists news_story_members_story_idx on pub.news_story_members (story_key);

create table if not exists pub.news_story_overrides (
    thread_a   text not null check (thread_a ~ '^(us|eu):topic:[0-9]{1,12}$'),
    thread_b   text not null check (thread_b ~ '^(us|eu):topic:[0-9]{1,12}$'),
    decision   text not null check (decision in ('allow', 'deny')),
    reason     text not null check (length(btrim(reason)) >= 10),
    decided_by text not null check (length(btrim(decided_by)) >= 3),
    decided_at timestamptz not null default now(),
    primary key (thread_a, thread_b),
    check (thread_a < thread_b)
);

alter table pub.news_story_members enable row level security;
alter table pub.news_story_overrides enable row level security;
revoke all on pub.news_story_members, pub.news_story_overrides from public, anon, authenticated, foreverdb_web_reader, foreverdb_publisher, azerdex_news_ingest;

-- Normalisation used by the matcher (pure, no table access).
create or replace function pub_admin.news_norm_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
    select btrim(regexp_replace(
        lower(translate(regexp_replace(coalesce(p_text, ''), '&[a-zA-Z#0-9]+;', ' ', 'g'), '’‘“”–—', '''''""--')),
        '[^a-z0-9]+', ' ', 'g'))
$$;

-- ---------------------------------------------------------------------------
-- The only writer. p_apply = false (default): dry-run, returns the exact plan and writes nothing.
-- ---------------------------------------------------------------------------
create or replace function pub_admin.news_link_stories(p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_plan jsonb;
    v_new jsonb;
begin
    with recursive
    nn as (
        select o.thread_key, o.region, o.topic, o.pub, o.title,
               pub_admin.news_norm_text(o.title) as nt, pub_admin.news_norm_text(o.excerpt) as ne, pub_admin.news_norm_text(o.author) as na
        from (
            select c.thread_key, c.region, (array_agg(c.source_topic_id order by c.id))[1] as topic, min(c.published_at) as pub,
                   (array_agg(c.title order by c.id))[1] as title, (array_agg(c.excerpt order by c.id))[1] as excerpt,
                   (array_agg(c.author order by c.id))[1] as author
            from pub.news_card_entries c
            where c.source_post_number = 1 and c.category = 'bluepost' and c.thread_key is not null and c.region in ('us', 'eu')
            group by c.thread_key, c.region
        ) o
    ),
    pr as (
        select a.thread_key as ta, b.thread_key as tb, a.title as title_a, b.title as title_b,
               (a.nt = b.nt and a.nt <> '') as same_title,
               (a.na = b.na and a.na <> '') as same_author,
               round((abs(extract(epoch from a.pub - b.pub)) / 60.0)::numeric, 1) as minutes,
               (a.ne = b.ne and length(a.ne) >= 40) as same_excerpt,
               o.decision
        from nn a
        join nn b on a.thread_key < b.thread_key
        left join pub.news_story_overrides o on o.thread_a = a.thread_key and o.thread_b = b.thread_key
        where (a.nt = b.nt and a.nt <> '') or o.decision = 'allow'
    ),
    pp as (
        select pr.*,
               (pr.same_title and pr.same_author and pr.minutes <= 15 and pr.same_excerpt) as auto_ok,
               (coalesce(pr.decision = 'allow', false) or (pr.same_title and pr.same_author and pr.minutes <= 15 and pr.same_excerpt and pr.decision is distinct from 'deny')) as pass
        from pr
    ),
    edges as (select ta as a, tb as b from pp where pass union select tb, ta from pp where pass),
    comp(node, label) as (
        select n.thread_key, n.thread_key from nn n where n.thread_key in (select a from edges)
        union
        select e.b, c.label from comp c join edges e on e.a = c.node
    ),
    lab as (select node, min(label) as label from comp group by node),
    cs as (select label, count(*) as k from lab group by label having count(*) >= 2),
    cp as (
        select l1.label, count(*) as passes
        from pp join lab l1 on l1.node = pp.ta join lab l2 on l2.node = pp.tb and l2.label = l1.label
        where pp.pass group by l1.label
    ),
    ex as (
        select l.label, array_agg(distinct m.story_key) filter (where m.story_key is not null) as keys
        from lab l left join pub.news_story_members m on m.thread_key = l.node group by l.label
    ),
    comps as (
        select cs.label, cs.k,
               (coalesce(cp.passes, 0) = cs.k * (cs.k - 1) / 2) as clique,
               coalesce(cardinality(ex.keys), 0) as n_keys, ex.keys,
               case when coalesce(cardinality(ex.keys), 0) = 1 then ex.keys[1]
                    else 'story:' || (select n.thread_key from nn n join lab l on l.node = n.thread_key where l.label = cs.label order by n.pub, n.thread_key limit 1)
               end as story_key
        from cs left join cp using (label) left join ex using (label)
    ),
    ok_comps as (select * from comps where clique and n_keys <= 1),
    bad_comps as (select * from comps where not clique or n_keys > 1),
    members as (
        select oc.story_key, l.node as thread_key, n.region, n.topic, n.title, n.pub,
               (m.thread_key is null) as is_new,
               exists (select 1 from pp where pp.pass and not pp.auto_ok and l.node in (pp.ta, pp.tb)) as manual,
               (select max(pp.minutes) from pp where pp.pass and l.node in (pp.ta, pp.tb)) as max_minutes
        from ok_comps oc
        join lab l on l.label = oc.label
        join nn n on n.thread_key = l.node
        left join pub.news_story_members m on m.thread_key = l.node
    ),
    near as (
        select pp.ta, pp.tb, pp.title_a, pp.minutes,
               array_remove(array[
                   case when pp.decision = 'deny' then 'denied_by_override' end,
                   case when not pp.same_author then 'author_differs' end,
                   case when not pp.same_excerpt then 'content_differs_or_excerpt_too_short' end
               ], null) as reasons
        from pp where pp.same_title and pp.minutes <= 15 and not pp.pass
    )
    select jsonb_build_object(
        'stories', coalesce((
            select jsonb_agg(jsonb_build_object(
                'storyKey', s.story_key, 'isNew', s.is_new, 'memberCount', s.cnt,
                'members', s.members) order by s.first_pub, s.story_key)
            from (
                select m.story_key, bool_and(m.is_new) as is_new, count(*) as cnt, min(m.pub) as first_pub,
                       jsonb_agg(jsonb_build_object('threadKey', m.thread_key, 'region', m.region, 'topicId', m.topic,
                                                    'title', m.title, 'new', m.is_new) order by m.pub, m.thread_key) as members
                from members m group by m.story_key) s), '[]'::jsonb),
        'review', coalesce((select jsonb_agg(jsonb_build_object('threadA', n.ta, 'threadB', n.tb, 'title', n.title_a,
                                                                'minutesApart', n.minutes, 'reasons', to_jsonb(n.reasons)) order by n.ta, n.tb) from near n), '[]'::jsonb),
        'ambiguous', coalesce((select jsonb_agg(jsonb_build_object('label', b.label, 'threads', b.k, 'clique', b.clique, 'existingStories', coalesce(to_jsonb(b.keys), '[]'::jsonb)) order by b.label) from bad_comps b), '[]'::jsonb),
        'eligibleThreads', (select count(*) from nn)
    ),
    coalesce((select jsonb_agg(jsonb_build_object(
                'thread_key', m.thread_key, 'story_key', m.story_key,
                'basis', case when m.manual then 'manual_allow' else 'exact_content' end,
                'evidence', jsonb_build_object('rule', 'exact_content_v1', 'maxMinutesApart', m.max_minutes))
             order by m.thread_key) from members m where m.is_new), '[]'::jsonb)
    into v_plan, v_new;

    if p_apply and jsonb_array_length(v_new) > 0 then
        insert into pub.news_story_members (thread_key, story_key, basis, evidence)
        select x.thread_key, x.story_key, x.basis, x.evidence
        from jsonb_to_recordset(v_new) as x(thread_key text, story_key text, basis text, evidence jsonb)
        on conflict (thread_key) do nothing;
    end if;

    return v_plan || jsonb_build_object(
        'applied', coalesce(p_apply, false),
        'newMembers', jsonb_array_length(v_new),
        'ruleVersion', 'exact_content_v1');
end;
$$;

-- ---------------------------------------------------------------------------
-- Read model: one card per global story (or per thread when unlinked), filtered BEFORE counting and paging.
-- ---------------------------------------------------------------------------
create or replace function web_api.news_stories(
    p_category text, p_query text, p_region text, p_featured boolean, p_limit integer, p_offset integer
)
returns table (
    id bigint, slug text, source_type text, source_key text, source_entry_id text, source_topic_id text,
    source_post_number integer, thread_key text, canonical_url text, title text, author text, region text,
    published_at timestamptz, modified_at timestamptz, ingested_at timestamptz, excerpt text, category text,
    importance smallint, featured boolean, thread_published_at timestamptz, official_updated_at timestamptz,
    update_count integer, thread_origin text, entry_kind text, total_count bigint,
    story_key text, regions text[], member_count integer, canonical_slug text
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
               bool_or(v_query = '' or lower(c.title || ' ' || c.excerpt) like '%' || v_query || '%') over (partition by c.card_key) as q_match
        from pub.news_card_entries c
    ), tc as (
        select r.*, m.story_key as linked_story, coalesce(m.story_key, r.card_key) as sk
        from ranked r left join pub.news_story_members m on m.thread_key = r.thread_key
        where r.rn = 1
    ), regs as (
        select t.sk, array_agg(distinct t.region order by t.region) as regions, count(*)::integer as members
        from tc t group by t.sk
    ), flt as (
        select t.* from tc t
        where (p_category is null or t.category = p_category)
          and (p_region is null or t.region = p_region)
          and t.q_match
    ), sr as (
        select f.*,
               row_number() over (partition by f.sk order by f.official_at desc, f.id desc) as srn,
               bool_or(f.any_featured) over (partition by f.sk) as st_featured,
               max(f.max_importance) over (partition by f.sk) as st_importance,
               min(coalesce(f.opener_pub, f.first_pub)) over (partition by f.sk) as st_first
        from flt f
    ), stories as (
        select s.*, g.regions as st_regions, g.members as st_members from sr s join regs g using (sk) where s.srn = 1
    )
    select s.id, s.slug, s.source_type, s.source_key, s.source_entry_id, s.source_topic_id,
           s.source_post_number, s.thread_key, s.canonical_url, s.title, s.author, s.region,
           s.published_at, s.modified_at, s.ingested_at, s.excerpt, s.category,
           s.st_importance::smallint, s.st_featured, s.st_first, s.official_at, s.upd::integer, s.thread_origin,
           s.entry_kind, count(*) over (), s.linked_story, s.st_regions, s.st_members,
           coalesce((select e.slug from pub.news_card_entries e where s.linked_story is not null and e.thread_key = substring(s.linked_story from 7) and e.source_post_number = 1 limit 1), s.slug)
    from stories s
    order by case when p_featured then s.st_featured end desc nulls last,
             case when p_featured then s.st_importance end desc nulls last,
             s.official_at desc, s.id desc
    limit p_limit offset p_offset;
end;
$$;

-- Detail: everything web_api.news_entry returns, plus the global story (all verified members, their sources and updates).
create or replace function web_api.news_story_entry(p_slug text)
returns jsonb
language sql stable security definer set search_path = ''
as $$
    with target as (select e.* from pub.news_card_entries e where e.slug = p_slug),
    link as (select m.story_key from target t join pub.news_story_members m on m.thread_key = t.thread_key),
    mt as (
        select distinct c.thread_key
        from pub.news_card_entries c
        join pub.news_story_members m on m.thread_key = c.thread_key
        where m.story_key = (select story_key from link)
    ),
    per as (
        select c.thread_key, c.region,
               (array_agg(c.source_topic_id order by c.id))[1] as topic,
               min(c.published_at) filter (where c.source_post_number = 1) as opener_pub,
               min(c.published_at) as first_pub,
               max(c.official_at) as last_official,
               count(*) as upd,
               (array_agg(c.title order by c.source_post_number asc nulls last, c.id))[1] as title,
               (array_agg(c.canonical_url order by c.source_post_number asc nulls last, c.id))[1] as source_url,
               (array_agg(c.slug order by c.source_post_number asc nulls last, c.id))[1] as opener_slug,
               (array_agg(c.author order by c.source_post_number asc nulls last, c.id))[1] as author
        from pub.news_card_entries c join mt on mt.thread_key = c.thread_key
        group by c.thread_key, c.region
    )
    select web_api.news_entry(p_slug) || jsonb_build_object('story',
        case when (select story_key from link) is null then null else jsonb_build_object(
            'storyKey', (select story_key from link),
            'canonicalSlug', coalesce(
                (select p.opener_slug from per p where 'story:' || p.thread_key = (select story_key from link)),
                (select p.opener_slug from per p order by coalesce(p.opener_pub, p.first_pub), p.thread_key limit 1)),
            'regions', (select to_jsonb(array_agg(distinct p.region order by p.region)) from per p),
            'members', (select jsonb_agg(jsonb_build_object(
                    'region', p.region, 'threadKey', p.thread_key, 'topicId', p.topic, 'title', p.title, 'sourceUrl', p.source_url,
                    'openerSlug', p.opener_slug, 'author', p.author,
                    'firstPublishedAt', coalesce(p.opener_pub, p.first_pub), 'lastOfficialAt', p.last_official, 'updateCount', p.upd,
                    'updates', (select coalesce(jsonb_agg(jsonb_build_object(
                                'slug', u.slug, 'postNumber', u.source_post_number, 'canonicalUrl', u.canonical_url,
                                'publishedAt', u.published_at, 'officialUpdatedAt', u.official_at, 'author', u.author,
                                'entryKind', u.entry_kind) order by u.official_at desc, u.id desc), '[]'::jsonb)
                                from (select * from pub.news_card_entries x where x.thread_key = p.thread_key order by x.official_at desc, x.id desc limit 10) u))
                    order by coalesce(p.opener_pub, p.first_pub), p.thread_key) from per p)) end)
$$;

-- ---------------------------------------------------------------------------
-- Grants. No role other than the owner (and the platform admin for operations) may write or read the story tables directly.
-- ---------------------------------------------------------------------------
revoke all on function pub_admin.news_norm_text(text) from public;
revoke all on function pub_admin.news_link_stories(boolean) from public;
revoke all on function web_api.news_stories(text, text, text, boolean, integer, integer) from public;
revoke all on function web_api.news_story_entry(text) from public;
grant execute on function web_api.news_stories(text, text, text, boolean, integer, integer) to foreverdb_web_reader;
grant execute on function web_api.news_story_entry(text) to foreverdb_web_reader;

do $grants$
begin
    if exists (select 1 from pg_roles where rolname = 'postgres') then
        execute 'grant usage on schema pub_admin to postgres';
        execute 'grant execute on function pub_admin.news_link_stories(boolean) to postgres';
    end if;
end
$grants$;

do $verify$
declare f text;
begin
    foreach f in array array['pub_admin.news_link_stories(boolean)', 'pub_admin.news_norm_text(text)', 'web_api.news_stories(text,text,text,boolean,integer,integer)', 'web_api.news_story_entry(text)'] loop
        if not (select (p.prosecdef or f = 'pub_admin.news_norm_text(text)') and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path='))
                  from pg_proc p where p.oid = f::regprocedure)
           or has_function_privilege('public', f::regprocedure, 'execute') or has_function_privilege('anon', f::regprocedure, 'execute')
           or has_function_privilege('authenticated', f::regprocedure, 'execute') then
            raise exception 'migration 0013 self-check failed: % has a wrong definition or ACL', f;
        end if;
    end loop;
    if has_function_privilege('foreverdb_web_reader', 'pub_admin.news_link_stories(boolean)', 'execute')
       or has_function_privilege('azerdex_news_ingest', 'pub_admin.news_link_stories(boolean)', 'execute')
       or has_function_privilege('foreverdb_publisher', 'pub_admin.news_link_stories(boolean)', 'execute')
       or not has_function_privilege('foreverdb_web_reader', 'web_api.news_stories(text,text,text,boolean,integer,integer)', 'execute')
       or not has_function_privilege('foreverdb_web_reader', 'web_api.news_story_entry(text)', 'execute')
       or has_function_privilege('azerdex_news_ingest', 'web_api.news_stories(text,text,text,boolean,integer,integer)', 'execute') then
        raise exception 'migration 0013 self-check failed: function grants are wrong';
    end if;
    if has_table_privilege('foreverdb_web_reader', 'pub.news_story_members', 'select') or has_table_privilege('foreverdb_web_reader', 'pub.news_story_overrides', 'select')
       or has_table_privilege('azerdex_news_ingest', 'pub.news_story_members', 'select') or has_table_privilege('azerdex_news_ingest', 'pub.news_story_members', 'insert')
       or has_table_privilege('foreverdb_publisher', 'pub.news_story_members', 'insert') or has_table_privilege('anon', 'pub.news_story_members', 'select')
       or has_table_privilege('authenticated', 'pub.news_story_overrides', 'select') then
        raise exception 'migration 0013 self-check failed: a role can reach the story tables directly';
    end if;
    if not (select relrowsecurity from pg_class where oid = 'pub.news_story_members'::regclass)
       or not (select relrowsecurity from pg_class where oid = 'pub.news_story_overrides'::regclass) then
        raise exception 'migration 0013 self-check failed: row level security is off';
    end if;
end
$verify$;

commit;
