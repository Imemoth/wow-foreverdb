-- Run ONLY in an ephemeral CI Postgres container (never on production).
-- Minimal Supabase Auth/JWT role emulation; no real users or secrets.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
-- Local PostgREST connects as authenticator and switches into JWT role.
-- This password is test-container-only, never reused for a real project.
create role authenticator noinherit login password 'local-test-password';
grant anon, authenticated to authenticator;

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

-- Supabase-managed trigger helper exists in the live project, but is not
-- part of the committed initial migration. Its body is irrelevant: 0004
-- revokes EXECUTE on the function in the isolated baseline.
create function public.rls_auto_enable()
returns event_trigger language plpgsql
as $$
begin
    null;
end;
$$;

-- The live project retains pre-repository private helpers installed during
-- early prototype development. Reproduce only their signatures in CI so the
-- backwards-compatible 0008a revocation is tested faithfully.
create function private.foreverdb_all_stats()
returns table (
    source_type text, source_id bigint, source_level integer,
    source_name text, loot_kind text, item_id bigint, item_name text,
    observations bigint, drop_count bigint, quantity bigint,
    quest_drop_count bigint, observed_drop_rate numeric
) language sql security definer set search_path = ''
as $$
select null::text, null::bigint, null::integer,
       null::text, null::text, null::bigint, null::text,
       null::bigint, null::bigint, null::bigint, null::bigint,
       null::numeric where false;
$$;

create function private.ingest_foreverdb_snapshot_auth(p_snapshot jsonb)
returns jsonb language sql security definer set search_path = ''
as $$ select jsonb_build_object('test_fixture', true); $$;

grant execute on function private.foreverdb_all_stats()
to anon, authenticated;
grant execute on function private.ingest_foreverdb_snapshot_auth(jsonb)
to anon, authenticated;

-- The production aggregate read functions were provisioned outside the
-- numbered migration history; their public wrappers are present in
-- production and are required for 0008a's compatibility assertion.
create function public.get_foreverdb_item_stats(p_item_id bigint)
returns table (
    source_type text, source_id bigint, source_level integer,
    source_name text, loot_kind text, item_id bigint, item_name text,
    observations bigint, drop_count bigint, quantity bigint,
    quest_drop_count bigint, observed_drop_rate numeric
) language sql set search_path = ''
as $$
    select * from private.foreverdb_item_stats(p_item_id);
$$;

create function public.get_foreverdb_source_stats(
    p_source_type text, p_source_id bigint, p_source_level integer
)
returns table (
    source_type text, source_id bigint, source_level integer,
    source_name text, loot_kind text, item_id bigint, item_name text,
    observations bigint, drop_count bigint, quantity bigint,
    quest_drop_count bigint, observed_drop_rate numeric
) language sql set search_path = ''
as $$
    select * from private.foreverdb_source_stats(
        p_source_type, p_source_id, p_source_level);
$$;

grant execute on function public.get_foreverdb_item_stats(bigint)
to anon, authenticated;
grant execute on function public.get_foreverdb_source_stats(text,bigint,integer)
to anon, authenticated;
