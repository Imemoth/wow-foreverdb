-- ForeverDB Companion: browse all *observed* items/sources in one zone.
-- Forward-only, bounded pages. Does not expose installation identifiers,
-- raw location coordinates or unpublished player data.
-- Only Supabase-authenticated sessions may browse the full paged catalog.
-- The publishable/anon key alone cannot invoke this endpoint. Note that
-- Supabase anonymous sign-ins still get the authenticated database role;
-- this is NOT an anti-scraping control or private dataset authorization.
--
-- Rollout: apply this migration to Supabase BEFORE publishing a Companion
-- binary using get_foreverdb_zone_catalog. Do not invoke the new RPC until
-- applied; existing named searches continue to use migration 0006 unchanged.

create index if not exists installation_location_zone_browse_idx
    on public.installation_location_stats (map_id, zone_name)
    where observations > 0;

create or replace function private.foreverdb_zone_catalog(
    p_map_id bigint,
    p_zone_name text,
    p_limit integer default 50,
    p_offset integer default 0
)
returns table (
    entity_kind text,
    item_id bigint,
    source_type text,
    source_id bigint,
    source_level integer,
    name text,
    total_count bigint
)
language sql
security definer
set search_path = ''
as $$
    with zone_locations as (
        select distinct
            l.installation_id,
            l.source_type,
            l.source_id,
            l.source_level,
            l.loot_kind
        from public.installation_location_stats l
        where l.map_id = p_map_id
          and l.zone_name = p_zone_name
          and l.observations > 0
          and p_map_id > 0
          and nullif(btrim(p_zone_name), '') is not null
    ),
    observed_entities as (
        select distinct
            'item'::text as entity_kind,
            i.item_id,
            null::text as source_type,
            null::bigint as source_id,
            null::integer as source_level,
            coalesce(
                nullif(btrim(i.name), ''),
                'Item #' || i.item_id::text
            ) as name
        from zone_locations z
        join public.installation_item_stats st
          on st.installation_id = z.installation_id
         and st.source_type = z.source_type
         and st.source_id = z.source_id
         and st.source_level = z.source_level
         and st.loot_kind = z.loot_kind
         and st.drop_count > 0
        join public.items i
          on i.item_id = st.item_id

        union all

        select distinct
            'source'::text as entity_kind,
            null::bigint as item_id,
            s.source_type,
            s.source_id,
            s.source_level,
            coalesce(
                nullif(btrim(s.name), ''),
                s.source_type || ' #' || s.source_id::text
            ) as name
        from zone_locations z
        join public.sources s
          on s.source_type = z.source_type
         and s.source_id = z.source_id
         and s.source_level = z.source_level
    ),
    unique_entities as (
        select distinct
            e.entity_kind,
            e.item_id,
            e.source_type,
            e.source_id,
            e.source_level,
            e.name
        from observed_entities e
    ),
    catalog as (
        select
            e.*,
            count(*) over ()::bigint as total_count
        from unique_entities e
    )
    select
        c.entity_kind,
        c.item_id,
        c.source_type,
        c.source_id,
        c.source_level,
        c.name,
        c.total_count
    from catalog c
    order by
        lower(c.name),
        c.entity_kind,
        c.item_id nulls last,
        c.source_type nulls last,
        c.source_id nulls last,
        c.source_level nulls last
    limit greatest(1, least(coalesce(p_limit, 50), 50))
    offset greatest(0, coalesce(p_offset, 0));
$$;

revoke all on function private.foreverdb_zone_catalog(
    bigint, text, integer, integer
) from public, anon;
grant execute on function private.foreverdb_zone_catalog(
    bigint, text, integer, integer
) to authenticated;

create or replace function public.get_foreverdb_zone_catalog(
    p_map_id bigint,
    p_zone_name text,
    p_limit integer default 50,
    p_offset integer default 0
)
returns table (
    entity_kind text,
    item_id bigint,
    source_type text,
    source_id bigint,
    source_level integer,
    name text,
    total_count bigint
)
language sql
security invoker
set search_path = ''
as $$
    select *
    from private.foreverdb_zone_catalog(
        p_map_id,
        p_zone_name,
        p_limit,
        p_offset
    );
$$;

revoke all on function public.get_foreverdb_zone_catalog(
    bigint, text, integer, integer
) from public, anon;
grant execute on function public.get_foreverdb_zone_catalog(
    bigint, text, integer, integer
) to authenticated;
