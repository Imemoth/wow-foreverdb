-- ForeverDB initial backend schema.
-- Creature sources are split by NPC ID + exact creature level.
-- GameObjects and fishing zones use source_level = 0. Fishing uses uiMapID as source_id.

create schema if not exists private;

create table if not exists private.foreverdb_settings (
    key text primary key,
    value text not null,
    updated_at timestamptz not null default now()
);

revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;

create table if not exists public.sources (
    source_type text not null check (source_type in ('creature', 'gameobject', 'fishing')),
    source_id bigint not null,
    source_level integer not null default 0 check (source_level >= 0),
    name text,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    primary key (source_type, source_id, source_level)
);

create table if not exists public.items (
    item_id bigint primary key,
    name text,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create table if not exists public.installations (
    id text primary key,
    schema_version integer not null,
    addon_version text not null,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now()
);

create table if not exists public.installation_source_stats (
    installation_id text not null references public.installations(id) on delete cascade,
    source_type text not null,
    source_id bigint not null,
    source_level integer not null default 0 check (source_level >= 0),
    loot_kind text not null check (
        loot_kind in ('mob', 'skinning', 'mining', 'herbalism', 'fishing', 'chest', 'gameobject', 'unknown')
    ),
    observations bigint not null default 0 check (observations >= 0),
    updated_at timestamptz not null default now(),
    primary key (
        installation_id,
        source_type,
        source_id,
        source_level,
        loot_kind
    ),
    foreign key (source_type, source_id, source_level)
        references public.sources(source_type, source_id, source_level)
        on delete cascade
);

create table if not exists public.installation_item_stats (
    installation_id text not null references public.installations(id) on delete cascade,
    source_type text not null,
    source_id bigint not null,
    source_level integer not null default 0 check (source_level >= 0),
    loot_kind text not null check (
        loot_kind in ('mob', 'skinning', 'mining', 'herbalism', 'fishing', 'chest', 'gameobject', 'unknown')
    ),
    item_id bigint not null references public.items(item_id) on delete cascade,
    drop_count bigint not null default 0 check (drop_count >= 0),
    quantity bigint not null default 0 check (quantity >= 0),
    quest_drop_count bigint not null default 0 check (quest_drop_count >= 0),
    quest_ids bigint[] not null default '{}',
    updated_at timestamptz not null default now(),
    primary key (
        installation_id,
        source_type,
        source_id,
        source_level,
        loot_kind,
        item_id
    ),
    foreign key (source_type, source_id, source_level)
        references public.sources(source_type, source_id, source_level)
        on delete cascade
);


create table if not exists public.installation_location_stats (
    installation_id text not null references public.installations(id) on delete cascade,
    source_type text not null,
    source_id bigint not null,
    source_level integer not null default 0 check (source_level >= 0),
    loot_kind text not null check (
        loot_kind in ('mob', 'skinning', 'mining', 'herbalism', 'fishing', 'chest', 'gameobject', 'unknown')
    ),
    map_id bigint not null default 0,
    zone_name text,
    subzone_name text,
    x numeric(5,1) not null default -1,
    y numeric(5,1) not null default -1,
    observations bigint not null default 0 check (observations >= 0),
    updated_at timestamptz not null default now(),
    primary key (
        installation_id,
        source_type,
        source_id,
        source_level,
        loot_kind,
        map_id,
        subzone_name,
        x,
        y
    ),
    foreign key (source_type, source_id, source_level)
        references public.sources(source_type, source_id, source_level)
        on delete cascade
);

create index if not exists sources_name_lower_idx
    on public.sources (lower(name));

create index if not exists items_name_lower_idx
    on public.items (lower(name));

create index if not exists source_kind_idx
    on public.installation_source_stats (
        loot_kind,
        source_type,
        source_id,
        source_level
    );

create index if not exists item_stats_item_idx
    on public.installation_item_stats (item_id, loot_kind);

alter table public.installations enable row level security;
alter table public.installation_source_stats enable row level security;
alter table public.installation_item_stats enable row level security;
alter table public.installation_location_stats enable row level security;

revoke all on public.installations from anon, authenticated;
revoke all on public.installation_source_stats from anon, authenticated;
revoke all on public.installation_item_stats from anon, authenticated;
revoke all on public.installation_location_stats from anon, authenticated;

grant select on public.sources, public.items to anon, authenticated;

create or replace view public.observed_loot_stats as
select
    s.source_type,
    s.source_id,
    s.source_level,
    s.name as source_name,
    ss.loot_kind,
    i.item_id,
    i.name as item_name,
    sum(ss.observations)::bigint as observations,
    sum(ii.drop_count)::bigint as drop_count,
    sum(ii.quantity)::bigint as quantity,
    sum(ii.quest_drop_count)::bigint as quest_drop_count,
    case
        when sum(ss.observations) > 0
        then sum(ii.drop_count)::numeric / sum(ss.observations)::numeric
        else null
    end as observed_drop_rate
from public.installation_source_stats ss
join public.sources s
  on s.source_type = ss.source_type
 and s.source_id = ss.source_id
 and s.source_level = ss.source_level
join public.installation_item_stats ii
  on ii.installation_id = ss.installation_id
 and ii.source_type = ss.source_type
 and ii.source_id = ss.source_id
 and ii.source_level = ss.source_level
 and ii.loot_kind = ss.loot_kind
join public.items i
  on i.item_id = ii.item_id
group by
    s.source_type,
    s.source_id,
    s.source_level,
    s.name,
    ss.loot_kind,
    i.item_id,
    i.name;

grant select on public.observed_loot_stats to anon, authenticated;

create or replace function public.ingest_foreverdb_snapshot(
    p_token text,
    p_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
    expected_token text;
    installation text;
    schema_v integer;
    addon_v text;
    src jsonb;
    bucket jsonb;
    item jsonb;
    location jsonb;
    v_source_type text;
    v_source_id bigint;
    v_source_level integer;
    v_kind text;
    v_quest_ids bigint[];
begin
    select value into expected_token
    from private.foreverdb_settings
    where key = 'ingest_token';

    if expected_token is null then
        raise exception 'ForeverDB ingest token is not configured';
    end if;

    if p_token is null or p_token <> expected_token then
        raise exception 'Invalid ForeverDB ingest token';
    end if;

    installation := p_snapshot->>'installationId';
    schema_v := (p_snapshot->>'schemaVersion')::integer;
    addon_v := p_snapshot->>'addonVersion';

    if installation is null or installation = '' then
        raise exception 'Missing installationId';
    end if;

    insert into public.installations (
        id, schema_version, addon_version, first_seen_at, last_seen_at
    )
    values (installation, schema_v, addon_v, now(), now())
    on conflict (id) do update set
        schema_version = excluded.schema_version,
        addon_version = excluded.addon_version,
        last_seen_at = now();

    delete from public.installation_item_stats
    where installation_id = installation;

    delete from public.installation_source_stats
    where installation_id = installation;

    delete from public.installation_location_stats
    where installation_id = installation;

    for src in
        select value
        from jsonb_array_elements(coalesce(p_snapshot->'sources', '[]'::jsonb))
    loop
        v_source_type := src->>'sourceType';
        v_source_id := (src->>'sourceId')::bigint;
        v_source_level := coalesce((src->>'sourceLevel')::integer, 0);

        insert into public.sources (
            source_type,
            source_id,
            source_level,
            name,
            first_seen_at,
            last_seen_at
        )
        values (
            v_source_type,
            v_source_id,
            v_source_level,
            nullif(src->>'name', ''),
            now(),
            now()
        )
        on conflict (source_type, source_id, source_level) do update set
            name = coalesce(nullif(excluded.name, ''), public.sources.name),
            last_seen_at = now();

        for bucket in
            select value
            from jsonb_array_elements(coalesce(src->'buckets', '[]'::jsonb))
        loop
            v_kind := bucket->>'kind';

            insert into public.installation_source_stats (
                installation_id,
                source_type,
                source_id,
                source_level,
                loot_kind,
                observations,
                updated_at
            )
            values (
                installation,
                v_source_type,
                v_source_id,
                v_source_level,
                v_kind,
                coalesce((bucket->>'observations')::bigint, 0),
                now()
            );

            for location in
                select value
                from jsonb_array_elements(coalesce(bucket->'locations', '[]'::jsonb))
            loop
                insert into public.installation_location_stats (
                    installation_id,
                    source_type,
                    source_id,
                    source_level,
                    loot_kind,
                    map_id,
                    zone_name,
                    subzone_name,
                    x,
                    y,
                    observations,
                    updated_at
                )
                values (
                    installation,
                    v_source_type,
                    v_source_id,
                    v_source_level,
                    v_kind,
                    coalesce((location->>'mapId')::bigint, 0),
                    nullif(location->>'zoneName', ''),
                    coalesce(location->>'subZoneName', ''),
                    coalesce(nullif(location->>'x', '')::numeric, -1),
                    coalesce(nullif(location->>'y', '')::numeric, -1),
                    coalesce((location->>'observations')::bigint, 0),
                    now()
                );
            end loop;

            for item in
                select value
                from jsonb_array_elements(coalesce(bucket->'items', '[]'::jsonb))
            loop
                select coalesce(array_agg(value::bigint), '{}')
                into v_quest_ids
                from jsonb_array_elements_text(
                    coalesce(item->'questIds', '[]'::jsonb)
                );

                insert into public.items (
                    item_id, name, first_seen_at, last_seen_at
                )
                values (
                    (item->>'itemId')::bigint,
                    nullif(item->>'name', ''),
                    now(),
                    now()
                )
                on conflict (item_id) do update set
                    name = coalesce(nullif(excluded.name, ''), public.items.name),
                    last_seen_at = now();

                insert into public.installation_item_stats (
                    installation_id,
                    source_type,
                    source_id,
                    source_level,
                    loot_kind,
                    item_id,
                    drop_count,
                    quantity,
                    quest_drop_count,
                    quest_ids,
                    updated_at
                )
                values (
                    installation,
                    v_source_type,
                    v_source_id,
                    v_source_level,
                    v_kind,
                    (item->>'itemId')::bigint,
                    coalesce((item->>'drops')::bigint, 0),
                    coalesce((item->>'quantity')::bigint, 0),
                    coalesce((item->>'questDrops')::bigint, 0),
                    v_quest_ids,
                    now()
                );
            end loop;
        end loop;
    end loop;

    return jsonb_build_object(
        'ok', true,
        'installationId', installation,
        'sourceCount', jsonb_array_length(coalesce(p_snapshot->'sources', '[]'::jsonb))
    );
end;
$$;

revoke all on function public.ingest_foreverdb_snapshot(text, jsonb) from public;
grant execute on function public.ingest_foreverdb_snapshot(text, jsonb)
to anon, authenticated;
