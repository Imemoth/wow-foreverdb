-- ForeverDB 0016: Browser Pairing V1. Schema-only foundation; all release gates remain OFF.
-- Requires 0012 + 0014, independently of PR #58's 0015 azerdex_welcome_outbox.
-- No ownership/history write, ledger entry, public RPC, or feature enablement is performed here.
-- Normative contract: docs/account-v1/browser-pairing-state-machine.md.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Refuse partial/unexpected predecessors and repeated application. Restore is a separately reviewed operation.
do $preflight$
declare
    v_name text;
    v_table text;
    v_col text;
begin
    foreach v_name in array array['private', 'auth', 'extensions'] loop
        if to_regnamespace(v_name) is null then
            raise exception '0016 pre-flight: schema % missing (apply 0012/0014 first)', v_name;
        end if;
    end loop;
    foreach v_table in array array[
        'public.installations', 'private.account_installations', 'private.installation_claims', 'private.account_audit',
        'private.enrollment_tickets', 'private.devices', 'private.device_audit', 'auth.users', 'auth.sessions', 'auth.refresh_tokens'
    ] loop
        if to_regclass(v_table) is null then
            raise exception '0016 pre-flight: % missing (apply 0012/0014 first)', v_table;
        end if;
    end loop;
    foreach v_name in array array[
        'private.fdb_caller()', 'private.fdb_anonymous_caller()', 'private.fdb_registered_caller()',
        'private.fdb_lock_live_session(uuid,uuid,boolean)', 'private.fdb_account_usable(uuid)',
        'private.foreverdb_take_budget(text,integer,integer)', 'private.foreverdb_api_gate(text)',
        'private.foreverdb_ingest_snapshot_impl_v1(jsonb)', 'public.ingest_foreverdb_snapshot_auth(jsonb)',
        'public.fdb_account_claim_redeem(text)', 'public.fdb_device_enroll(text,text,text)',
        'public.fdb_device_status(text)', 'public.fdb_device_ingest(text,jsonb)',
        'public.fdb_account_device_revoke(uuid)', 'extensions.gen_random_bytes(integer)', 'extensions.digest(text,text)'
    ] loop
        if to_regprocedure(v_name) is null or not has_function_privilege(current_user, to_regprocedure(v_name), 'EXECUTE') then
            raise exception '0016 pre-flight: required 0012/0014 or crypto function % unavailable', v_name;
        end if;
    end loop;
    for v_table, v_col in select * from (values
        ('public.installations','owner_user_id'), ('private.devices','ticket_id'), ('private.devices','credential_hash'),
        ('private.devices','installation_id'), ('private.devices','auth_uid'), ('private.devices','account_uid'),
        ('private.devices','status'), ('private.devices','revoked_at'),
        ('auth.users','id'), ('auth.users','is_anonymous'), ('auth.users','email_confirmed_at'), ('auth.users','deleted_at'), ('auth.users','banned_until'),
        ('auth.sessions','id'), ('auth.sessions','user_id'), ('auth.sessions','not_after'),
        ('auth.refresh_tokens','session_id'), ('auth.refresh_tokens','revoked')
    ) as required(t,c) loop
        if not exists (select 1 from pg_attribute where attrelid=v_table::regclass and attname=v_col and not attisdropped) then
            raise exception '0016 pre-flight: %.% missing', v_table, v_col;
        end if;
    end loop;
    if not (select attnotnull from pg_attribute where attrelid='private.devices'::regclass and attname='ticket_id')
       or not exists (select 1 from pg_constraint where conrelid='private.devices'::regclass and conname='devices_ticket_id_fkey'
                      and contype='f' and confrelid='private.enrollment_tickets'::regclass and convalidated)
       or (select count(*) from pg_constraint where conrelid='private.account_installations'::regclass and contype='f' and convalidated) <> 2
       or not exists (select 1 from pg_constraint where conrelid='private.account_audit'::regclass and conname='account_audit_event_check' and convalidated)
       or to_regclass('private.devices_one_live_per_installation') is null
       or to_regclass('private.devices_one_live_per_identity') is null then
        raise exception '0016 pre-flight: 0012/0014 provenance or live-device constraints missing';
    end if;
    if not exists (select 1 from pg_roles where rolname=current_user and (rolbypassrls or rolsuper))
       or not has_table_privilege(current_user,'auth.sessions','SELECT')
       or not has_table_privilege(current_user,'auth.sessions','UPDATE')
       or not has_table_privilege(current_user,'auth.users','SELECT')
       or not has_table_privilege(current_user,'auth.refresh_tokens','SELECT')
       or not pg_has_role(current_user,(select relowner from pg_class where oid='private.devices'::regclass),'USAGE') then
        raise exception '0016 pre-flight: migration role lacks ownership, BYPASSRLS, or Auth read/lock privileges';
    end if;
    foreach v_name in array array['anon','authenticated','service_role'] loop
        if not exists (select 1 from pg_roles where rolname=v_name) then
            raise exception '0016 pre-flight: API role % missing', v_name;
        end if;
    end loop;
    if has_schema_privilege('anon','private','USAGE') or has_schema_privilege('authenticated','private','USAGE') then
        raise exception '0016 pre-flight: private schema reachable by client role';
    end if;
    if to_regclass('supabase_migrations.schema_migrations') is not null then
        if not exists (select 1 from supabase_migrations.schema_migrations where name='fix_observed_drop_rate_denominator')
           or exists (select 1 from supabase_migrations.schema_migrations
                      where name in ('browser_pairing','rollback_browser_pairing','browser_pairing_restore') or version='0016') then
            raise exception '0016 pre-flight: unexpected migration ledger state; use the reviewed restore after rollback';
        end if;
    end if;
    foreach v_name in array array['private.device_pairing_config', 'private.device_pairings', 'private.device_pairing_audit',
        'private.device_pairing_audit_id_seq', 'private.devices_one_per_pairing'] loop
        if to_regclass(v_name) is not null then
            raise exception '0016 pre-flight: conflicting object % already exists', v_name;
        end if;
    end loop;
    if exists (select 1 from pg_attribute where attrelid='private.devices'::regclass and attname='pairing_id' and not attisdropped)
       or exists (select 1 from pg_constraint where conrelid='private.devices'::regclass and conname='devices_exactly_one_provenance') then
        raise exception '0016 pre-flight: conflicting device pairing provenance';
    end if;
end $preflight$;

-- Preserve all earlier public/private functions, including 0012/0014 definitions, owner, settings and ACLs.
create temporary table _fdb0016_functions on commit drop as
select p.oid, p.oid::regprocedure::text sig, md5(pg_get_functiondef(p.oid)) definition,
       p.proowner, p.proacl::text acl
from pg_proc p where p.pronamespace in ('public'::regnamespace,'private'::regnamespace);

-- No writes to predecessor tables are permitted. Lock them against concurrent writes while checking stable row hashes.
-- This also makes the provenance ALTER operate on exactly the rows validated by the pre/postconditions.
lock table public.installations, private.account_installations, private.account_audit, private.installation_claims,
    private.enrollment_tickets, private.devices, private.device_audit,
    public.installation_item_stats, public.installation_source_stats, public.installation_location_stats,
    public.installation_guilds, public.installation_guild_members, public.installation_guild_professions,
    public.sources, public.items in share mode;
create temporary table _fdb0016_rows on commit drop as
select 'public.installations'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installations t
union all
select 'private.account_installations'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.account_installations t
union all
select 'private.account_audit'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.account_audit t
union all
select 'private.installation_claims'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.installation_claims t
union all
select 'private.enrollment_tickets'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.enrollment_tickets t
union all
select 'private.devices'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.devices t
union all
select 'private.device_audit'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.device_audit t
union all
select 'public.sources'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.sources t
union all
select 'public.items'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.items t
union all
select 'public.installation_item_stats'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_item_stats t
union all
select 'public.installation_source_stats'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_source_stats t
union all
select 'public.installation_location_stats'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_location_stats t
union all
select 'public.installation_guilds'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_guilds t
union all
select 'public.installation_guild_members'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_guild_members t
union all
select 'public.installation_guild_professions'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_guild_professions t;
create temporary table _fdb0016_claim_schema on commit drop as
select c.oid, c.relacl::text acl, c.relrowsecurity, c.relforcerowsecurity,
       (select jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
        from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
        where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) columns,
       (select jsonb_agg(pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid) constraints
from pg_class c where c.oid in ('private.account_installations'::regclass,'private.account_audit'::regclass);

create table private.device_pairing_config (
    singleton boolean primary key default true check (singleton),
    enabled boolean not null default false,
    updated_at timestamptz not null default now()
);
insert into private.device_pairing_config (singleton, enabled) values (true, false);

create table private.device_pairings (
    id uuid primary key,
    audit_ref uuid not null unique default gen_random_uuid(),
    installation_id text not null check (length(installation_id) between 16 and 128),
    initiator_uid uuid not null,
    initiator_session_id uuid not null,
    poll_secret_hash bytea not null unique check (octet_length(poll_secret_hash)=32),
    proposed_device_id uuid not null unique,
    device_credential_hash bytea not null check (octet_length(device_credential_hash)=32),
    computer_label text check (computer_label is null or (length(computer_label)<=60 and computer_label !~ '[[:cntrl:]]')),
    status text not null check (status in ('pending','approved','connected','expired','denied','revoked')),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    next_poll_at timestamptz not null,
    poll_interval_sec integer not null default 5 check (poll_interval_sec between 5 and 30),
    approved_account_uid uuid,
    approved_session_id uuid,
    approved_at timestamptz,
    previous_owner_uid uuid,
    connected_device_id uuid unique,
    connected_at timestamptz,
    denied_at timestamptz,
    denied_reason text check (denied_reason in ('browser_denied','companion_canceled','approval_session_revoked',
        'account_unavailable','ownership_conflict','reenrollment_conflict','device_id_conflict')),
    revoked_at timestamptz,
    constraint device_pairings_lifetime check (expires_at>created_at and expires_at<=created_at+interval '5 minutes'),
    constraint device_pairings_approval check (
        (approved_account_uid is null and approved_session_id is null and approved_at is null and status not in ('approved','connected','revoked'))
        or (approved_account_uid is not null and approved_session_id is not null and approved_at is not null and status<>'pending')),
    constraint device_pairings_connection check (
        (status in ('connected','revoked') and connected_device_id is not null and connected_at is not null and connected_device_id=proposed_device_id)
        or (status not in ('connected','revoked') and connected_device_id is null and connected_at is null and previous_owner_uid is null)),
    constraint device_pairings_denial check (
        (status='denied' and denied_at is not null and denied_reason is not null)
        or (status<>'denied' and denied_at is null and denied_reason is null)),
    constraint device_pairings_revocation check ((status='revoked')=(revoked_at is not null))
);
create unique index device_pairings_one_live_per_installation on private.device_pairings(installation_id) where status in ('pending','approved');
create unique index device_pairings_one_live_per_initiator on private.device_pairings(initiator_uid) where status in ('pending','approved');

create table private.device_pairing_audit (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    event text not null check (event in ('pairing_started','pairing_approved','pairing_denied','pairing_expired','pairing_connected','pairing_revoked','pairing_retry_deferred')),
    pairing_audit_ref uuid not null references private.device_pairings(audit_ref),
    installation_id text not null,
    account_uid uuid,
    device_id uuid,
    reason text,
    constraint device_pairing_audit_reason check (
        (event='pairing_retry_deferred' and reason is not null and reason in ('account_limit','device_limit'))
        or (event='pairing_denied' and reason is not null and reason in ('browser_denied','companion_canceled','approval_session_revoked',
            'account_unavailable','ownership_conflict','reenrollment_conflict','device_id_conflict'))
        or (event='pairing_revoked' and reason is not null and reason in ('owner_revoked','credential_reuse','replaced'))
        or (event not in ('pairing_retry_deferred','pairing_denied','pairing_revoked') and reason is null))
);
create unique index device_pairing_audit_one_transition on private.device_pairing_audit(pairing_audit_ref,event) where event<>'pairing_retry_deferred';
create unique index device_pairing_audit_one_deferred_reason on private.device_pairing_audit(pairing_audit_ref,event,reason) where event='pairing_retry_deferred';

alter table private.devices add column pairing_id uuid references private.device_pairings(id);
alter table private.devices alter column ticket_id drop not null;
alter table private.devices add constraint devices_exactly_one_provenance
    check ((ticket_id is not null)::integer+(pairing_id is not null)::integer=1) not valid;
alter table private.devices validate constraint devices_exactly_one_provenance;
create unique index devices_one_per_pairing on private.devices(pairing_id) where pairing_id is not null;

alter table private.device_pairing_config enable row level security;
alter table private.device_pairing_config force row level security;
alter table private.device_pairings enable row level security;
alter table private.device_pairings force row level security;
alter table private.device_pairing_audit enable row level security;
alter table private.device_pairing_audit force row level security;
revoke all on table private.device_pairing_config, private.device_pairings, private.device_pairing_audit from public, anon, authenticated, service_role;
revoke all on sequence private.device_pairing_audit_id_seq from public, anon, authenticated, service_role;

-- Static SQL keeps preservation checks visible to the existing account migration conformance tripwire.
create temporary table _fdb0016_after_rows on commit drop as
select 'public.installations'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installations t
union all
select 'private.account_installations'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.account_installations t
union all
select 'private.account_audit'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.account_audit t
union all
select 'private.installation_claims'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.installation_claims t
union all
select 'private.enrollment_tickets'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.enrollment_tickets t
union all
select 'private.devices'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.devices t
union all
select 'private.device_audit'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from private.device_audit t
union all
select 'public.sources'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.sources t
union all
select 'public.items'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.items t
union all
select 'public.installation_item_stats'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_item_stats t
union all
select 'public.installation_source_stats'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_source_stats t
union all
select 'public.installation_location_stats'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_location_stats t
union all
select 'public.installation_guilds'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_guilds t
union all
select 'public.installation_guild_members'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_guild_members t
union all
select 'public.installation_guild_professions'::text table_name, count(*) n,
    md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),'')) hash from public.installation_guild_professions t;

-- Fail the transaction if closure, predecessors, historical rows or the OFF gate changed unexpectedly.
do $verify$
declare r record; v_role text; v_table text; v_after record;
begin
    foreach v_table in array array['private.device_pairing_config','private.device_pairings','private.device_pairing_audit'] loop
        if not (select relrowsecurity and relforcerowsecurity from pg_class where oid=v_table::regclass)
           or exists (select 1 from pg_policy where polrelid=v_table::regclass) then
            raise exception '0016 post-condition: % is not FORCE-RLS/no-policy closed',v_table;
        end if;
        foreach v_role in array array['public','anon','authenticated','service_role'] loop
            if has_table_privilege(v_role,v_table,'select,insert,update,delete,truncate,references,trigger') then
                raise exception '0016 post-condition: % has privileges on %',v_role,v_table;
            end if;
        end loop;
    end loop;
    foreach v_role in array array['public','anon','authenticated','service_role'] loop
        if has_sequence_privilege(v_role,'private.device_pairing_audit_id_seq','usage,select,update') then
            raise exception '0016 post-condition: % has audit sequence privileges',v_role;
        end if;
    end loop;
    if (select count(*) from private.device_pairing_config)<>1
       or not exists (select 1 from private.device_pairing_config where singleton and not enabled) then
        raise exception '0016 post-condition: pairing must remain OFF';
    end if;
    for r in select * from _fdb0016_functions loop
        select md5(pg_get_functiondef(p.oid)) definition,p.proowner,p.proacl::text acl into v_after from pg_proc p where p.oid=r.oid;
        if not found or v_after.definition is distinct from r.definition or v_after.proowner is distinct from r.proowner or v_after.acl is distinct from r.acl then
            raise exception '0016 post-condition: existing function % changed',r.sig;
        end if;
    end loop;
    for r in select * from _fdb0016_claim_schema loop
        select c.relacl::text acl,c.relrowsecurity,c.relforcerowsecurity,
            (select jsonb_agg(jsonb_build_array(a.attname,a.atttypid,a.atttypmod,a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
             from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
             where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) columns,
            (select jsonb_agg(pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid) constraints
        into v_after from pg_class c where c.oid=r.oid;
        if not found or to_jsonb(v_after) is distinct from to_jsonb(r)-'oid' then
            raise exception '0016 post-condition: protected claim schema % changed',r.oid::regclass;
        end if;
    end loop;
    if exists ((select * from _fdb0016_rows except select * from _fdb0016_after_rows)
               union all (select * from _fdb0016_after_rows except select * from _fdb0016_rows)) then
        raise exception '0016 post-condition: historical rows changed';
    end if;
end $verify$;
notify pgrst, 'reload schema';
commit;
