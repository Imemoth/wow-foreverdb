-- Guildbook V1 private per-installation storage and schema-9 ingest support.
-- Guild roster data is not exposed through the public Data API in V1.
-- The authenticated owner may upload it through the existing security-definer RPC.

create table if not exists public.installation_guilds (
    installation_id text not null
        references public.installations(id) on delete cascade,
    guild_key text not null,
    guild_name text not null,
    realm_name text not null default '',
    captured_at bigint not null default 0,
    updated_at timestamptz not null default now(),
    primary key (installation_id, guild_key)
);

create table if not exists public.installation_guild_members (
    installation_id text not null,
    guild_key text not null,
    member_guid text not null,
    member_name text not null,
    class_name text not null default '',
    class_file text not null default '',
    level integer not null default 0 check (level >= 0),
    rank_name text not null default '',
    rank_index integer not null default -1,
    online boolean not null default false,
    zone_name text not null default '',
    last_online_hours bigint not null default 0 check (last_online_hours >= 0),
    updated_at timestamptz not null default now(),
    primary key (
        installation_id,
        guild_key,
        member_guid
    ),
    foreign key (installation_id, guild_key)
        references public.installation_guilds(
            installation_id,
            guild_key
        )
        on delete cascade
);

create table if not exists public.installation_guild_professions (
    installation_id text not null,
    guild_key text not null,
    member_guid text not null,
    skill_line_id integer not null,
    profession_name text not null default '',
    skill integer not null default 0 check (skill >= 0),
    max_skill integer not null default 0 check (max_skill >= 0),
    source text not null default '',
    is_secondary boolean not null default false,
    updated_at timestamptz not null default now(),
    primary key (
        installation_id,
        guild_key,
        member_guid,
        skill_line_id
    ),
    foreign key (
        installation_id,
        guild_key,
        member_guid
    )
        references public.installation_guild_members(
            installation_id,
            guild_key,
            member_guid
        )
        on delete cascade
);

create index if not exists installation_guild_members_name_idx
    on public.installation_guild_members(
        installation_id,
        lower(member_name)
    );

create index if not exists installation_guild_professions_skill_idx
    on public.installation_guild_professions(
        installation_id,
        skill_line_id
    );

alter table public.installation_guilds enable row level security;
alter table public.installation_guild_members enable row level security;
alter table public.installation_guild_professions enable row level security;

revoke all on public.installation_guilds
from public, anon, authenticated;

revoke all on public.installation_guild_members
from public, anon, authenticated;

revoke all on public.installation_guild_professions
from public, anon, authenticated;

create or replace function public.ingest_foreverdb_snapshot_auth(
    p_snapshot jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, auth, pg_temp
as $$
declare
    caller_user uuid;
    installation text;
    schema_v integer;
    addon_v text;
    snapshot_ts bigint;
    current_snapshot_ts bigint;
    current_owner uuid;
    src jsonb;
    bucket jsonb;
    item jsonb;
    location jsonb;
    guild jsonb;
    member jsonb;
    profession jsonb;
    v_source_type text;
    v_source_id bigint;
    v_source_level integer;
    v_kind text;
    v_quest_ids bigint[];
    v_guild_key text;
    v_member_guid text;
begin
    caller_user := auth.uid();

    if caller_user is null then
        raise exception 'Authentication required';
    end if;

    installation := p_snapshot->>'installationId';
    schema_v := (p_snapshot->>'schemaVersion')::integer;
    addon_v := p_snapshot->>'addonVersion';
    snapshot_ts := coalesce((p_snapshot->>'updatedAt')::bigint, 0);

    if installation is null or installation = '' then
        raise exception 'Missing installationId';
    end if;

    if schema_v < 7 then
        raise exception 'Unsupported ForeverDB schema version: %', schema_v;
    end if;

    perform pg_advisory_xact_lock(
        hashtextextended(installation, 0)
    );

    select owner_user_id, snapshot_updated_at
    into current_owner, current_snapshot_ts
    from public.installations
    where id = installation;

    if current_owner is not null
       and current_owner <> caller_user then
        raise exception
            'Installation belongs to another authenticated client';
    end if;

    if current_snapshot_ts is not null
       and snapshot_ts < current_snapshot_ts then
        return jsonb_build_object(
            'ok', true,
            'status', 'stale_ignored',
            'installationId', installation,
            'snapshotUpdatedAt', snapshot_ts,
            'currentSnapshotUpdatedAt', current_snapshot_ts
        );
    end if;

    insert into public.installations (
        id,
        owner_user_id,
        schema_version,
        addon_version,
        snapshot_updated_at,
        first_seen_at,
        last_seen_at
    )
    values (
        installation,
        caller_user,
        schema_v,
        addon_v,
        snapshot_ts,
        now(),
        now()
    )
    on conflict (id) do update set
        owner_user_id = coalesce(
            public.installations.owner_user_id,
            excluded.owner_user_id
        ),
        schema_version = excluded.schema_version,
        addon_version = excluded.addon_version,
        snapshot_updated_at = excluded.snapshot_updated_at,
        last_seen_at = now();

    delete from public.installation_guild_professions
    where installation_id = installation;

    delete from public.installation_guild_members
    where installation_id = installation;

    delete from public.installation_guilds
    where installation_id = installation;

    delete from public.installation_item_stats
    where installation_id = installation;

    delete from public.installation_location_stats
    where installation_id = installation;

    delete from public.installation_source_stats
    where installation_id = installation;

    for guild in
        select value
        from jsonb_array_elements(
            coalesce(p_snapshot->'guilds', '[]'::jsonb)
        )
    loop
        v_guild_key := guild->>'guildKey';

        if v_guild_key is null or v_guild_key = '' then
            continue;
        end if;

        insert into public.installation_guilds (
            installation_id,
            guild_key,
            guild_name,
            realm_name,
            captured_at,
            updated_at
        )
        values (
            installation,
            v_guild_key,
            coalesce(guild->>'name', ''),
            coalesce(guild->>'realmName', ''),
            coalesce(
                (guild->>'capturedAt')::bigint,
                0
            ),
            now()
        );

        for member in
            select value
            from jsonb_array_elements(
                coalesce(guild->'members', '[]'::jsonb)
            )
        loop
            v_member_guid := member->>'guid';

            if v_member_guid is null or v_member_guid = '' then
                continue;
            end if;

            insert into public.installation_guild_members (
                installation_id,
                guild_key,
                member_guid,
                member_name,
                class_name,
                class_file,
                level,
                rank_name,
                rank_index,
                online,
                zone_name,
                last_online_hours,
                updated_at
            )
            values (
                installation,
                v_guild_key,
                v_member_guid,
                coalesce(member->>'name', ''),
                coalesce(member->>'className', ''),
                coalesce(member->>'classFile', ''),
                coalesce(
                    (member->>'level')::integer,
                    0
                ),
                coalesce(member->>'rankName', ''),
                coalesce(
                    (member->>'rankIndex')::integer,
                    -1
                ),
                coalesce(
                    (member->>'online')::boolean,
                    false
                ),
                coalesce(member->>'zone', ''),
                coalesce(
                    (member->>'lastOnlineHours')::bigint,
                    0
                ),
                now()
            );

            for profession in
                select value
                from jsonb_array_elements(
                    coalesce(
                        member->'professions',
                        '[]'::jsonb
                    )
                )
            loop
                insert into public.installation_guild_professions (
                    installation_id,
                    guild_key,
                    member_guid,
                    skill_line_id,
                    profession_name,
                    skill,
                    max_skill,
                    source,
                    is_secondary,
                    updated_at
                )
                values (
                    installation,
                    v_guild_key,
                    v_member_guid,
                    (profession->>'skillLineId')::integer,
                    coalesce(
                        profession->>'name',
                        ''
                    ),
                    coalesce(
                        (profession->>'skill')::integer,
                        0
                    ),
                    coalesce(
                        (profession->>'maxSkill')::integer,
                        0
                    ),
                    coalesce(
                        profession->>'source',
                        ''
                    ),
                    coalesce(
                        (profession->>'isSecondary')::boolean,
                        false
                    ),
                    now()
                );
            end loop;
        end loop;
    end loop;

    for src in
        select value
        from jsonb_array_elements(
            coalesce(p_snapshot->'sources', '[]'::jsonb)
        )
    loop
        v_source_type := src->>'sourceType';
        v_source_id := (src->>'sourceId')::bigint;
        v_source_level := coalesce(
            (src->>'sourceLevel')::integer,
            0
        );

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
        on conflict (source_type, source_id, source_level)
        do update set
            name = coalesce(
                nullif(excluded.name, ''),
                public.sources.name
            ),
            last_seen_at = now();

        for bucket in
            select value
            from jsonb_array_elements(
                coalesce(src->'buckets', '[]'::jsonb)
            )
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
                coalesce(
                    (bucket->>'observations')::bigint,
                    0
                ),
                now()
            );

            for location in
                select value
                from jsonb_array_elements(
                    coalesce(bucket->'locations', '[]'::jsonb)
                )
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
                    coalesce(
                        (location->>'mapId')::bigint,
                        0
                    ),
                    nullif(location->>'zoneName', ''),
                    coalesce(
                        location->>'subZoneName',
                        ''
                    ),
                    coalesce(
                        nullif(location->>'x', '')::numeric,
                        -1
                    ),
                    coalesce(
                        nullif(location->>'y', '')::numeric,
                        -1
                    ),
                    coalesce(
                        (location->>'observations')::bigint,
                        0
                    ),
                    now()
                );
            end loop;

            for item in
                select value
                from jsonb_array_elements(
                    coalesce(bucket->'items', '[]'::jsonb)
                )
            loop
                select coalesce(
                    array_agg(value::bigint),
                    '{}'
                )
                into v_quest_ids
                from jsonb_array_elements_text(
                    coalesce(item->'questIds', '[]'::jsonb)
                );

                insert into public.items (
                    item_id,
                    name,
                    first_seen_at,
                    last_seen_at
                )
                values (
                    (item->>'itemId')::bigint,
                    nullif(item->>'name', ''),
                    now(),
                    now()
                )
                on conflict (item_id) do update set
                    name = coalesce(
                        nullif(excluded.name, ''),
                        public.items.name
                    ),
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
                    coalesce(
                        (item->>'drops')::bigint,
                        0
                    ),
                    coalesce(
                        (item->>'quantity')::bigint,
                        0
                    ),
                    coalesce(
                        (item->>'questDrops')::bigint,
                        0
                    ),
                    v_quest_ids,
                    now()
                );
            end loop;
        end loop;
    end loop;

    return jsonb_build_object(
        'ok', true,
        'status', 'applied',
        'installationId', installation,
        'snapshotUpdatedAt', snapshot_ts,
        'sourceCount', jsonb_array_length(
            coalesce(p_snapshot->'sources', '[]'::jsonb)
        ),
        'guildCount', jsonb_array_length(
            coalesce(p_snapshot->'guilds', '[]'::jsonb)
        )
    );
end;
$$;

revoke all on function public.ingest_foreverdb_snapshot_auth(jsonb)
from public, anon;

grant execute on function public.ingest_foreverdb_snapshot_auth(jsonb)
to authenticated;
