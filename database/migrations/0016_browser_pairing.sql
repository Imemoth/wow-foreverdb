-- ForeverDB 0016: Browser Pairing V1. Native pairing; all release gates remain OFF.
-- Requires 0012 + 0014, independently of PR #58's 0015 azerdex_welcome_outbox.
-- Migration application performs no ownership/history write, ledger entry or feature enablement.
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
    v_index text;
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
       or not exists (select 1 from pg_constraint where conrelid='private.account_audit'::regclass and conname='account_audit_event_check' and convalidated) then
        raise exception '0016 pre-flight: 0012/0014 provenance or live-device constraints missing';
    end if;
    -- A matching name cannot stand in for the 0014 uniqueness/serialization invariant.
    for v_index, v_col in select * from (values
        ('devices_one_live_per_installation','installation_id'),
        ('devices_one_live_per_identity','auth_uid')
    ) as expected(index_name,column_name) loop
        if not exists (
            select 1 from pg_index i
            join pg_class idx on idx.oid=i.indexrelid
            join pg_namespace ns on ns.oid=idx.relnamespace
            join pg_attribute a on a.attrelid=i.indrelid and a.attname=v_col and not a.attisdropped
            where ns.nspname='private' and idx.relname=v_index and idx.relkind='i'
              and i.indrelid='private.devices'::regclass
              and i.indisunique and i.indisvalid and i.indisready and i.indislive
              and i.indnkeyatts=1 and i.indnatts=1 and i.indkey[0]=a.attnum
              and i.indexprs is null
              and pg_get_expr(i.indpred,i.indrelid)='(status <> ''revoked''::text)'
        ) then
            raise exception '0016 pre-flight: live-device index % has an unexpected definition',v_index;
        end if;
    end loop;
    if not exists (select 1 from pg_roles where rolname=current_user and (rolbypassrls or rolsuper))
       or not has_table_privilege(current_user,'auth.sessions','SELECT')
       or not has_table_privilege(current_user,'auth.sessions','UPDATE')
       or not has_table_privilege(current_user,'auth.users','SELECT')
       or not has_table_privilege(current_user,'auth.users','UPDATE')
       or not has_table_privilege(current_user,'auth.refresh_tokens','SELECT')
       or not has_table_privilege(current_user,'auth.refresh_tokens','UPDATE')
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

-- Native pairing RPCs. Only the authenticated API role can invoke the fixed public surface.
-- Private helpers share the same installation -> abuse -> session -> pairing -> account -> identity lock order.
create function private.fdb_pair_poll_global_budget()
returns void language plpgsql security definer set search_path = ''
set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare v_window timestamptz := to_timestamp(floor(extract(epoch from clock_timestamp())/300)*300);
begin
    -- The predecessor helper intentionally accepts at most 1000; do not change its contract.
    insert into private.foreverdb_api_budgets as b(bucket,window_started,calls)
    values ('pair_poll:global',v_window,1)
    on conflict (bucket) do update set window_started=excluded.window_started,
        calls=case when b.window_started=excluded.window_started then b.calls+1 else 1 end
    where b.window_started<>excluded.window_started or b.calls<3000;
    if not found then raise sqlstate 'PT429' using message='Pairing budget exhausted'; end if;
end;
$$;

create function public.fdb_device_pair_start(p_pairing_id uuid, p_poll_secret_hash text, p_device_id uuid,
    p_device_credential_hash text, p_installation_id text, p_computer_name text)
returns jsonb language plpgsql security definer set search_path = ''
set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare
    v_uid uuid; v_sid uuid; v_pair private.device_pairings; v_owner uuid; v_prev private.devices;
    v_old private.device_pairings; v_installation_budget boolean := false;
    v_now timestamptz; v_session_deadline timestamptz; v_label text := nullif(p_computer_name,'');
begin
    if p_pairing_id is null or p_pairing_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or p_device_id is null or p_device_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or p_poll_secret_hash is null or p_poll_secret_hash !~ '^[0-9a-f]{64}$'
       or p_device_credential_hash is null or p_device_credential_hash !~ '^[0-9a-f]{64}$'
       or p_installation_id is null or length(p_installation_id) not between 16 and 128
       or p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
       or (p_computer_name is not null and (length(p_computer_name)>60 or p_computer_name~'[[:cntrl:]]'
           or p_computer_name~U&'[\007f-\009f]'
           or p_computer_name<>btrim(p_computer_name,U&'\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff'))) then
        return jsonb_build_object('ok',false,'error','invalid_request');
    end if;
    if not exists(select 1 from private.device_pairing_config where singleton and enabled) then
        return jsonb_build_object('ok',false,'error','feature_disabled');
    end if;
    begin
        v_uid := private.fdb_anonymous_caller(); v_sid := (auth.jwt()->>'session_id')::uuid;
    exception when sqlstate 'PT401' or sqlstate 'PT403' then
        return jsonb_build_object('ok',false,'error','session_not_accepted');
    end;
    perform private.foreverdb_take_budget('pair_start:uid:'||v_uid::text,300,5);
    perform pg_advisory_xact_lock(hashtextextended(p_installation_id,0));
    perform pg_advisory_xact_lock(hashtextextended('fdb-pairing:'||p_pairing_id::text,0));
    perform private.foreverdb_take_budget('pair_start:global',300,120);
    -- A caller checked before waiting is not authoritative. Recheck and pin the exact session.
    begin
        perform private.fdb_anonymous_caller();
        perform private.fdb_lock_live_session(v_uid,v_sid,true);
        select s.not_after into v_session_deadline from auth.sessions s where s.id=v_sid and s.user_id=v_uid
          and (s.not_after is null or s.not_after>clock_timestamp()) for share;
        if not found then raise sqlstate 'PT401'; end if;
        -- Pin identity and a live refresh family through commit, not merely at the last read.
        -- GoTrue can lock token/user rows before sessions. NOWAIT avoids reversing its lock order:
        -- a concurrent Auth writer wins and the outer exception handler rolls this attempt back.
        perform 1 from auth.users where id=v_uid for share nowait;
        perform 1 from auth.refresh_tokens where session_id=v_sid and not revoked order by id for share nowait;
        if not found then raise sqlstate 'PT401'; end if;
        perform private.fdb_anonymous_caller();
    exception when sqlstate 'PT401' or sqlstate 'PT403' then
        return jsonb_build_object('ok',false,'error','session_not_accepted');
    end;
    select * into v_pair from private.device_pairings where id=p_pairing_id for update;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    if found then
        if v_pair.initiator_uid is distinct from v_uid or v_pair.initiator_session_id is distinct from v_sid
           or v_pair.installation_id is distinct from p_installation_id or v_pair.proposed_device_id is distinct from p_device_id
           or v_pair.poll_secret_hash is distinct from decode(p_poll_secret_hash,'hex')
           or v_pair.device_credential_hash is distinct from decode(p_device_credential_hash,'hex')
           or v_pair.computer_label is distinct from v_label then
            return jsonb_build_object('ok',false,'error','pairing_conflict');
        end if;
        if v_pair.status in ('pending','approved') and v_pair.expires_at<=clock_timestamp() then
            perform private.foreverdb_take_budget('pair_start:installation:'||encode(extensions.digest(p_installation_id,'sha256'),'hex'),300,3);
            if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
            update private.device_pairings set status='expired' where id=v_pair.id;
            if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
            insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid)
            values('pairing_expired',v_pair.audit_ref,p_installation_id,v_pair.approved_account_uid);
            if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
            return jsonb_build_object('ok',false,'error','pairing_conflict');
        end if;
        if v_pair.status<>'pending' then return jsonb_build_object('ok',false,'error','pairing_conflict'); end if;
        perform private.foreverdb_take_budget('pair_start:installation:'||encode(extensions.digest(p_installation_id,'sha256'),'hex'),300,3);
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        return jsonb_build_object('ok',true,'state',v_pair.status,'pairingId',v_pair.id,
            'expiresAt',to_char(v_pair.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'intervalSeconds',v_pair.poll_interval_sec);
    end if;
    -- Recover local proof loss only for this exact actor/session and installation. No foreign-row cleanup.
    select * into v_old from private.device_pairings where installation_id=p_installation_id
        and initiator_uid=v_uid and initiator_session_id=v_sid and status in ('pending','approved') for update;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    if found and v_old.expires_at<=clock_timestamp() then
        perform private.foreverdb_take_budget('pair_start:installation:'||encode(extensions.digest(p_installation_id,'sha256'),'hex'),300,3);
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        v_installation_budget := true;
        update private.device_pairings set status='expired' where id=v_old.id;
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid)
        values('pairing_expired',v_old.audit_ref,p_installation_id,v_old.approved_account_uid);
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    end if;
    if exists(select 1 from private.device_pairings where status in ('pending','approved')
        and (installation_id=p_installation_id or initiator_uid=v_uid)) then
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        return jsonb_build_object('ok',false,'error','pairing_pending');
    end if;
    -- Start has no account lock; its installation lock stabilizes the predecessor check.
    select owner_user_id into v_owner from public.installations where id=p_installation_id;
    if exists(select 1 from private.devices where installation_id=p_installation_id and status<>'revoked') then
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        return jsonb_build_object('ok',false,'error','device_bound');
    end if;
    if found and v_owner is distinct from v_uid then
        select * into v_prev from private.devices where installation_id=p_installation_id order by created_at desc,id desc limit 1;
        if v_prev.id is null or v_prev.account_uid is distinct from v_owner or v_prev.auth_uid is distinct from v_uid
           or v_prev.status<>'revoked' or v_prev.revoked_reason not in ('owner_revoked','credential_reuse','replaced')
           or not private.fdb_account_usable(v_owner) then
            if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
            return jsonb_build_object('ok',false,'error','installation_conflict');
        end if;
    end if;
    if not v_installation_budget then
        perform private.foreverdb_take_budget('pair_start:installation:'||encode(extensions.digest(p_installation_id,'sha256'),'hex'),300,3);
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    end if;
    -- Only a proved installation binding can spend its bucket. Row locks follow that budget class.
    perform pg_advisory_xact_lock(hashtextextended('fdb-device-identity:'||v_uid::text,0));
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    select owner_user_id into v_owner from public.installations where id=p_installation_id for update;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    perform 1 from private.devices where installation_id=p_installation_id or auth_uid=v_uid order by id for update;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    -- All compliant owner/predecessor writes take the installation lock already held above.
    -- Every protected write is followed by a deadline check: the statement itself can wait.
    -- The identity lock also serializes a concurrent enrollment for this UID at another installation.
    v_now := clock_timestamp();
    if v_session_deadline<=v_now then raise sqlstate 'PT401'; end if;
    insert into private.device_pairings(id,installation_id,initiator_uid,initiator_session_id,poll_secret_hash,
        proposed_device_id,device_credential_hash,computer_label,status,created_at,expires_at,next_poll_at)
    values(p_pairing_id,p_installation_id,v_uid,v_sid,decode(p_poll_secret_hash,'hex'),p_device_id,
        decode(p_device_credential_hash,'hex'),v_label,'pending',v_now,v_now+interval '5 minutes',v_now+interval '5 seconds') returning * into v_pair;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id)
    values('pairing_started',v_pair.audit_ref,p_installation_id);
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    return jsonb_build_object('ok',true,'state','pending','pairingId',v_pair.id,
        'expiresAt',to_char(v_pair.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'intervalSeconds',5);
exception
    -- Late expiry must undo earlier installation budgets or expired-request cleanup, too.
    when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','session_not_accepted');
    when sqlstate 'PT429' then return jsonb_build_object('ok',false,'error','rate_limited');
    when unique_violation then return jsonb_build_object('ok',false,'error','pairing_conflict');
    when others then return jsonb_build_object('ok',false,'error','temporarily_unavailable');
end;
$$;

create function private.fdb_device_pair_native(p_pairing_id uuid,p_poll_secret text,p_cancel boolean)
returns jsonb language plpgsql security definer set search_path = ''
set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare
    v_uid uuid; v_sid uuid; v_installation text; v_pair private.device_pairings; v_prev private.devices;
    v_owner uuid; v_exists boolean; v_reason text; v_limit text; v_now timestamptz; v_interval integer;
    v_session_deadline timestamptz; v_approval_deadline timestamptz;
    v_op text := case when p_cancel then 'cancel' else 'poll' end;
begin
    if p_pairing_id is null or p_pairing_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or p_poll_secret is null or p_poll_secret !~ '^fdbp1_[A-Za-z0-9_-]{43}$' then
        return jsonb_build_object('ok',false,'error','invalid_request');
    end if;
    if not exists(select 1 from private.device_pairing_config where singleton and enabled) then
        return jsonb_build_object('ok',false,'error','feature_disabled');
    end if;
    begin
        v_uid := private.fdb_anonymous_caller(); v_sid := (auth.jwt()->>'session_id')::uuid;
    exception when sqlstate 'PT401' or sqlstate 'PT403' then
        return jsonb_build_object('ok',false,'error','pairing_not_available');
    end;
    perform private.foreverdb_take_budget('pair_'||v_op||':uid:'||v_uid::text,300,case when p_cancel then 10 else 90 end);
    select installation_id into v_installation from private.device_pairings where id=p_pairing_id;
    if found then perform pg_advisory_xact_lock(hashtextextended(v_installation,0)); end if;
    if p_cancel then perform private.foreverdb_take_budget('pair_cancel:global',300,120);
    else perform private.fdb_pair_poll_global_budget(); end if;
    begin
        perform private.fdb_anonymous_caller();
        perform private.fdb_lock_live_session(v_uid,v_sid,true);
        select s.not_after into v_session_deadline from auth.sessions s where s.id=v_sid and s.user_id=v_uid
          and (s.not_after is null or s.not_after>clock_timestamp()) for share;
        if not found then raise sqlstate 'PT401'; end if;
        -- Same authority boundary as start: normal refresh/upgrade proceeds after commit,
        -- or an Auth writer already holding these rows makes this attempt retryable.
        perform 1 from auth.users where id=v_uid for share nowait;
        perform 1 from auth.refresh_tokens where session_id=v_sid and not revoked order by id for share nowait;
        if not found then raise sqlstate 'PT401'; end if;
        perform private.fdb_anonymous_caller();
    exception when sqlstate 'PT401' or sqlstate 'PT403' then
        return jsonb_build_object('ok',false,'error','pairing_not_available');
    end;
    select * into v_pair from private.device_pairings where id=p_pairing_id for update;
    -- Row locks prevent Auth updates, not the passage of the locked session's wall-clock deadline.
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    if not found or v_pair.installation_id is distinct from v_installation
       or v_pair.initiator_uid is distinct from v_uid or v_pair.initiator_session_id is distinct from v_sid
       or v_pair.poll_secret_hash is distinct from extensions.digest(p_poll_secret,'sha256') then
        return jsonb_build_object('ok',false,'error','pairing_not_available');
    end if;
    -- Terminal replay must not touch pairing, pair budgets, schedule, ownership, device or audit.
    if v_pair.status='connected' then return jsonb_build_object('ok',true,'state','connected','deviceId',v_pair.connected_device_id); end if;
    if v_pair.status in ('denied','expired','revoked') then return jsonb_build_object('ok',true,'state',v_pair.status); end if;
    if v_pair.expires_at<=clock_timestamp() then
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        update private.device_pairings set status='expired' where id=v_pair.id;
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid)
        values('pairing_expired',v_pair.audit_ref,v_installation,v_pair.approved_account_uid);
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        return jsonb_build_object('ok',true,'state','expired');
    end if;
    if p_cancel then
        perform private.foreverdb_take_budget('pair_cancel:pair:'||v_pair.id::text,300,5);
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        v_reason := 'companion_canceled';
    else
        if v_pair.next_poll_at>clock_timestamp() then
            v_interval := least(30,v_pair.poll_interval_sec+5);
            if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
            update private.device_pairings set poll_interval_sec=v_interval,next_poll_at=clock_timestamp()+make_interval(secs=>v_interval) where id=v_pair.id;
            if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
            return jsonb_build_object('ok',false,'error','slow_down','intervalSeconds',v_interval);
        end if;
        if v_pair.status='pending' then
            if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
            update private.device_pairings set next_poll_at=clock_timestamp()+make_interval(secs=>v_pair.poll_interval_sec) where id=v_pair.id;
            if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
            return jsonb_build_object('ok',true,'state','pending','intervalSeconds',v_pair.poll_interval_sec,
                'expiresAt',to_char(v_pair.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
        end if;
        -- Keep the pairing proof lock outside this rollback scope. A late approval deadline can undo
        -- redemption writes before the common fixed denial transition; caller expiry still aborts the whole RPC.
        begin
            -- Session -> account -> device identity -> installation and device rows. Never reorder.
            select s.not_after into v_approval_deadline from auth.sessions s where s.id=v_pair.approved_session_id and s.user_id=v_pair.approved_account_uid
              and (s.not_after is null or s.not_after>clock_timestamp())
              and exists(select 1 from auth.refresh_tokens r where r.session_id=s.id and not r.revoked) for share;
            if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
            if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
            if not found then v_reason := 'approval_session_revoked';
            else
                perform 1 from auth.refresh_tokens where session_id=v_pair.approved_session_id and not revoked order by id for share nowait;
                if not found then v_reason := 'approval_session_revoked'; end if;
                perform pg_advisory_xact_lock(hashtextextended('fdb-account:'||v_pair.approved_account_uid::text,0));
                if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                perform 1 from auth.users u where u.id=v_pair.approved_account_uid for share nowait;
                if not private.fdb_account_usable(v_pair.approved_account_uid) then v_reason := 'account_unavailable'; end if;
            end if;
            -- Even a locked session has a wall-clock deadline; account/identity waits must not extend it.
            begin
                perform private.fdb_anonymous_caller();
            exception when sqlstate 'PT401' or sqlstate 'PT403' then
                return jsonb_build_object('ok',false,'error','pairing_not_available');
            end;
            if not exists(select 1 from auth.sessions s where s.id=v_sid and s.user_id=v_uid
                and (s.not_after is null or s.not_after>clock_timestamp())) then
                return jsonb_build_object('ok',false,'error','pairing_not_available');
            end if;
            if v_reason is null then
                perform pg_advisory_xact_lock(hashtextextended('fdb-device-identity:'||v_uid::text,0));
                if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                select owner_user_id into v_owner from public.installations where id=v_installation for update;
                v_exists := found;
                if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                -- Lock all relevant identities in stable order, including collision and predecessor candidates.
                perform 1 from private.devices where installation_id=v_installation or auth_uid=v_uid or id=v_pair.proposed_device_id order by id for update;
                if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                begin
                    perform private.fdb_anonymous_caller();
                exception when sqlstate 'PT401' or sqlstate 'PT403' then
                    return jsonb_build_object('ok',false,'error','pairing_not_available');
                end;
                if not exists(select 1 from auth.sessions s where s.id=v_sid and s.user_id=v_uid
                    and (s.not_after is null or s.not_after>clock_timestamp())) then
                    return jsonb_build_object('ok',false,'error','pairing_not_available');
                end if;
                if v_pair.expires_at<=clock_timestamp() then
                    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                    if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                    update private.device_pairings set status='expired' where id=v_pair.id;
                    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                    if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                    insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid)
                    values('pairing_expired',v_pair.audit_ref,v_installation,v_pair.approved_account_uid);
                    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                    if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                    return jsonb_build_object('ok',true,'state','expired');
                end if;
                if not exists(select 1 from auth.sessions s where s.id=v_pair.approved_session_id and s.user_id=v_pair.approved_account_uid
                    and (s.not_after is null or s.not_after>clock_timestamp())
                    and exists(select 1 from auth.refresh_tokens r where r.session_id=s.id and not r.revoked)) then v_reason := 'approval_session_revoked';
                elsif exists(select 1 from private.devices where id=v_pair.proposed_device_id) then v_reason := 'device_id_conflict';
                elsif v_exists and v_owner is distinct from v_uid and v_owner is distinct from v_pair.approved_account_uid then v_reason := 'ownership_conflict';
                elsif v_exists and v_owner=v_pair.approved_account_uid then
                    select * into v_prev from private.devices where installation_id=v_installation order by created_at desc,id desc limit 1;
                    if v_prev.id is null or v_prev.auth_uid is distinct from v_uid or v_prev.account_uid is distinct from v_owner
                       or v_prev.status<>'revoked' or v_prev.revoked_reason not in ('owner_revoked','credential_reuse','replaced')
                       or exists(select 1 from private.devices where installation_id=v_installation and status<>'revoked') then
                        v_reason := 'reenrollment_conflict';
                    end if;
                end if;
                if v_reason is null and exists(select 1 from private.devices where (installation_id=v_installation or auth_uid=v_uid) and status<>'revoked') then
                    v_reason := 'reenrollment_conflict';
                end if;
                if v_reason is null then
                    if (not v_exists or v_owner is distinct from v_pair.approved_account_uid)
                       and (select count(*) from public.installations where owner_user_id=v_pair.approved_account_uid)>=50 then v_limit := 'account_limit';
                    elsif (select count(*) from private.devices where account_uid=v_pair.approved_account_uid and status<>'revoked')>=10 then v_limit := 'device_limit'; end if;
                    if v_limit is not null then
                        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                        if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                        update private.device_pairings set next_poll_at=clock_timestamp()+make_interval(secs=>v_pair.poll_interval_sec) where id=v_pair.id;
                        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                        if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                        insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid,reason)
                        values('pairing_retry_deferred',v_pair.audit_ref,v_installation,v_pair.approved_account_uid,v_limit) on conflict do nothing;
                        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                        if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                        return jsonb_build_object('ok',false,'error',v_limit);
                    end if;
                    if not v_exists then
                        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                        if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                        insert into public.installations(id,owner_user_id,schema_version,addon_version,first_seen_at,last_seen_at)
                        values(v_installation,v_pair.approved_account_uid,0,'enrolled',now(),now());
                        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                        if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                    elsif v_owner=v_uid then
                        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                        if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                        update public.installations set owner_user_id=v_pair.approved_account_uid where id=v_installation;
                        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                        if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                    end if;
                    v_now := clock_timestamp();
                    if v_session_deadline<=v_now then raise sqlstate 'PT401'; end if;
                    if v_approval_deadline<=v_now then raise sqlstate 'PT410'; end if;
                    insert into private.devices(id,account_uid,installation_id,auth_uid,label,status,pairing_id,credential_hash,credential_issued_at,last_seen_at)
                    values(v_pair.proposed_device_id,v_pair.approved_account_uid,v_installation,v_uid,v_pair.computer_label,'active',v_pair.id,v_pair.device_credential_hash,v_now,v_now);
                    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                    if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                    update private.device_pairings set status='connected',connected_device_id=v_pair.proposed_device_id,connected_at=v_now,
                        previous_owner_uid=case when v_exists and v_owner=v_uid then v_uid else null end where id=v_pair.id;
                    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                    if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                    insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid,device_id)
                    values('pairing_connected',v_pair.audit_ref,v_installation,v_pair.approved_account_uid,v_pair.proposed_device_id);
                    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
                    if v_approval_deadline<=clock_timestamp() then raise sqlstate 'PT410'; end if;
                    return jsonb_build_object('ok',true,'state','connected','deviceId',v_pair.proposed_device_id);
                end if;
            end if;
        exception when sqlstate 'PT410' then
            v_reason := 'approval_session_revoked';
        end;
    end if;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    update private.device_pairings set status='denied',denied_at=clock_timestamp(),denied_reason=v_reason where id=v_pair.id;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid,reason)
    values('pairing_denied',v_pair.audit_ref,v_installation,v_pair.approved_account_uid,v_reason);
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    return jsonb_build_object('ok',true,'state','denied');
exception
    -- The exception block rolls back ALL effects, including owner/provenance and budget/schedule updates.
    when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','pairing_not_available');
    when sqlstate 'PT429' then return jsonb_build_object('ok',false,'error','rate_limited');
    when others then return jsonb_build_object('ok',false,'error','temporarily_unavailable');
end;
$$;
create function public.fdb_device_pair_poll(p_pairing_id uuid,p_poll_secret text)
returns jsonb language sql security definer set search_path = ''
set lock_timeout = '5s' set statement_timeout = '15s'
as $$ select private.fdb_device_pair_native(p_pairing_id,p_poll_secret,false); $$;
create function public.fdb_device_pair_cancel(p_pairing_id uuid,p_poll_secret text)
returns jsonb language sql security definer set search_path = ''
set lock_timeout = '5s' set statement_timeout = '15s'
as $$ select private.fdb_device_pair_native(p_pairing_id,p_poll_secret,true); $$;
revoke all on function private.fdb_pair_poll_global_budget(),private.fdb_device_pair_native(uuid,text,boolean),
    public.fdb_device_pair_start(uuid,text,uuid,text,text,text),public.fdb_device_pair_poll(uuid,text),public.fdb_device_pair_cancel(uuid,text)
    from public,anon,authenticated,service_role;
grant execute on function public.fdb_device_pair_start(uuid,text,uuid,text,text,text),public.fdb_device_pair_poll(uuid,text),public.fdb_device_pair_cancel(uuid,text) to authenticated;

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
