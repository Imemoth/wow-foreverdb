-- ForeverDB 0016: account-scoped Guildbook storage and independent public ingest.
--
-- Public observation ingest keeps its existing signatures and credentials, but
-- strips private Guildbook fields before the legacy collector implementation.
-- The new account RPC stores Guildbook under the verified registered session,
-- with a per-installation capture ledger preventing replay and stale imports.
-- Existing installation-owned Guildbook rows are retained and copied only for
-- the current confirmed registered owner; installation ownership is unchanged.
--
-- Forward-only. This migration is intentionally not applied to live Supabase
-- by the repository. A future rollback must revoke the new RPCs and retain
-- the account tables/ledger if they contain provenance or user data.

begin;

-- ---------------------------------------------------------------------------------------------------------------------
-- 1. Pre-flight: refuse a partial or already-applied database.
-- ---------------------------------------------------------------------------------------------------------------------
do $preflight$
declare
    v_sig text;
    v_local_only boolean := false;
begin
    if to_regclass('private.guildbook_cloud_sync_guard') is not null then
        execute 'select exists (select 1 from private.guildbook_cloud_sync_guard where guard_name = ''disabled'')'
            into v_local_only;
    end if;
    if to_regclass('supabase_migrations.schema_migrations') is not null then
        if exists (select 1 from supabase_migrations.schema_migrations where name = 'account_scoped_guildbook') then
            raise exception '0016 pre-flight: ledger already shows account_scoped_guildbook';
        end if;
    end if;

    foreach v_sig in array array[
        'private.foreverdb_ingest_snapshot_impl_v1(jsonb)',
        'private.fdb_caller()',
        'private.fdb_registered_caller()',
        'private.foreverdb_api_gate(text)',
        'public.ingest_foreverdb_snapshot_auth(jsonb)',
        'public.fdb_device_ingest(text,jsonb)',
        'public.fdb_account_guildbook_guilds(text)',
        'public.fdb_account_guildbook_members(text,text,integer,integer)'
    ] loop
        if to_regprocedure(v_sig) is null then
            raise exception '0016 pre-flight: % is missing (apply 0009, 0012 and 0014 first)', v_sig;
        end if;
    end loop;

    if to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is not null
       and not v_local_only then
        raise exception '0016 pre-flight: legacy ingest compatibility name is already occupied';
    end if;

    if to_regclass('public.installations') is null
       or to_regclass('public.installation_guilds') is null
       or to_regclass('public.installation_guild_members') is null
       or to_regclass('public.installation_guild_professions') is null then
        raise exception '0016 pre-flight: installation/Guildbook tables are missing';
    end if;

    if not has_table_privilege(current_user, 'auth.sessions', 'SELECT')
       or not has_table_privilege(current_user, 'auth.sessions', 'UPDATE')
       or not has_table_privilege(current_user, 'auth.users', 'SELECT') then
        raise exception '0016 pre-flight: role % lacks SELECT/UPDATE on auth.sessions or SELECT on auth.users', current_user;
    end if;
end $preflight$;

-- The migration is allowed to replace only the collector wrapper, device wrapper,
-- and the new account Guildbook RPC family. All other functions retain a
-- prosrc/ACL fingerprint through the postcondition below.
create temporary table _fdb0016_before on commit drop as
select p.oid::regprocedure::text as sig, md5(p.prosrc) as src_md5, coalesce(p.proacl::text, '') as acl
from pg_proc p
where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
  and p.proname not in (
      'foreverdb_ingest_snapshot_impl_v1',
      'fdb_public_snapshot',
      'fdb_account_guildbook_ingest'
  );

-- ---------------------------------------------------------------------------------------------------------------------
-- 2. Account-owned Guildbook and capture provenance.
-- ---------------------------------------------------------------------------------------------------------------------
create table if not exists private.account_guildbook_captures (
    installation_id text not null references public.installations(id) on delete cascade,
    capture_id text not null,
    account_uid uuid not null,
    captured_at bigint not null check (captured_at >= 0),
    source_character text not null,
    accepted_at timestamptz not null default now(),
    primary key (installation_id, capture_id)
);
create index if not exists account_guildbook_captures_latest_idx
    on private.account_guildbook_captures (installation_id, captured_at desc);

create table if not exists private.account_guildbook_guilds (
    account_uid uuid not null,
    installation_id text not null references public.installations(id) on delete cascade,
    guild_key text not null,
    guild_name text not null,
    realm_name text not null default '',
    captured_at bigint not null default 0,
    capture_id text not null,
    updated_at timestamptz not null default now(),
    primary key (account_uid, installation_id, guild_key),
    foreign key (installation_id, capture_id)
        references private.account_guildbook_captures(installation_id, capture_id)
        on delete cascade
);

create table if not exists private.account_guildbook_members (
    account_uid uuid not null,
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
    capture_id text not null,
    updated_at timestamptz not null default now(),
    primary key (account_uid, installation_id, guild_key, member_guid),
    foreign key (account_uid, installation_id, guild_key)
        references private.account_guildbook_guilds(account_uid, installation_id, guild_key)
        on delete cascade,
    foreign key (installation_id, capture_id)
        references private.account_guildbook_captures(installation_id, capture_id)
        on delete cascade
);

create table if not exists private.account_guildbook_professions (
    account_uid uuid not null,
    installation_id text not null,
    guild_key text not null,
    member_guid text not null,
    skill_line_id integer not null,
    profession_name text not null default '',
    skill integer not null default 0 check (skill >= 0),
    max_skill integer not null default 0 check (max_skill >= 0),
    source text not null default '',
    is_secondary boolean not null default false,
    capture_id text not null,
    updated_at timestamptz not null default now(),
    primary key (account_uid, installation_id, guild_key, member_guid, skill_line_id),
    foreign key (account_uid, installation_id, guild_key, member_guid)
        references private.account_guildbook_members(account_uid, installation_id, guild_key, member_guid)
        on delete cascade,
    foreign key (installation_id, capture_id)
        references private.account_guildbook_captures(installation_id, capture_id)
        on delete cascade
);

create index if not exists account_guildbook_guilds_name_idx
    on private.account_guildbook_guilds (account_uid, installation_id, lower(guild_name));
create index if not exists account_guildbook_members_name_idx
    on private.account_guildbook_members (account_uid, installation_id, guild_key, lower(member_name));

alter table private.account_guildbook_captures enable row level security;
alter table private.account_guildbook_guilds enable row level security;
alter table private.account_guildbook_members enable row level security;
alter table private.account_guildbook_professions enable row level security;

revoke all on table private.account_guildbook_captures from public, anon, authenticated, service_role;
revoke all on table private.account_guildbook_guilds from public, anon, authenticated, service_role;
revoke all on table private.account_guildbook_members from public, anon, authenticated, service_role;
revoke all on table private.account_guildbook_professions from public, anon, authenticated, service_role;

-- Deterministic compatibility transition. It copies rows owned by the
-- installation's current confirmed registered account only. Anonymous rows
-- remain in the historical installation tables and are never account-visible.
insert into private.account_guildbook_captures (installation_id, capture_id, account_uid, captured_at, source_character)
select i.id,
       'legacy:' || md5(i.id),
       i.owner_user_id,
       greatest(0, coalesce(max(g.captured_at), 0)),
       'legacy'
from public.installations i
join auth.users u on u.id = i.owner_user_id
join public.installation_guilds g on g.installation_id = i.id
where not u.is_anonymous and u.email_confirmed_at is not null
group by i.id, i.owner_user_id
on conflict (installation_id, capture_id) do nothing;

insert into private.account_guildbook_guilds
    (account_uid, installation_id, guild_key, guild_name, realm_name, captured_at, capture_id, updated_at)
select i.owner_user_id, g.installation_id, g.guild_key, g.guild_name, g.realm_name, g.captured_at,
       'legacy:' || md5(i.id), g.updated_at
from public.installations i
join auth.users u on u.id = i.owner_user_id
join public.installation_guilds g on g.installation_id = i.id
where not u.is_anonymous and u.email_confirmed_at is not null
on conflict (account_uid, installation_id, guild_key) do nothing;

insert into private.account_guildbook_members
    (account_uid, installation_id, guild_key, member_guid, member_name, class_name, class_file, level,
     rank_name, rank_index, online, zone_name, last_online_hours, capture_id, updated_at)
select i.owner_user_id, m.installation_id, m.guild_key, m.member_guid, m.member_name, m.class_name, m.class_file, m.level,
       m.rank_name, m.rank_index, m.online, m.zone_name, m.last_online_hours, 'legacy:' || md5(i.id), m.updated_at
from public.installations i
join auth.users u on u.id = i.owner_user_id
join public.installation_guild_members m on m.installation_id = i.id
where not u.is_anonymous and u.email_confirmed_at is not null
on conflict (account_uid, installation_id, guild_key, member_guid) do nothing;

insert into private.account_guildbook_professions
    (account_uid, installation_id, guild_key, member_guid, skill_line_id, profession_name, skill, max_skill,
     source, is_secondary, capture_id, updated_at)
select i.owner_user_id, p.installation_id, p.guild_key, p.member_guid, p.skill_line_id, p.profession_name, p.skill, p.max_skill,
       p.source, p.is_secondary, 'legacy:' || md5(i.id), p.updated_at
from public.installations i
join auth.users u on u.id = i.owner_user_id
join public.installation_guild_professions p on p.installation_id = i.id
where not u.is_anonymous and u.email_confirmed_at is not null
on conflict (account_uid, installation_id, guild_key, member_guid, skill_line_id) do nothing;

-- ---------------------------------------------------------------------------------------------------------------------
-- 3. Public payload separation. The legacy implementation remains intact
-- under a private compatibility name; its public/private callers now receive
-- an observation-only snapshot.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function private.fdb_public_snapshot(p_snapshot jsonb)
returns jsonb
language sql
security definer
set search_path = ''
as $$
    select coalesce(p_snapshot, '{}'::jsonb)
        - 'guilds'
        - 'guildbook'
        - 'guildbookCapture'
        - 'guildbookCaptureId'
        - 'guildbookCapturedAt'
        - 'guildbookSourceCharacter';
$$;

do $prepare_ingest$
begin
    if to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is null then
        execute 'alter function private.foreverdb_ingest_snapshot_impl_v1(jsonb) rename to foreverdb_ingest_snapshot_impl_v1_legacy';
    end if;
end $prepare_ingest$;

create or replace function private.foreverdb_ingest_snapshot_impl_v1(p_snapshot jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_installation text := p_snapshot->>'installationId';
    v_result jsonb;
begin
    -- The legacy implementation deletes and rebuilds Guildbook rows even
    -- when the incoming projection contains no private fields. Preserve the
    -- existing rows around the public observation ingest in both migration
    -- orders, while never passing private fields to the legacy body.
    drop table if exists pg_temp._fdb0016_guilds;
    drop table if exists pg_temp._fdb0016_guild_members;
    drop table if exists pg_temp._fdb0016_guild_professions;

    create temp table _fdb0016_guilds on commit drop as
        select * from public.installation_guilds where installation_id = v_installation;
    create temp table _fdb0016_guild_members on commit drop as
        select * from public.installation_guild_members where installation_id = v_installation;
    create temp table _fdb0016_guild_professions on commit drop as
        select * from public.installation_guild_professions where installation_id = v_installation;

    v_result := private.foreverdb_ingest_snapshot_impl_v1_legacy(
        private.fdb_public_snapshot(p_snapshot)
    );

    insert into public.installation_guilds select * from pg_temp._fdb0016_guilds;
    insert into public.installation_guild_members select * from pg_temp._fdb0016_guild_members;
    insert into public.installation_guild_professions select * from pg_temp._fdb0016_guild_professions;
    return v_result;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4. Account ingest and compatible account reads.
-- ---------------------------------------------------------------------------------------------------------------------
create or replace function public.fdb_account_guildbook_ingest(
    p_installation_id text,
    p_capture_id text,
    p_captured_at bigint,
    p_source_character text,
    p_guilds jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
    v_sid uuid;
    v_session_created_at bigint;
    v_latest bigint;
    v_guild jsonb;
    v_member jsonb;
    v_profession jsonb;
    v_guild_key text;
    v_member_guid text;
begin
    v_uid := private.fdb_registered_caller();
    v_sid := (auth.jwt() ->> 'session_id')::uuid;
    perform private.foreverdb_api_gate('ingest');

    if p_installation_id is null or length(p_installation_id) not between 1 and 128
       or p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
       or p_capture_id is null or length(p_capture_id) not between 1 and 200
       or p_captured_at is null or p_captured_at < 0
       or p_source_character is null or length(p_source_character) not between 1 and 200
       or jsonb_typeof(p_guilds) is distinct from 'array'
       or octet_length(p_guilds::text) > 8388608
       or jsonb_array_length(p_guilds) > 100 then
        raise sqlstate 'PT400' using message = 'Invalid Guildbook capture payload';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_installation_id, 0));

    -- Re-check the exact live session after taking the installation lock so a
    -- concurrent sign-out cannot authorize a write that commits afterward.
    select extract(epoch from s.created_at)::bigint
    into v_session_created_at
    from auth.sessions s
    join auth.users u on u.id = s.user_id
    where s.id = v_sid and s.user_id = v_uid
      and (s.not_after is null or s.not_after > now())
      and exists (select 1 from auth.refresh_tokens r where r.session_id = s.id and not r.revoked)
      and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
      and not u.is_anonymous and u.email_confirmed_at is not null
    for share of s;
    if not found then
        raise sqlstate 'PT401' using message = 'ForeverDB authenticated session required';
    end if;

    -- A capture made before this registered session began is local history of
    -- unknown account ownership and cannot be attributed after a switch.
    if p_captured_at < v_session_created_at then
        return jsonb_build_object('ok', false, 'error', 'capture_stale');
    end if;

    if not exists (select 1 from public.installations i where i.id = p_installation_id) then
        return jsonb_build_object('ok', false, 'error', 'installation_unknown');
    end if;

    select max(c.captured_at) into v_latest
    from private.account_guildbook_captures c
    where c.installation_id = p_installation_id;

    if exists (
        select 1 from private.account_guildbook_captures c
        where c.installation_id = p_installation_id and c.capture_id = p_capture_id
    ) then
        return jsonb_build_object('ok', false, 'error', 'capture_replayed');
    end if;
    if v_latest is not null and p_captured_at < v_latest then
        return jsonb_build_object('ok', false, 'error', 'capture_stale');
    end if;

    insert into private.account_guildbook_captures
        (installation_id, capture_id, account_uid, captured_at, source_character)
    values
        (p_installation_id, p_capture_id, v_uid, p_captured_at, p_source_character);

    delete from private.account_guildbook_professions
    where account_uid = v_uid and installation_id = p_installation_id;
    delete from private.account_guildbook_members
    where account_uid = v_uid and installation_id = p_installation_id;
    delete from private.account_guildbook_guilds
    where account_uid = v_uid and installation_id = p_installation_id;

    for v_guild in select value from jsonb_array_elements(p_guilds) loop
        v_guild_key := v_guild->>'guildKey';
        if v_guild_key is null or length(v_guild_key) = 0 then
            continue;
        end if;

        insert into private.account_guildbook_guilds
            (account_uid, installation_id, guild_key, guild_name, realm_name, captured_at, capture_id, updated_at)
        values
            (v_uid, p_installation_id, v_guild_key, coalesce(v_guild->>'name', ''),
             coalesce(v_guild->>'realmName', ''), coalesce((v_guild->>'capturedAt')::bigint, p_captured_at),
             p_capture_id, now());

        for v_member in select value from jsonb_array_elements(coalesce(v_guild->'members', '[]'::jsonb)) loop
            v_member_guid := v_member->>'guid';
            if v_member_guid is null or length(v_member_guid) = 0 then
                continue;
            end if;

            insert into private.account_guildbook_members
                (account_uid, installation_id, guild_key, member_guid, member_name, class_name, class_file, level,
                 rank_name, rank_index, online, zone_name, last_online_hours, capture_id, updated_at)
            values
                (v_uid, p_installation_id, v_guild_key, v_member_guid, coalesce(v_member->>'name', ''),
                 coalesce(v_member->>'className', ''), coalesce(v_member->>'classFile', ''),
                 coalesce((v_member->>'level')::integer, 0), coalesce(v_member->>'rankName', ''),
                 coalesce((v_member->>'rankIndex')::integer, -1), coalesce((v_member->>'online')::boolean, false),
                 coalesce(v_member->>'zone', ''), coalesce((v_member->>'lastOnlineHours')::bigint, 0),
                 p_capture_id, now());

            for v_profession in select value from jsonb_array_elements(coalesce(v_member->'professions', '[]'::jsonb)) loop
                insert into private.account_guildbook_professions
                    (account_uid, installation_id, guild_key, member_guid, skill_line_id, profession_name, skill,
                     max_skill, source, is_secondary, capture_id, updated_at)
                values
                    (v_uid, p_installation_id, v_guild_key, v_member_guid,
                     (v_profession->>'skillLineId')::integer, coalesce(v_profession->>'name', ''),
                     coalesce((v_profession->>'skill')::integer, 0), coalesce((v_profession->>'maxSkill')::integer, 0),
                     coalesce(v_profession->>'source', ''), coalesce((v_profession->>'isSecondary')::boolean, false),
                     p_capture_id, now());
            end loop;
        end loop;
    end loop;

    return jsonb_build_object(
        'ok', true,
        'status', 'applied',
        'installation_id', p_installation_id,
        'capture_id', p_capture_id,
        'captured_at', p_captured_at
    );
end;
$$;

create or replace function public.fdb_account_guildbook_guilds_scoped(p_installation_id text)
returns table (guild_key text, guild_name text, realm_name text, captured_at bigint, member_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
begin
    v_uid := private.fdb_registered_caller();
    perform private.foreverdb_api_gate('detail');

    if p_installation_id is null or length(p_installation_id) not between 1 and 128
       or p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
        raise sqlstate 'PT400' using message = 'Invalid installation identifier';
    end if;

    return query
    select g.guild_key, g.guild_name, g.realm_name, g.captured_at,
           (select count(*) from private.account_guildbook_members m
             where m.account_uid = g.account_uid and m.installation_id = g.installation_id
               and m.guild_key = g.guild_key)::integer
    from private.account_guildbook_guilds g
    where g.account_uid = v_uid and g.installation_id = p_installation_id
    union all
    select g.guild_key, g.guild_name, g.realm_name, g.captured_at,
           (select count(*) from public.installation_guild_members m
             where m.installation_id = g.installation_id and m.guild_key = g.guild_key)::integer
    from public.installation_guilds g
    join public.installations i on i.id = g.installation_id
    where g.installation_id = p_installation_id and i.owner_user_id = v_uid
      and not exists (select 1 from private.account_guildbook_captures c
                      where c.account_uid = v_uid and c.installation_id = g.installation_id)
    order by guild_name, guild_key
    limit 100;
end;
$$;

create or replace function public.fdb_account_guildbook_members_scoped(
    p_installation_id text,
    p_guild_key text,
    p_limit integer default 100,
    p_offset integer default 0
)
returns table (
    member_guid text, member_name text, class_name text, class_file text, level integer, rank_name text,
    rank_index integer, online boolean, zone_name text, last_online_hours integer, professions jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_uid uuid;
    v_limit integer;
    v_offset integer;
begin
    v_uid := private.fdb_registered_caller();
    perform private.foreverdb_api_gate('detail');

    if p_installation_id is null or length(p_installation_id) not between 1 and 128
       or p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
       or p_guild_key is null or length(p_guild_key) not between 1 and 200 then
        raise sqlstate 'PT400' using message = 'Invalid Guildbook parameters';
    end if;
    v_limit := greatest(1, least(coalesce(p_limit, 100), 200));
    v_offset := greatest(0, least(coalesce(p_offset, 0), 100000));

    return query
    select m.member_guid, m.member_name, m.class_name, m.class_file, m.level, m.rank_name, m.rank_index, m.online, m.zone_name,
           least(m.last_online_hours, 2147483647)::integer,
           coalesce((select jsonb_agg(jsonb_build_object(
               'skill_line_id', p.skill_line_id, 'name', p.profession_name, 'skill', p.skill,
               'max_skill', p.max_skill, 'source', p.source, 'is_secondary', p.is_secondary
           ) order by p.skill_line_id)
           from private.account_guildbook_professions p
           where p.account_uid = m.account_uid and p.installation_id = m.installation_id
             and p.guild_key = m.guild_key and p.member_guid = m.member_guid), '[]'::jsonb)
    from private.account_guildbook_members m
    where m.account_uid = v_uid and m.installation_id = p_installation_id and m.guild_key = p_guild_key
    union all
    select m.member_guid, m.member_name, m.class_name, m.class_file, m.level, m.rank_name, m.rank_index, m.online, m.zone_name,
           least(m.last_online_hours, 2147483647)::integer, '[]'::jsonb
    from public.installation_guild_members m
    join public.installations i on i.id = m.installation_id
    where m.installation_id = p_installation_id and m.guild_key = p_guild_key and i.owner_user_id = v_uid
      and not exists (select 1 from private.account_guildbook_captures c
                      where c.account_uid = v_uid and c.installation_id = m.installation_id)
    order by rank_index, member_name
    limit v_limit offset v_offset;
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- 5. Privileges and postconditions.
-- ---------------------------------------------------------------------------------------------------------------------
alter function public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb) set lock_timeout = '10s';
alter function public.fdb_account_guildbook_guilds_scoped(text) set lock_timeout = '5s';
alter function public.fdb_account_guildbook_members_scoped(text,text,integer,integer) set lock_timeout = '5s';

revoke all on function private.fdb_public_snapshot(jsonb) from public, anon, authenticated, service_role;
revoke all on function private.foreverdb_ingest_snapshot_impl_v1(jsonb) from public, anon, authenticated, service_role;

revoke all on function public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb) to authenticated;
revoke all on function public.fdb_account_guildbook_guilds_scoped(text) from public, anon, authenticated, service_role;
grant execute on function public.fdb_account_guildbook_guilds_scoped(text) to authenticated;
revoke all on function public.fdb_account_guildbook_members_scoped(text,text,integer,integer) from public, anon, authenticated, service_role;
grant execute on function public.fdb_account_guildbook_members_scoped(text,text,integer,integer) to authenticated;

-- If 0018 was already applied, this migration may create the compatibility
-- objects it needs but must not reopen any Guildbook cloud RPC. The catalog
-- sweep also covers legacy overloads that are present only in the current
-- production schema.
do $local_only_acl$
declare
    r record;
    v_local_only boolean := false;
begin
    if to_regclass('private.guildbook_cloud_sync_guard') is not null then
        execute 'select exists (select 1 from private.guildbook_cloud_sync_guard where guard_name = ''disabled'')'
            into v_local_only;
    end if;
    if v_local_only then
        for r in
            select p.oid::regprocedure::text as sig
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname like 'fdb_account_guildbook_%'
        loop
            execute format('revoke all on function %s from public, anon, authenticated, service_role', r.sig);
        end loop;
    end if;
end $local_only_acl$;

do $verify$
declare
    v_sig text;
    v_after record;
    r record;
    v_local_only boolean := false;
begin
    if to_regclass('private.guildbook_cloud_sync_guard') is not null then
        execute 'select exists (select 1 from private.guildbook_cloud_sync_guard where guard_name = ''disabled'')'
            into v_local_only;
    end if;
    foreach v_sig in array array[
        'private.fdb_public_snapshot(jsonb)',
        'private.foreverdb_ingest_snapshot_impl_v1(jsonb)',
        'public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb)',
        'public.fdb_account_guildbook_guilds_scoped(text)',
        'public.fdb_account_guildbook_members_scoped(text,text,integer,integer)'
    ] loop
        select p.prosecdef, pg_get_userbyid(p.proowner) as owner, coalesce(p.proconfig, '{}') as config, p.provolatile
        into v_after from pg_proc p where p.oid = to_regprocedure(v_sig);
        if not found then raise exception '0016 post-condition: % is missing', v_sig; end if;
        if not v_after.prosecdef or v_after.owner <> current_user or v_after.provolatile <> 'v' then
            raise exception '0016 post-condition: % security/owner/volatility contract failed', v_sig;
        end if;
        if not ('search_path=""' = any (v_after.config)) then
            raise exception '0016 post-condition: % lacks search_path = empty', v_sig;
        end if;
    end loop;

    if v_local_only then
        for r in
            select p.oid::regprocedure::text as sig
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname like 'fdb_account_guildbook_%'
        loop
            if has_function_privilege('public', r.sig, 'execute')
               or has_function_privilege('anon', r.sig, 'execute')
               or has_function_privilege('authenticated', r.sig, 'execute')
               or has_function_privilege('service_role', r.sig, 'execute') then
                raise exception '0016 post-condition: local-only Guildbook RPC % remains executable', r.sig;
            end if;
        end loop;
    else
        if has_function_privilege('public', 'public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb)', 'execute')
           or has_function_privilege('anon', 'public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb)', 'execute')
           or has_function_privilege('service_role', 'public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb)', 'execute')
           or not has_function_privilege('authenticated', 'public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb)', 'execute') then
            raise exception '0016 post-condition: account ingest ACL is incorrect';
        end if;
        if has_function_privilege('public', 'public.fdb_account_guildbook_guilds_scoped(text)', 'execute')
           or has_function_privilege('anon', 'public.fdb_account_guildbook_guilds_scoped(text)', 'execute')
           or has_function_privilege('service_role', 'public.fdb_account_guildbook_guilds_scoped(text)', 'execute')
           or not has_function_privilege('authenticated', 'public.fdb_account_guildbook_guilds_scoped(text)', 'execute')
           or has_function_privilege('public', 'public.fdb_account_guildbook_members_scoped(text,text,integer,integer)', 'execute')
           or has_function_privilege('anon', 'public.fdb_account_guildbook_members_scoped(text,text,integer,integer)', 'execute')
           or has_function_privilege('service_role', 'public.fdb_account_guildbook_members_scoped(text,text,integer,integer)', 'execute')
           or not has_function_privilege('authenticated', 'public.fdb_account_guildbook_members_scoped(text,text,integer,integer)', 'execute') then
            raise exception '0016 post-condition: scoped account read ACL is incorrect';
        end if;
    end if;

    for v_sig in select unnest(array['private.account_guildbook_captures', 'private.account_guildbook_guilds',
                                     'private.account_guildbook_members', 'private.account_guildbook_professions']) loop
        if not (select c.relrowsecurity from pg_class c where c.oid = v_sig::regclass) then
            raise exception '0016 post-condition: RLS is not enabled on %', v_sig;
        end if;
        if has_table_privilege('public', v_sig, 'select,insert,update,delete,truncate,references,trigger')
           or has_table_privilege('anon', v_sig, 'select,insert,update,delete,truncate,references,trigger')
           or has_table_privilege('authenticated', v_sig, 'select,insert,update,delete,truncate,references,trigger')
           or has_table_privilege('service_role', v_sig, 'select,insert,update,delete,truncate,references,trigger') then
            raise exception '0016 post-condition: a client role has a privilege on %', v_sig;
        end if;
    end loop;

    for r in select * from _fdb0016_before loop
        select md5(p.prosrc) as src_md5, coalesce(p.proacl::text, '') as acl
        into v_after from pg_proc p where p.oid = to_regprocedure(r.sig);
        if not found or v_after.src_md5 is distinct from r.src_md5 or v_after.acl is distinct from r.acl then
            raise exception '0016 post-condition: existing function % changed', r.sig;
        end if;
    end loop;

    if to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is null then
        raise exception '0016 post-condition: legacy ingest implementation was not retained';
    end if;
end $verify$;

notify pgrst, 'reload schema';

commit;
