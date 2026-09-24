-- ForeverDB sync safety migration.
-- Apply after 0001_initial_schema.sql.

alter table public.installations
    add column if not exists snapshot_updated_at bigint not null default 0;

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
    snapshot_ts bigint;
    current_snapshot_ts bigint;
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
    snapshot_ts := coalesce((p_snapshot->>'updatedAt')::bigint, 0);

    if installation is null or installation = '' then
        raise exception 'Missing installationId';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(installation, 0));

    select snapshot_updated_at
    into current_snapshot_ts
    from public.installations
    where id = installation;

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
        schema_version,
        addon_version,
        snapshot_updated_at,
        first_seen_at,
        last_seen_at
    )
    values (
        installation,
        schema_v,
        addon_v,
        snapshot_ts,
        now(),
        now()
    )
    on conflict (id) do update set
        schema_version = excluded.schema_version,
        addon_version = excluded.addon_version,
        snapshot_updated_at = excluded.snapshot_updated_at,
        last_seen_at = now();

    delete from public.installation_item_stats
    where installation_id = installation;

    delete from public.installation_location_stats
    where installation_id = installation;

    delete from public.installation_source_stats
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
        on conflict (source_type, source_id, source_level)
        do update set
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
        'status', 'applied',
        'installationId', installation,
        'snapshotUpdatedAt', snapshot_ts,
        'sourceCount', jsonb_array_length(coalesce(p_snapshot->'sources', '[]'::jsonb))
    );
end;
$$;

revoke all on function public.ingest_foreverdb_snapshot(text, jsonb) from public;
grant execute on function public.ingest_foreverdb_snapshot(text, jsonb)
to anon, authenticated;
