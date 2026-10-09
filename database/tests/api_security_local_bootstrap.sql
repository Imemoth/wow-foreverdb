-- Run ONLY in an ephemeral CI Postgres container (never on production).
-- Minimal Supabase Auth/JWT role emulation; no real users or secrets.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create function auth.uid()
returns uuid language sql stable set search_path = ''
as $$
    select nullif(
        current_setting('request.jwt.claim.sub', true),'')::uuid;
$$;

create function auth.role()
returns text language sql stable set search_path = ''
as $$
    select nullif(
        current_setting('request.jwt.claim.role', true),'');
$$;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

-- These read aggregate routines were added to the production database
-- before the GitHub migration log; stub only their exact output contract
-- for security-role tests. Production already has the real functions.
create schema if not exists private;
create function private.foreverdb_item_stats(p_item_id bigint)
returns table (
    source_type text, source_id bigint, source_level integer,
    source_name text, loot_kind text, item_id bigint,
    item_name text, observations bigint, drop_count bigint,
    quantity bigint, quest_drop_count bigint,
    observed_drop_rate numeric
) language sql security definer set search_path = ''
as $$
select null::text, null::bigint, null::integer,
       null::text, null::text, null::bigint, null::text,
       null::bigint, null::bigint, null::bigint, null::bigint,
       null::numeric where false;
$$;
create function private.foreverdb_source_stats(
    p_source_type text, p_source_id bigint, p_source_level integer
)
returns table (
    source_type text, source_id bigint, source_level integer,
    source_name text, loot_kind text, item_id bigint,
    item_name text, observations bigint, drop_count bigint,
    quantity bigint, quest_drop_count bigint,
    observed_drop_rate numeric
) language sql security definer set search_path = ''
as $$
select null::text, null::bigint, null::integer,
       null::text, null::text, null::bigint, null::text,
       null::bigint, null::bigint, null::bigint, null::bigint,
       null::numeric where false;
$$;
