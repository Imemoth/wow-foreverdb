-- ForeverDB: authenticated, budgeted read API and bounded authenticated ingest.
-- CRITICAL ROLLOUT: companion client MUST first switch EVERY Search, Stats and
-- Location call to the Supabase Auth bearer. This migration denies previous
-- public/anon-only read calls and direct public.items/public.sources SELECT.
-- On a single production database, apply ONLY with a built/validated matching
-- client and an announced maintenance/rollback window.
--
-- This is a database cost/permission guard, not an IP WAF or unlimited DDoS
-- guarantee. Supabase anonymous sign-in yields role authenticated. Rotate
-- leaked keys, enable auth signup limits/CAPTCHA and platform rate controls
-- separately before offering public APIs.
--
-- This migration deliberately does not publish raw installation/guild data.
-- All elevated calls are explicitly bounded wrappers with empty search_path.

-- Atomic cutover: never leave half-revoked grants on an error.
begin;

create schema if not exists private;

create table if not exists private.foreverdb_api_budgets (
    bucket text primary key,
    window_started timestamptz not null,
    calls integer not null check (calls >= 0)
);
revoke all on table private.foreverdb_api_budgets from public, anon, authenticated;
revoke all on schema private from public, anon, authenticated;

create or replace function private.foreverdb_take_budget(
    p_bucket text,
    p_seconds integer,
    p_max integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_window timestamptz;
    v_used integer;
begin
    if p_max < 1 or p_max > 1000 or p_seconds not in (60, 300)
       or length(p_bucket) > 140 then
        raise exception 'Invalid server budget configuration';
    end if;

    v_window := to_timestamp(
        floor(extract(epoch from clock_timestamp()) / p_seconds) * p_seconds
    );

    insert into private.foreverdb_api_budgets as existing (
        bucket, window_started, calls
    ) values (p_bucket, v_window, 1)
    on conflict (bucket) do update
    set window_started = excluded.window_started,
        calls = case
            when existing.window_started = excluded.window_started
              then existing.calls + 1
            else 1
        end
    where existing.window_started <> excluded.window_started
       or existing.calls < p_max
    returning calls into v_used;

    if not found then
        raise sqlstate 'PT429'
            using message = 'Too many ForeverDB API requests; retry later';
    end if;
end;
$$;

create or replace function private.foreverdb_api_gate(p_scope text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid := auth.uid();
    v_role text := auth.role();
begin
    if v_role = 'service_role' then
        return;
    end if;

    if v_uid is null or v_role is distinct from 'authenticated' then
        raise sqlstate 'PT401'
            using message = 'ForeverDB authenticated session required';
    end if;

    if p_scope not in ('search', 'catalog', 'detail', 'ingest') then
        raise exception 'Invalid API quota scope';
    end if;

    if p_scope = 'ingest' then
        perform private.foreverdb_take_budget(
            'ingest:uid:' || v_uid::text, 300, 5);
        perform private.foreverdb_take_budget('ingest:global', 300, 60);
        return;
    end if;

    -- Global ceiling prevents unlimited cost even after rotating anonymous
    -- user IDs; per-uid caps prevent one normal session monopolizing it.
    perform private.foreverdb_take_budget(
        'read:uid:' || v_uid::text, 60, 100);
    perform private.foreverdb_take_budget('read:global', 60, 300);

    if p_scope = 'catalog' then
        perform private.foreverdb_take_budget(
            'catalog:uid:' || v_uid::text, 60, 20);
        perform private.foreverdb_take_budget('catalog:global', 60, 100);
    elsif p_scope = 'search' then
        perform private.foreverdb_take_budget(
            'search:uid:' || v_uid::text, 60, 45);
    else
        perform private.foreverdb_take_budget(
            'detail:uid:' || v_uid::text, 60, 65);
    end if;
end;
$$;

-- Privileged maintenance call for manual or scheduled cleanup.
create or replace function private.foreverdb_prune_api_budgets()
returns integer language plpgsql security definer set search_path = ''
as $$
declare v_deleted integer;
begin
    delete from private.foreverdb_api_budgets
    where window_started < clock_timestamp() - interval '24 hours';
    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

create or replace function public.get_foreverdb_search_zones()
returns table (map_id bigint, zone_name text)
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.foreverdb_api_gate('search');
    return query
    select * from private.foreverdb_search_zones()
    limit 200;
end;
$$;
alter function public.get_foreverdb_search_zones() set statement_timeout = '5s';

create or replace function public.get_foreverdb_search_in_zone(p_query text, p_map_id bigint, p_zone_name text)
returns table (entity_kind text, item_id bigint, source_type text, source_id bigint, source_level integer, name text)
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.foreverdb_api_gate('search');
    if p_map_id <= 0 or p_map_id is null or
        length(btrim(coalesce(p_query, ''))) not between 2 and 80 or
        length(btrim(coalesce(p_zone_name, ''))) not between 1 and 120 or
        p_query ~ '[%_\\]' then
        raise sqlstate 'PT400' using message='Invalid search parameters';
    end if;
    return query
    select * from private.foreverdb_search_in_zone(p_query, p_map_id, p_zone_name)
    limit 40;
end;
$$;
alter function public.get_foreverdb_search_in_zone(text,bigint,text) set statement_timeout = '5s';

create or replace function public.get_foreverdb_item_locations(p_item_id bigint)
returns table (source_type text, source_id bigint, source_level integer, loot_kind text, map_id bigint, zone_name text, subzone_name text, x numeric, y numeric, observations bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.foreverdb_api_gate('detail');
    if p_item_id is null or p_item_id <= 0 then
        raise sqlstate 'PT400' using message='Invalid item identifier';
    end if;
    return query
    select * from private.foreverdb_item_locations(p_item_id)
    limit 2000;
end;
$$;
alter function public.get_foreverdb_item_locations(bigint) set statement_timeout = '5s';

create or replace function public.get_foreverdb_source_locations(p_source_type text, p_source_id bigint, p_source_level integer)
returns table (source_type text, source_id bigint, source_level integer, loot_kind text, map_id bigint, zone_name text, subzone_name text, x numeric, y numeric, observations bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.foreverdb_api_gate('detail');
    if p_source_type not in ('creature','gameobject','fishing','item')
       or p_source_id is null or p_source_id = 0
       or p_source_level is null or p_source_level < 0 then
        raise sqlstate 'PT400' using message='Invalid source identifier';
    end if;
    return query
    select * from private.foreverdb_source_locations(p_source_type, p_source_id, p_source_level)
    limit 2000;
end;
$$;
alter function public.get_foreverdb_source_locations(text,bigint,integer) set statement_timeout = '5s';

create or replace function public.get_foreverdb_item_stats(p_item_id bigint)
returns table (source_type text, source_id bigint, source_level integer, source_name text, loot_kind text, item_id bigint, item_name text, observations bigint, drop_count bigint, quantity bigint, quest_drop_count bigint, observed_drop_rate numeric)
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.foreverdb_api_gate('detail');
    if p_item_id is null or p_item_id <= 0 then
        raise sqlstate 'PT400' using message='Invalid item identifier';
    end if;
    return query
    select * from private.foreverdb_item_stats(p_item_id)
    limit 500;
end;
$$;
alter function public.get_foreverdb_item_stats(bigint) set statement_timeout = '5s';

create or replace function public.get_foreverdb_source_stats(p_source_type text, p_source_id bigint, p_source_level integer)
returns table (source_type text, source_id bigint, source_level integer, source_name text, loot_kind text, item_id bigint, item_name text, observations bigint, drop_count bigint, quantity bigint, quest_drop_count bigint, observed_drop_rate numeric)
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.foreverdb_api_gate('detail');
    if p_source_type not in ('creature','gameobject','fishing','item')
       or p_source_id is null or p_source_id = 0
       or p_source_level is null or p_source_level < 0 then
        raise sqlstate 'PT400' using message='Invalid source identifier';
    end if;
    return query
    select * from private.foreverdb_source_stats(p_source_type, p_source_id, p_source_level)
    limit 500;
end;
$$;
alter function public.get_foreverdb_source_stats(text,bigint,integer) set statement_timeout = '5s';

create or replace function public.get_foreverdb_zone_catalog(p_map_id bigint, p_zone_name text, p_limit integer default 50, p_offset integer default 0)
returns table (entity_kind text, item_id bigint, source_type text, source_id bigint, source_level integer, name text, total_count bigint)
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform private.foreverdb_api_gate('catalog');
    if p_map_id <= 0 or p_map_id is null or
        length(btrim(coalesce(p_zone_name,''))) not between 1 and 120 or
        p_offset is null or p_offset < 0 or p_offset > 2000 or
        p_limit is null or p_limit < 1 or p_limit > 50 then
        raise sqlstate 'PT400' using message='Invalid zone catalog pagination';
    end if;
    return query
    select * from private.foreverdb_zone_catalog(p_map_id, p_zone_name, p_limit, p_offset)
    limit 50;
end;
$$;
alter function public.get_foreverdb_zone_catalog(bigint,text,integer,integer) set statement_timeout = '5s';

-- Public global search replaces direct PostgREST SELECT on items/sources.
-- Clamp returned rows to 20 each; invalid wildcard patterns are not
-- interpreted as SQL ILIKE wildcards. All output columns are catalog-safe.
create or replace function public.get_foreverdb_search_global(p_query text)
returns table (
    entity_kind text,
    item_id bigint,
    source_type text,
    source_id bigint,
    source_level integer,
    name text
)
language plpgsql security definer set search_path = ''
as $$
declare
    v_query text := btrim(p_query);
    v_id bigint;
begin
    perform private.foreverdb_api_gate('search');

    if length(coalesce(v_query,'')) not between 2 and 80
       or v_query ~ '[%_\\]' then
        raise sqlstate 'PT400' using message='Invalid search parameters';
    end if;

    if v_query ~ '^[0-9]{1,18}$' then
        v_id := v_query::bigint;
    end if;

    return query
    with matched_items as (
        select i.item_id, i.name
        from public.items i
        where i.name ilike '%' || v_query || '%'
           or (v_id is not null and i.item_id = v_id)
        order by
            case when lower(coalesce(i.name,'')) = lower(v_query) then 0 else 1 end,
            i.name, i.item_id
        limit 20
    ),
    matched_sources as (
        select s.source_type, s.source_id, s.source_level, s.name
        from public.sources s
        where s.name ilike '%' || v_query || '%'
           or (v_id is not null and s.source_id = v_id)
        order by
            case when lower(coalesce(s.name,'')) = lower(v_query) then 0 else 1 end,
            s.name, s.source_type, s.source_id, s.source_level
        limit 20
    )
    select 'item'::text, i.item_id, null::text,
        null::bigint, null::integer, i.name
    from matched_items i
    union all
    select 'source'::text, null::bigint,
        s.source_type, s.source_id, s.source_level, s.name
    from matched_sources s;
end;
$$;
alter function public.get_foreverdb_search_global(text)
set statement_timeout = '5s';

-- Preserve the current production ingest function (including Guildbook
-- fields) by moving its exact definition behind an authenticated, bounded
-- public entrypoint. The older PRIVATE ingest is not used as the
-- implementation because it lacks subsequent Guildbook fields.
do $guard$
begin
    if to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)')
       is null then
        if to_regprocedure('public.ingest_foreverdb_snapshot_auth(jsonb)')
           is null then
            raise exception 'Cannot safely wrap missing live ingestion RPC';
        end if;
        execute 'alter function public.ingest_foreverdb_snapshot_auth(jsonb)
                 rename to foreverdb_ingest_snapshot_impl_v1';
        execute 'alter function public.foreverdb_ingest_snapshot_impl_v1(jsonb)
                 set schema private';
    end if;
end $guard$;

create or replace function public.ingest_foreverdb_snapshot_auth(
    p_snapshot jsonb
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
    v_installation text;
begin
    perform private.foreverdb_api_gate('ingest');

    -- Reject payloads before the privileged sync deletes/re-inserts all
    -- installation rows. API gateway body-size limits are also required.
    if jsonb_typeof(p_snapshot) is distinct from 'object'
        or octet_length(p_snapshot::text) > 8388608
        or (p_snapshot ? 'sources' and
            jsonb_typeof(p_snapshot->'sources') <> 'array')
        or (p_snapshot ? 'guilds' and
            jsonb_typeof(p_snapshot->'guilds') <> 'array')
        or jsonb_array_length(coalesce(p_snapshot->'sources','[]'::jsonb)) > 2500
        or jsonb_array_length(coalesce(p_snapshot->'guilds','[]'::jsonb)) > 100
    then
        raise sqlstate 'PT413'
            using message='ForeverDB sync payload exceeds allowed bounds';
    end if;

    v_installation := p_snapshot->>'installationId';
    if length(coalesce(v_installation,'')) not between 1 and 128
       or p_snapshot->>'schemaVersion' is null
       or p_snapshot->>'updatedAt' is null then
        raise sqlstate 'PT400'
            using message='Invalid ForeverDB sync snapshot identity';
    end if;

    return private.foreverdb_ingest_snapshot_impl_v1(p_snapshot);
end;
$$;
alter function public.ingest_foreverdb_snapshot_auth(jsonb)
set statement_timeout = '15s';

-- Direct catalog reads can evade RPC limits. Remove them only after
-- Companion uses get_foreverdb_search_global and authenticated RPC calls.
revoke select on table public.items, public.sources from public, anon, authenticated;

-- Stop treating the helper schema as part of the caller's API. Public
-- SECURITY DEFINER wrappers retain access as their privileged owner.
revoke all on all functions in schema private from public, anon, authenticated;
revoke usage on schema private from public, anon, authenticated;

-- Every public read RPC is authenticated-only, including historic ones.
-- Existing service_role authorization stays intact.
revoke all on function public.get_foreverdb_search_zones() from public, anon;
grant execute on function public.get_foreverdb_search_zones() to authenticated, service_role;
revoke all on function public.get_foreverdb_search_in_zone(text,bigint,text) from public, anon;
grant execute on function public.get_foreverdb_search_in_zone(text,bigint,text) to authenticated, service_role;
revoke all on function public.get_foreverdb_item_locations(bigint) from public, anon;
grant execute on function public.get_foreverdb_item_locations(bigint) to authenticated, service_role;
revoke all on function public.get_foreverdb_source_locations(text,bigint,integer) from public, anon;
grant execute on function public.get_foreverdb_source_locations(text,bigint,integer) to authenticated, service_role;
revoke all on function public.get_foreverdb_item_stats(bigint) from public, anon;
grant execute on function public.get_foreverdb_item_stats(bigint) to authenticated, service_role;
revoke all on function public.get_foreverdb_source_stats(text,bigint,integer) from public, anon;
grant execute on function public.get_foreverdb_source_stats(text,bigint,integer) to authenticated, service_role;
revoke all on function public.get_foreverdb_zone_catalog(bigint,text,integer,integer) from public, anon;
grant execute on function public.get_foreverdb_zone_catalog(bigint,text,integer,integer) to authenticated, service_role;
revoke all on function public.get_foreverdb_search_global(text) from public, anon;
grant execute on function public.get_foreverdb_search_global(text) to authenticated, service_role;
revoke all on function public.ingest_foreverdb_snapshot_auth(jsonb) from public, anon;
grant execute on function public.ingest_foreverdb_snapshot_auth(jsonb) to authenticated, service_role;

-- Explicitly check that anonymous/key-only requests cannot bypass RPCs.
do $verify$
declare
    v text;
begin
    if has_schema_privilege('anon','private','usage') or
       has_schema_privilege('authenticated','private','usage') or
       has_table_privilege('anon','public.items','select') or
       has_table_privilege('authenticated','public.items','select') or
       has_table_privilege('anon','public.sources','select') or
       has_table_privilege('authenticated','public.sources','select') or
       has_function_privilege('anon',
          'public.get_foreverdb_zone_catalog(bigint,text,integer,integer)',
          'execute') or
       has_function_privilege('anon',
          'public.get_foreverdb_search_global(text)','execute') or
       has_function_privilege('anon',
          'public.get_foreverdb_item_stats(bigint)','execute') or
       has_function_privilege('anon',
          'public.ingest_foreverdb_snapshot_auth(jsonb)','execute')
    then
        raise exception 'API security contract FAILED; transaction aborted';
    end if;

    if not has_function_privilege('authenticated',
       'public.get_foreverdb_zone_catalog(bigint,text,integer,integer)',
       'execute') or not has_function_privilege('authenticated',
       'public.ingest_foreverdb_snapshot_auth(jsonb)','execute') then
        raise exception 'Authenticated Companion rights were lost';
    end if;
end $verify$;

notify pgrst, 'reload schema';

commit;
