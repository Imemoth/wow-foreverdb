-- ForeverDB PUBLIC READ MODEL (website database).
--
-- Target: a PHYSICALLY SEPARATE database/Supabase project from production.
-- NEVER apply this file to the private production project
-- (klxhikdlfwgxurdyexdi). It contains no private tables by design.
--
-- Roles
--   foreverdb_pub_owner   NOLOGIN. Owns all objects; SECURITY DEFINER owner.
--   foreverdb_web_reader  Website runtime identity. EXECUTE on web_api.* only.
--                         No table privileges, no write capability.
--   foreverdb_publisher   Publication worker identity. INSERT into staging
--                         publications (RLS-guarded) + pub_admin.* functions.
--                         No SELECT on data tables, no UPDATE/DELETE.
-- Logins are enabled out-of-band by an operator (passwords never in git):
--   alter role foreverdb_web_reader login password '<generated>';
--   alter role foreverdb_publisher login password '<generated>';
--
-- Publication model
--   Every row belongs to a publication_id. Exactly one publication is active
--   (pub.state). The publisher writes a new 'staging' publication and calls
--   pub_admin.finalize_publication in the SAME transaction; validation
--   failures raise and roll everything back (fail closed). Readers only ever
--   see the active publication. The last N publications are retained for
--   instant rollback via pub_admin.activate_publication.

begin;

create extension if not exists pg_trgm;

-- The owner role needs to resolve gin_trgm_ops wherever pg_trgm lives
-- (public on plain PostgreSQL, `extensions` on Supabase).
do $trgm$
declare v_schema text;
begin
    select n.nspname into v_schema from pg_extension e join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_trgm';
    perform set_config('foreverdb.trgm_schema', v_schema, true);
end
$trgm$;

do $roles$
begin
    if not exists (select 1 from pg_roles where rolname = 'foreverdb_pub_owner') then
        create role foreverdb_pub_owner nologin noinherit nobypassrls;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'foreverdb_web_reader') then
        create role foreverdb_web_reader nologin noinherit nobypassrls;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'foreverdb_publisher') then
        create role foreverdb_publisher nologin noinherit nobypassrls;
    end if;
end
$roles$;

do $trgm_usage$
begin
    execute format('grant usage on schema %I to foreverdb_pub_owner', current_setting('foreverdb.trgm_schema'));
end
$trgm_usage$;

alter role foreverdb_web_reader set statement_timeout = '3s';
alter role foreverdb_web_reader set idle_in_transaction_session_timeout = '5s';
alter role foreverdb_web_reader set default_transaction_read_only = on;
alter role foreverdb_web_reader connection limit 20;
alter role foreverdb_publisher set statement_timeout = '120s';
alter role foreverdb_publisher set idle_in_transaction_session_timeout = '60s';
alter role foreverdb_publisher connection limit 2;

-- PG16+: the migration runner must be able to SET ROLE to the owner role.
grant foreverdb_pub_owner to current_user with set true, inherit false;

create schema if not exists pub authorization foreverdb_pub_owner;
create schema if not exists web_api authorization foreverdb_pub_owner;
create schema if not exists pub_admin authorization foreverdb_pub_owner;

set local role foreverdb_pub_owner;

revoke all on schema pub, web_api, pub_admin from public;

-- Supabase API roles (if this is a Supabase project) get nothing at all.
do $supabase$
declare r text;
begin
    foreach r in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = r) then
            execute format('revoke all on schema pub, web_api, pub_admin from %I', r);
        end if;
    end loop;
end
$supabase$;


-- ---------------------------------------------------------------------------
-- Publication ledger
-- ---------------------------------------------------------------------------
create table pub.publications (
    id bigint generated always as identity primary key,
    status text not null default 'staging'
        check (status in ('staging', 'active', 'retired')),
    created_at timestamptz not null default now(),
    finalized_at timestamptz,
    activated_at timestamptz,
    contract_version integer not null check (contract_version = 1),
    worker_version text not null check (length(worker_version) between 1 and 40),
    source_exported_at timestamptz not null,
    source_data_updated_at timestamptz,
    content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$'),
    config jsonb not null,
    counts jsonb
);

create table pub.state (
    id smallint primary key default 1 check (id = 1),
    active_publication_id bigint references pub.publications(id),
    updated_at timestamptz not null default now()
);
insert into pub.state (id, active_publication_id) values (1, null);

-- Append-only audit trail of publication attempts handled in SQL.
create table pub.audit_log (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    publication_id bigint,
    event text not null check (event in ('begin', 'activated', 'duplicate', 'rollback', 'pruned')),
    detail jsonb not null default '{}'::jsonb
);

create function pub.is_staging(p_publication_id bigint)
returns boolean language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from pub.publications
        where id = p_publication_id and status = 'staging'
    );
$$;

-- ---------------------------------------------------------------------------
-- Published data (allowlisted columns only; see docs/web/data-classification.md)
-- ---------------------------------------------------------------------------
create table pub.items (
    publication_id bigint not null references pub.publications(id) on delete cascade,
    item_id bigint not null check (item_id > 0),
    name text not null check (length(name) between 1 and 120),
    name_norm text not null,
    source_count integer not null check (source_count >= 0),
    total_drops bigint not null check (total_drops >= 0),
    last_observed_at timestamptz,
    indexable boolean not null default false,
    primary key (publication_id, item_id)
);

create table pub.sources (
    publication_id bigint not null references pub.publications(id) on delete cascade,
    source_type text not null check (source_type in ('creature', 'gameobject', 'fishing', 'item')),
    source_id bigint not null,
    source_level integer not null check (source_level between 0 and 255),
    name text not null check (length(name) between 1 and 120),
    name_norm text not null,
    display_kind text not null
        check (display_kind in ('creature', 'object', 'fishing_pool', 'fishing', 'item')),
    total_observations bigint not null check (total_observations >= 0),
    last_observed_at timestamptz,
    indexable boolean not null default false,
    primary key (publication_id, source_type, source_id, source_level)
);

create table pub.buckets (
    publication_id bigint not null,
    source_type text not null,
    source_id bigint not null,
    source_level integer not null,
    loot_kind text not null check (loot_kind in (
        'mob', 'skinning', 'mining', 'herbalism', 'fishing', 'fishing_pool',
        'chest', 'gameobject', 'disenchant')),
    observations bigint not null check (observations > 0),
    confidence text not null check (confidence in ('insufficient', 'low', 'medium', 'high')),
    primary key (publication_id, source_type, source_id, source_level, loot_kind),
    foreign key (publication_id, source_type, source_id, source_level)
        references pub.sources (publication_id, source_type, source_id, source_level)
        on delete cascade
);

create table pub.drops (
    publication_id bigint not null,
    source_type text not null,
    source_id bigint not null,
    source_level integer not null,
    loot_kind text not null,
    item_id bigint not null,
    drops bigint not null check (drops > 0),
    quantity bigint not null check (quantity >= drops),
    observations bigint not null check (observations >= drops),
    rate numeric(7, 6) check (rate between 0 and 1),
    rate_lower numeric(7, 6) check (rate_lower between 0 and 1),
    rate_upper numeric(7, 6) check (rate_upper between 0 and 1),
    confidence text not null check (confidence in ('insufficient', 'low', 'medium', 'high')),
    dominated boolean not null default false,
    primary key (publication_id, source_type, source_id, source_level, loot_kind, item_id),
    foreign key (publication_id, source_type, source_id, source_level, loot_kind)
        references pub.buckets (publication_id, source_type, source_id, source_level, loot_kind)
        on delete cascade,
    foreign key (publication_id, item_id)
        references pub.items (publication_id, item_id) on delete cascade,
    check ((confidence = 'insufficient') = (rate is null))
);

create table pub.zones (
    publication_id bigint not null references pub.publications(id) on delete cascade,
    map_id bigint not null check (map_id > 0),
    zone_name text not null check (length(zone_name) between 1 and 120),
    observations bigint not null check (observations > 0),
    source_count integer not null check (source_count >= 0),
    item_count integer not null check (item_count >= 0),
    primary key (publication_id, map_id)
);

-- Zone membership. SEMANTICS (see docs/web/data-classification.md):
--   * source rows: association = 'observed'; observations = how often THAT SOURCE
--     was observed in the zone (measured, location-backed).
--   * item rows:   association = 'inferred' (linked through a source observed in
--     the zone). observations is ALWAYS NULL = "not measured": the data cannot
--     show in which zone an individual drop happened, so a global drop count must
--     never be stored here, allocated, divided or otherwise stood in.
--     associated_source_count = distinct sources in the zone that drop the item
--     (a structural count, not a drop count).
-- Enforced by table constraints so a defective worker cannot publish a zone-specific
-- item count even by mistake.
create table pub.zone_entities (
    publication_id bigint not null,
    map_id bigint not null,
    entity_kind text not null check (entity_kind in ('item', 'source')),
    item_id bigint,
    source_type text,
    source_id bigint,
    source_level integer,
    display_kind text not null,
    name text not null,
    name_norm text not null,
    loot_kinds text[] not null,
    observations bigint check (observations is null or observations > 0),
    association text not null check (association in ('observed', 'inferred')),
    associated_source_count integer check (associated_source_count is null or associated_source_count > 0),
    foreign key (publication_id, map_id)
        references pub.zones (publication_id, map_id) on delete cascade,
    check (
        (entity_kind = 'item' and item_id is not null and source_type is null
            and association = 'inferred' and observations is null and associated_source_count is not null)
        or (entity_kind = 'source' and item_id is null and source_type is not null
            and source_id is not null and source_level is not null
            and association = 'observed' and observations is not null and associated_source_count is null)
    )
);
create unique index zone_entities_uq on pub.zone_entities (
    publication_id, map_id, entity_kind,
    coalesce(item_id, 0), coalesce(source_type, ''), coalesce(source_id, 0), coalesce(source_level, 0));

create table pub.locations (
    publication_id bigint not null,
    source_type text not null,
    source_id bigint not null,
    source_level integer not null,
    loot_kind text not null,
    map_id bigint not null,
    subzone_name text not null default '' check (length(subzone_name) <= 120),
    x numeric(4, 1) not null check (x between 0 and 100),
    y numeric(4, 1) not null check (y between 0 and 100),
    observations bigint not null check (observations > 0),
    primary key (publication_id, source_type, source_id, source_level, loot_kind, map_id, subzone_name, x, y),
    foreign key (publication_id, source_type, source_id, source_level, loot_kind)
        references pub.buckets (publication_id, source_type, source_id, source_level, loot_kind)
        on delete cascade,
    foreign key (publication_id, map_id)
        references pub.zones (publication_id, map_id) on delete cascade
);

create table pub.search_index (
    publication_id bigint not null references pub.publications(id) on delete cascade,
    entity_kind text not null check (entity_kind in ('item', 'source')),
    display_kind text not null
        check (display_kind in ('item', 'creature', 'object', 'fishing_pool', 'fishing')),
    item_id bigint,
    source_type text,
    source_id bigint,
    source_level integer,
    name text not null,
    name_norm text not null,
    loot_kinds text[] not null,
    map_ids bigint[] not null,
    observations bigint not null
);

-- Indexes for bounded, parameterized web_api queries.
do $trgm_idx$
begin
    execute format('create index search_index_trgm on pub.search_index using gin (name_norm %I.gin_trgm_ops)',
                   current_setting('foreverdb.trgm_schema'));
    execute format('create index zone_entities_trgm on pub.zone_entities using gin (name_norm %I.gin_trgm_ops)',
                   current_setting('foreverdb.trgm_schema'));
end
$trgm_idx$;
create index search_index_pub on pub.search_index (publication_id, display_kind);
create index search_index_item on pub.search_index (publication_id, item_id) where item_id is not null;
create index search_index_source_id on pub.search_index (publication_id, source_id) where source_id is not null;
create index search_index_maps on pub.search_index using gin (map_ids);
create index search_index_kinds on pub.search_index using gin (loot_kinds);
create index drops_item_idx on pub.drops (publication_id, item_id);
create index sources_type_id_idx on pub.sources (publication_id, source_type, source_id);
create index zone_entities_list_idx on pub.zone_entities (publication_id, map_id, entity_kind, name_norm);
create index locations_source_idx on pub.locations (publication_id, source_type, source_id);

-- RLS: defence in depth. The publisher may only INSERT into staging
-- publications; nobody but the owner (definer functions) may read.
do $rls$
declare t text;
begin
    foreach t in array array['items', 'sources', 'buckets', 'drops', 'zones',
                             'zone_entities', 'locations', 'search_index'] loop
        execute format('alter table pub.%I enable row level security', t);
        execute format(
            'create policy publisher_insert_staging on pub.%I for insert to foreverdb_publisher
             with check (pub.is_staging(publication_id))', t);
        execute format('grant insert on pub.%I to foreverdb_publisher', t);
    end loop;
    foreach t in array array['publications', 'state', 'audit_log'] loop
        execute format('alter table pub.%I enable row level security', t);
    end loop;
end
$rls$;

grant usage on schema pub to foreverdb_publisher;
grant execute on function pub.is_staging(bigint) to foreverdb_publisher;

-- ---------------------------------------------------------------------------
-- Publisher API (pub_admin)
-- ---------------------------------------------------------------------------
create function pub_admin.begin_publication(
    p_worker_version text,
    p_source_exported_at timestamptz,
    p_source_data_updated_at timestamptz,
    p_config jsonb
)
returns bigint language plpgsql security definer set search_path = ''
as $$
declare v_id bigint;
begin
    if exists (select 1 from pub.publications where status = 'staging') then
        raise exception 'Another publication is already staging';
    end if;
    if p_config is null or jsonb_typeof(p_config) <> 'object' then
        raise exception 'Publication config must be a JSON object';
    end if;
    insert into pub.publications (contract_version, worker_version, source_exported_at,
                                  source_data_updated_at, config)
    values (1, p_worker_version, p_source_exported_at, p_source_data_updated_at, p_config)
    returning id into v_id;
    insert into pub.audit_log (publication_id, event) values (v_id, 'begin');
    return v_id;
end;
$$;

-- Validates a staging publication. Raises (=> caller transaction rolls back)
-- on ANY inconsistency. Returns 'activated' or 'duplicate'.
create function pub_admin.finalize_publication(
    p_publication_id bigint,
    p_content_sha256 text,
    p_expected_counts jsonb,
    p_allow_shrink boolean default false,
    p_keep integer default 3
)
returns text language plpgsql security definer set search_path = ''
as $$
declare
    v_counts jsonb;
    v_active bigint;
    v_active_sha text;
    v_active_items bigint;
    v_bad bigint;
begin
    if not pub.is_staging(p_publication_id) then
        raise exception 'Publication % is not staging', p_publication_id;
    end if;
    if p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$' then
        raise exception 'Invalid content hash';
    end if;
    if p_keep is null or p_keep < 2 or p_keep > 10 then
        raise exception 'Invalid retention';
    end if;

    select jsonb_build_object(
        'items', (select count(*) from pub.items where publication_id = p_publication_id),
        'sources', (select count(*) from pub.sources where publication_id = p_publication_id),
        'buckets', (select count(*) from pub.buckets where publication_id = p_publication_id),
        'drops', (select count(*) from pub.drops where publication_id = p_publication_id),
        'zones', (select count(*) from pub.zones where publication_id = p_publication_id),
        'zone_entities', (select count(*) from pub.zone_entities where publication_id = p_publication_id),
        'locations', (select count(*) from pub.locations where publication_id = p_publication_id),
        'search_index', (select count(*) from pub.search_index where publication_id = p_publication_id)
    ) into v_counts;

    if v_counts is distinct from p_expected_counts then
        raise exception 'Row counts mismatch: expected %, got %', p_expected_counts, v_counts;
    end if;
    if (v_counts->>'items')::bigint = 0 or (v_counts->>'sources')::bigint = 0 then
        raise exception 'Refusing to publish an empty projection';
    end if;

    -- Every item must be reachable from at least one drop; every source must have a bucket.
    select count(*) into v_bad from pub.items i
    where i.publication_id = p_publication_id
      and not exists (select 1 from pub.drops d where d.publication_id = i.publication_id and d.item_id = i.item_id);
    if v_bad > 0 then raise exception '% orphan items', v_bad; end if;

    select count(*) into v_bad from pub.sources s
    where s.publication_id = p_publication_id
      and not exists (select 1 from pub.buckets b where b.publication_id = s.publication_id
                      and b.source_type = s.source_type and b.source_id = s.source_id
                      and b.source_level = s.source_level);
    if v_bad > 0 then raise exception '% orphan sources', v_bad; end if;

    -- Drop denominators must equal their bucket observations.
    select count(*) into v_bad from pub.drops d
    join pub.buckets b using (publication_id, source_type, source_id, source_level, loot_kind)
    where d.publication_id = p_publication_id and d.observations <> b.observations;
    if v_bad > 0 then raise exception '% drop denominators disagree with buckets', v_bad; end if;

    select s.active_publication_id into v_active from pub.state s where s.id = 1;
    if v_active is not null then
        select content_sha256 into v_active_sha from pub.publications where id = v_active;
        if v_active_sha = p_content_sha256 then
            -- Idempotent no-op: identical content is already live.
            delete from pub.publications where id = p_publication_id;
            insert into pub.audit_log (publication_id, event, detail)
            values (p_publication_id, 'duplicate', jsonb_build_object('active', v_active));
            return 'duplicate';
        end if;
        select count(*) into v_active_items from pub.items where publication_id = v_active;
        if not p_allow_shrink and (v_counts->>'items')::bigint < v_active_items / 2 then
            raise exception 'Projection shrank from % to % items; refusing without explicit override',
                v_active_items, v_counts->>'items';
        end if;
    end if;

    update pub.publications
       set status = 'retired'
     where status = 'active';
    update pub.publications
       set status = 'active', finalized_at = now(), activated_at = now(),
           content_sha256 = p_content_sha256, counts = v_counts
     where id = p_publication_id;
    update pub.state set active_publication_id = p_publication_id, updated_at = now() where id = 1;
    insert into pub.audit_log (publication_id, event, detail)
    values (p_publication_id, 'activated', jsonb_build_object('previous', v_active, 'counts', v_counts));

    -- Retention: keep the newest p_keep publications (active + retired).
    with doomed as (
        select id from pub.publications
        where status = 'retired'
        order by id desc
        offset greatest(p_keep - 1, 0)
    )
    delete from pub.publications p using doomed where p.id = doomed.id;

    return 'activated';
end;
$$;

-- Instant rollback to a retained publication (operator action).
create function pub_admin.activate_publication(p_publication_id bigint)
returns void language plpgsql security definer set search_path = ''
as $$
declare v_prev bigint;
begin
    if not exists (select 1 from pub.publications
                   where id = p_publication_id and status in ('retired', 'active')
                     and content_sha256 is not null) then
        raise exception 'Publication % is not a retained, finalized publication', p_publication_id;
    end if;
    select active_publication_id into v_prev from pub.state where id = 1;
    update pub.publications set status = 'retired' where status = 'active';
    update pub.publications set status = 'active', activated_at = now() where id = p_publication_id;
    update pub.state set active_publication_id = p_publication_id, updated_at = now() where id = 1;
    insert into pub.audit_log (publication_id, event, detail)
    values (p_publication_id, 'rollback', jsonb_build_object('previous', v_prev));
end;
$$;

create function pub_admin.status()
returns jsonb language sql stable security definer set search_path = ''
as $$
    select jsonb_build_object(
        'active', (select active_publication_id from pub.state where id = 1),
        'publications', coalesce((select jsonb_agg(jsonb_build_object(
            'id', id, 'status', status, 'created_at', created_at,
            'activated_at', activated_at, 'sha', content_sha256, 'counts', counts)
            order by id desc) from pub.publications), '[]'::jsonb)
    );
$$;

revoke all on all functions in schema pub_admin from public;
grant usage on schema pub_admin to foreverdb_publisher;
grant execute on function pub_admin.begin_publication(text, timestamptz, timestamptz, jsonb) to foreverdb_publisher;
grant execute on function pub_admin.finalize_publication(bigint, text, jsonb, boolean, integer) to foreverdb_publisher;
grant execute on function pub_admin.status() to foreverdb_publisher;
-- activate_publication (rollback) is intentionally NOT granted to the worker;
-- it is an operator action using the owner/admin connection.

-- ---------------------------------------------------------------------------
-- Website read API (web_api). Bounded, parameterized, read-only.
-- ---------------------------------------------------------------------------
create function web_api.active_id()
returns bigint language sql stable security definer set search_path = ''
as $$ select active_publication_id from pub.state where id = 1; $$;

create function web_api.meta()
returns jsonb language sql stable security definer set search_path = ''
as $$
    select coalesce((
        select jsonb_build_object(
            'publicationId', p.id,
            'publishedAt', p.activated_at,
            'dataUpdatedAt', p.source_data_updated_at,
            'counts', p.counts,
            'thresholds', p.config -> 'thresholds')
        from pub.state s join pub.publications p on p.id = s.active_publication_id
        where s.id = 1), jsonb_build_object('publicationId', null));
$$;

create function web_api.search(
    p_q text,
    p_category text,
    p_zone bigint,
    p_kind text,
    p_sort text,
    p_limit integer,
    p_offset integer
)
returns table (
    entity_kind text, display_kind text, item_id bigint, source_type text,
    source_id bigint, source_level integer, name text, loot_kinds text[],
    map_ids bigint[], observations bigint, total_count bigint
)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
    v_pub bigint := web_api.active_id();
    v_q text := lower(btrim(coalesce(p_q, '')));
    v_id bigint;
begin
    if p_limit is null or p_limit < 1 or p_limit > 50
       or p_offset is null or p_offset < 0 or p_offset > 1000 then
        raise exception using errcode = '22023', message = 'invalid_pagination';
    end if;
    if length(v_q) > 80 or (length(v_q) = 1) or v_q ~ '[%_\\]' then
        raise exception using errcode = '22023', message = 'invalid_query';
    end if;
    if p_category is not null and p_category not in ('item', 'creature', 'object', 'fishing_pool', 'fishing') then
        raise exception using errcode = '22023', message = 'invalid_category';
    end if;
    if p_kind is not null and p_kind not in ('mob', 'skinning', 'mining', 'herbalism', 'fishing',
                                              'fishing_pool', 'chest', 'gameobject', 'disenchant') then
        raise exception using errcode = '22023', message = 'invalid_kind';
    end if;
    if p_sort is null or p_sort not in ('relevance', 'name', 'observations') then
        raise exception using errcode = '22023', message = 'invalid_sort';
    end if;
    -- No blank global enumeration: a blank query needs a narrowing filter.
    if v_q = '' and p_zone is null and p_kind is null then
        raise exception using errcode = '22023', message = 'query_or_filter_required';
    end if;
    if v_pub is null then
        return;
    end if;
    if v_q ~ '^-?[0-9]{1,12}$' then
        v_id := v_q::bigint;
    end if;

    return query
    with matched as (
        select si.*,
               case
                   when v_id is not null and (si.item_id = v_id or si.source_id = v_id) then 0
                   when v_q = '' then 3
                   when si.name_norm = v_q then 1
                   when si.name_norm like v_q || '%' then 2
                   else 3
               end as rank_bucket
        from pub.search_index si
        where si.publication_id = v_pub
          and (p_category is null or si.display_kind = p_category)
          and (p_zone is null or si.map_ids @> array[p_zone])
          and (p_kind is null or si.loot_kinds @> array[p_kind])
          and (
              v_q = ''
              or (v_id is not null and (si.item_id = v_id or si.source_id = v_id))
              or (v_id is null and si.name_norm like '%' || v_q || '%')
          )
    )
    select m.entity_kind, m.display_kind, m.item_id, m.source_type, m.source_id,
           m.source_level, m.name, m.loot_kinds, m.map_ids, m.observations,
           count(*) over ()
    from matched m
    order by
        case when p_sort = 'relevance' then m.rank_bucket end,
        case when p_sort = 'observations' then m.observations end desc nulls last,
        m.name_norm, m.display_kind, m.item_id nulls last, m.source_type nulls last,
        m.source_id nulls last, m.source_level nulls last
    limit p_limit offset p_offset;
end;
$$;

create function web_api.drop_json(d pub.drops, s pub.sources, i pub.items)
returns jsonb language sql immutable security definer set search_path = ''
as $$
    select jsonb_build_object(
        'source', jsonb_build_object('type', s.source_type, 'id', s.source_id, 'level', s.source_level,
                                     'name', s.name, 'displayKind', s.display_kind),
        'item', jsonb_build_object('id', i.item_id, 'name', i.name),
        'lootKind', d.loot_kind,
        'drops', d.drops, 'quantity', d.quantity, 'observations', d.observations,
        'rate', d.rate, 'rateLower', d.rate_lower, 'rateUpper', d.rate_upper,
        'confidence', d.confidence, 'dominated', d.dominated);
$$;

create function web_api.item(p_item_id bigint)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
    v_pub bigint := web_api.active_id();
    v jsonb;
begin
    if p_item_id is null or p_item_id < 1 or p_item_id > 999999999 then
        raise exception using errcode = '22023', message = 'invalid_id';
    end if;
    select jsonb_build_object(
        'item', jsonb_build_object('id', i.item_id, 'name', i.name, 'sourceCount', i.source_count,
                                   'totalDrops', i.total_drops, 'lastObservedAt', i.last_observed_at,
                                   'indexable', i.indexable),
        'drops', coalesce((
            select jsonb_agg(x.j order by x.ord, x.lower desc nulls last, x.obs desc)
            from (
                select web_api.drop_json(d, s, i) as j,
                       case d.confidence when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end as ord,
                       d.rate_lower as lower, d.observations as obs
                from pub.drops d
                join pub.sources s using (publication_id, source_type, source_id, source_level)
                where d.publication_id = v_pub and d.item_id = i.item_id
                limit 200
            ) x), '[]'::jsonb),
        'disenchantsInto', coalesce((
            select jsonb_agg(x.j order by x.drops desc)
            from (
                select web_api.drop_json(d, s, ii) as j, d.drops
                from pub.drops d
                join pub.sources s using (publication_id, source_type, source_id, source_level)
                join pub.items ii on ii.publication_id = d.publication_id and ii.item_id = d.item_id
                where d.publication_id = v_pub and d.source_type = 'item' and d.source_id = i.item_id
                limit 50) x), '[]'::jsonb),
        'zones', coalesce((
            select jsonb_agg(jsonb_build_object('mapId', z.map_id, 'zoneName', z.zone_name,
                                                'observations', null, 'association', ze.association,
                                                'sourceCount', ze.associated_source_count)
                             order by ze.associated_source_count desc, z.zone_name, z.map_id)
            from pub.zone_entities ze
            join pub.zones z on z.publication_id = ze.publication_id and z.map_id = ze.map_id
            where ze.publication_id = v_pub and ze.entity_kind = 'item' and ze.item_id = i.item_id), '[]'::jsonb)
    ) into v
    from pub.items i
    where i.publication_id = v_pub and i.item_id = p_item_id;
    return v;
end;
$$;

create function web_api.source(p_source_type text, p_source_id bigint)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
    v_pub bigint := web_api.active_id();
    v jsonb;
begin
    if p_source_type is null or p_source_type not in ('creature', 'gameobject', 'fishing', 'item')
       or p_source_id is null or p_source_id < -2147483648 or p_source_id > 999999999 then
        raise exception using errcode = '22023', message = 'invalid_id';
    end if;
    if not exists (select 1 from pub.sources where publication_id = v_pub
                   and source_type = p_source_type and source_id = p_source_id) then
        return null;
    end if;
    select jsonb_build_object(
        'type', p_source_type,
        'id', p_source_id,
        'variants', (
            select jsonb_agg(jsonb_build_object(
                'level', s.source_level, 'name', s.name, 'displayKind', s.display_kind,
                'totalObservations', s.total_observations, 'lastObservedAt', s.last_observed_at,
                'indexable', s.indexable,
                'buckets', coalesce((
                    select jsonb_agg(jsonb_build_object('lootKind', b.loot_kind, 'observations', b.observations,
                                                        'confidence', b.confidence) order by b.observations desc)
                    from pub.buckets b
                    where b.publication_id = s.publication_id and b.source_type = s.source_type
                      and b.source_id = s.source_id and b.source_level = s.source_level), '[]'::jsonb),
                'drops', coalesce((
                    select jsonb_agg(x.j order by x.ord, x.lower desc nulls last, x.drops desc)
                    from (
                        select web_api.drop_json(d, s, i) as j,
                               case d.confidence when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end as ord,
                               d.rate_lower as lower, d.drops
                        from pub.drops d
                        join pub.items i on i.publication_id = d.publication_id and i.item_id = d.item_id
                        where d.publication_id = s.publication_id and d.source_type = s.source_type
                          and d.source_id = s.source_id and d.source_level = s.source_level
                        limit 300) x), '[]'::jsonb)
            ) order by s.source_level)
            from pub.sources s
            where s.publication_id = v_pub and s.source_type = p_source_type and s.source_id = p_source_id
        ),
        'zones', coalesce((
            select jsonb_agg(jsonb_build_object('mapId', z.map_id, 'zoneName', z.zone_name,
                                                'observations', q.obs, 'association', 'observed') order by q.obs desc)
            from (select ze.map_id, sum(ze.observations) as obs from pub.zone_entities ze
                  where ze.publication_id = v_pub and ze.entity_kind = 'source'
                    and ze.source_type = p_source_type and ze.source_id = p_source_id
                  group by ze.map_id) q
            join pub.zones z on z.publication_id = v_pub and z.map_id = q.map_id), '[]'::jsonb),
        'locations', coalesce((
            select jsonb_agg(jsonb_build_object('level', l.source_level, 'lootKind', l.loot_kind,
                                                'mapId', l.map_id, 'subzone', l.subzone_name,
                                                'x', l.x, 'y', l.y, 'observations', l.observations))
            from (select * from pub.locations
                  where publication_id = v_pub and source_type = p_source_type and source_id = p_source_id
                  order by observations desc limit 2000) l), '[]'::jsonb)
    ) into v;
    return v;
end;
$$;

create function web_api.zones()
returns table (map_id bigint, zone_name text, observations bigint, source_count integer, item_count integer)
language sql stable security definer set search_path = ''
as $$
    select z.map_id, z.zone_name, z.observations, z.source_count, z.item_count
    from pub.zones z
    where z.publication_id = web_api.active_id()
    order by z.zone_name
    limit 500;
$$;

create function web_api.zone(p_map_id bigint)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
    v_pub bigint := web_api.active_id();
    v jsonb;
begin
    if p_map_id is null or p_map_id < 1 or p_map_id > 999999 then
        raise exception using errcode = '22023', message = 'invalid_id';
    end if;
    select jsonb_build_object(
        'mapId', z.map_id, 'zoneName', z.zone_name, 'observations', z.observations,
        'sourceCount', z.source_count, 'itemCount', z.item_count,
        'displayKinds', coalesce((
            select jsonb_object_agg(k.display_kind, k.c)
            from (select ze.display_kind, count(*) as c from pub.zone_entities ze
                  where ze.publication_id = v_pub and ze.map_id = z.map_id
                  group by ze.display_kind) k), '{}'::jsonb),
        'lootKinds', coalesce((
            select jsonb_object_agg(k.kind, k.c)
            from (select u.kind, count(*) as c from pub.zone_entities ze, unnest(ze.loot_kinds) as u(kind)
                  where ze.publication_id = v_pub and ze.map_id = z.map_id and ze.entity_kind = 'source'
                  group by u.kind) k), '{}'::jsonb))
    into v
    from pub.zones z
    where z.publication_id = v_pub and z.map_id = p_map_id;
    return v;
end;
$$;

create function web_api.zone_entities(
    p_map_id bigint, p_display_kind text, p_loot_kind text, p_q text, p_limit integer, p_offset integer)
returns table (
    entity_kind text, display_kind text, item_id bigint, source_type text, source_id bigint,
    source_level integer, name text, loot_kinds text[], observations bigint, association text,
    associated_source_count integer, total_count bigint)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
declare
    v_q text := lower(btrim(coalesce(p_q, '')));
begin
    if p_map_id is null or p_map_id < 1 or p_map_id > 999999
       or p_limit is null or p_limit < 1 or p_limit > 100
       or p_offset is null or p_offset < 0 or p_offset > 2000
       or length(v_q) > 80 or v_q ~ '[%_\\]'
       or (p_display_kind is not null and p_display_kind not in ('item', 'creature', 'object', 'fishing_pool', 'fishing'))
       or (p_loot_kind is not null and p_loot_kind not in ('mob', 'skinning', 'mining', 'herbalism', 'fishing',
                                                           'fishing_pool', 'chest', 'gameobject', 'disenchant')) then
        raise exception using errcode = '22023', message = 'invalid_parameters';
    end if;
    return query
    select ze.entity_kind, ze.display_kind, ze.item_id, ze.source_type, ze.source_id, ze.source_level,
           ze.name, ze.loot_kinds, ze.observations, ze.association, ze.associated_source_count, count(*) over ()
    from pub.zone_entities ze
    where ze.publication_id = web_api.active_id()
      and ze.map_id = p_map_id
      and (p_display_kind is null or ze.display_kind = p_display_kind)
      and (p_loot_kind is null or ze.loot_kinds @> array[p_loot_kind])
      and (v_q = '' or ze.name_norm like '%' || v_q || '%')
    -- Measured source observations first; items (not measured per zone) follow,
    -- ordered by how many in-zone sources drop them. Units are never mixed.
    order by (ze.entity_kind = 'source') desc, ze.observations desc nulls last,
             ze.associated_source_count desc nulls last, ze.name_norm, ze.entity_kind, ze.item_id nulls last,
             ze.source_type nulls last, ze.source_id nulls last, ze.source_level nulls last
    limit p_limit offset p_offset;
end;
$$;

-- Recently observed entries (genuine last_observed_at, not popularity).
create function web_api.recent(p_limit integer)
returns table (entity_kind text, display_kind text, item_id bigint, source_type text,
               source_id bigint, source_level integer, name text, last_observed_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
    if p_limit is null or p_limit < 1 or p_limit > 24 then
        raise exception using errcode = '22023', message = 'invalid_parameters';
    end if;
    return query
    select * from (
        select 'source'::text, s.display_kind, null::bigint, s.source_type, s.source_id, s.source_level,
               s.name, s.last_observed_at
        from pub.sources s
        where s.publication_id = web_api.active_id() and s.last_observed_at is not null and s.indexable
        union all
        select 'item'::text, 'item'::text, i.item_id, null::text, null::bigint, null::integer,
               i.name, i.last_observed_at
        from pub.items i
        where i.publication_id = web_api.active_id() and i.last_observed_at is not null and i.indexable
    ) r
    order by 8 desc nulls last, 7
    limit p_limit;
end;
$$;

-- Bounded sitemap pages; only entities that pass the thin-content policy.
create function web_api.sitemap(p_entity text, p_offset integer, p_limit integer)
returns table (item_id bigint, source_type text, source_id bigint, map_id bigint, updated_at timestamptz)
language plpgsql stable security definer set search_path = ''
as $$
#variable_conflict use_column
begin
    if p_entity is null or p_entity not in ('item', 'source', 'zone')
       or p_offset is null or p_offset < 0 or p_offset > 100000
       or p_limit is null or p_limit < 1 or p_limit > 5000 then
        raise exception using errcode = '22023', message = 'invalid_parameters';
    end if;
    if p_entity = 'item' then
        return query select i.item_id, null::text, null::bigint, null::bigint, i.last_observed_at
            from pub.items i where i.publication_id = web_api.active_id() and i.indexable
            order by i.item_id limit p_limit offset p_offset;
    elsif p_entity = 'source' then
        return query select distinct on (s.source_type, s.source_id)
                null::bigint, s.source_type, s.source_id, null::bigint, s.last_observed_at
            from pub.sources s where s.publication_id = web_api.active_id() and s.indexable
            order by s.source_type, s.source_id, s.last_observed_at desc nulls last
            limit p_limit offset p_offset;
    else
        return query select null::bigint, null::text, null::bigint, z.map_id, null::timestamptz
            from pub.zones z where z.publication_id = web_api.active_id()
            order by z.map_id limit p_limit offset p_offset;
    end if;
end;
$$;

revoke all on all functions in schema web_api from public;
revoke all on all functions in schema pub from public;
grant usage on schema web_api to foreverdb_web_reader;
grant execute on function
    web_api.meta(),
    web_api.search(text, text, bigint, text, text, integer, integer),
    web_api.item(bigint),
    web_api.source(text, bigint),
    web_api.zones(),
    web_api.zone(bigint),
    web_api.zone_entities(bigint, text, text, text, integer, integer),
    web_api.recent(integer),
    web_api.sitemap(text, integer, integer)
to foreverdb_web_reader;

do $timeouts$
declare f regprocedure;
begin
    for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'web_api' loop
        execute format('alter function %s set statement_timeout = ''2s''', f);
    end loop;
end
$timeouts$;

-- Boundary assertions (run as the owner): abort the migration if any are violated.
do $verify$
declare t text;
begin
    foreach t in array array['items', 'sources', 'buckets', 'drops', 'zones', 'zone_entities',
                             'locations', 'search_index', 'publications', 'state', 'audit_log'] loop
        if has_table_privilege('foreverdb_web_reader', format('pub.%I', t), 'select')
           or has_table_privilege('foreverdb_web_reader', format('pub.%I', t), 'insert')
           or has_table_privilege('foreverdb_web_reader', format('pub.%I', t), 'update')
           or has_table_privilege('foreverdb_web_reader', format('pub.%I', t), 'delete')
           or has_table_privilege('foreverdb_publisher', format('pub.%I', t), 'select')
           or has_table_privilege('foreverdb_publisher', format('pub.%I', t), 'update')
           or has_table_privilege('foreverdb_publisher', format('pub.%I', t), 'delete') then
            raise exception 'Public read model boundary FAILED for pub.%', t;
        end if;
    end loop;
    if has_schema_privilege('foreverdb_web_reader', 'pub_admin', 'usage')
       or has_schema_privilege('foreverdb_web_reader', 'pub', 'usage')
       or has_function_privilege('foreverdb_web_reader',
            'pub_admin.finalize_publication(bigint, text, jsonb, boolean, integer)', 'execute')
       or has_function_privilege('foreverdb_publisher', 'pub_admin.activate_publication(bigint)', 'execute') then
        raise exception 'Public read model role separation FAILED';
    end if;
end
$verify$;

reset role;

commit;
