-- Nonbreaking rollout precursor for Companion search.
-- Safe to deploy while older Companion builds still use direct /items
-- and /sources. Does not remove ANY existing grants or private functions.
-- Once the new Companion is installed and passes its real Windows
-- Search/Detail tests, apply 0009 to rate-limit/lock down legacy access.
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
    -- Supabase Auth session, even on the additive pre-deployment phase.
    -- The following 0009 lockdown adds the shared 429 server quotas.
    if auth.uid() is null or auth.role() is distinct from 'authenticated' then
        raise sqlstate 'PT401'
            using message = 'ForeverDB authenticated session required';
    end if;

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


revoke all on function public.get_foreverdb_search_global(text)
from public, anon;
grant execute on function public.get_foreverdb_search_global(text)
to authenticated, service_role;

notify pgrst, 'reload schema';
