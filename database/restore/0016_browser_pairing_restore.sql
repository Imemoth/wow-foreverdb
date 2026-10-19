-- Browser Pairing V1 forward restore after a ledger-recorded rollback. Never enables the feature.
-- Empty rollback reuses the reviewed migration body. Retained history rebuilds only the removed API surface.
\set retained 0
begin;
set local lock_timeout='10s';
do $preflight$
declare v_schema integer; v_api integer; v_trigger boolean; v_column boolean; v_hash text; v_actual text; v_table regclass;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null
     or not exists(select 1 from supabase_migrations.schema_migrations where name='browser_pairing')
     or not exists(select 1 from supabase_migrations.schema_migrations where name='rollback_browser_pairing')
     or exists(select 1 from supabase_migrations.schema_migrations where name='browser_pairing_restore') then
    raise exception '0016 restore pre-flight: ledger must show browser_pairing then rollback_browser_pairing, without a prior restore';
  end if;
  select count(*) into v_schema from (values (to_regclass('private.device_pairing_config')),(to_regclass('private.device_pairings')),
    (to_regclass('private.device_pairing_audit')),(to_regclass('private.devices_one_per_pairing'))) s(oid) where oid is not null;
  select count(*) into v_api from pg_proc where oid=any(array[to_regprocedure('private.fdb_pair_poll_global_budget()'),
    to_regprocedure('private.fdb_device_pair_native(uuid,text,boolean)'),to_regprocedure('public.fdb_device_pair_start(uuid,text,uuid,text,text,text)'),
    to_regprocedure('public.fdb_device_pair_poll(uuid,text)'),to_regprocedure('public.fdb_device_pair_cancel(uuid,text)'),
    to_regprocedure('public.fdb_account_device_pair_preview(uuid)'),to_regprocedure('public.fdb_account_device_pair_approve(uuid)'),
    to_regprocedure('public.fdb_account_device_pair_deny(uuid)')]::oid[]);
  v_trigger:=to_regprocedure('private.device_pairing_revocation_trigger()') is not null
    and exists(select 1 from pg_trigger where tgrelid='private.devices'::regclass and tgname='devices_propagate_pairing_revocation' and not tgisinternal);
  v_column:=exists(select 1 from pg_attribute where attrelid='private.devices'::regclass and attname='pairing_id' and not attisdropped)
    and exists(select 1 from pg_constraint where conrelid='private.devices'::regclass and conname='devices_exactly_one_provenance' and convalidated);
  if v_api<>0 then raise exception '0016 restore pre-flight: API surface still exists or is mixed'; end if;
  if not ((v_schema=0 and not v_trigger and not v_column) or (v_schema=4 and v_trigger and v_column)) then
    raise exception '0016 restore pre-flight: mixed or incomplete retained schema/trigger state';
  end if;
  if v_schema=4 then
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.device_pairing_config'::regclass)
       or not (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.device_pairings'::regclass)
       or not (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.device_pairing_audit'::regclass)
       or exists(select 1 from pg_policy where polrelid in ('private.device_pairing_config'::regclass,'private.device_pairings'::regclass,'private.device_pairing_audit'::regclass))
       or not exists(select 1 from private.device_pairing_config where singleton and not enabled)
       or exists(select 1 from private.devices d join private.device_pairings p on p.id=d.pairing_id
                 where d.status='revoked' and p.status<>'revoked') then
      raise exception '0016 restore pre-flight: retained schema closure or revoked-device consistency failed';
    end if;
    if md5(pg_get_functiondef('private.device_pairing_revocation_trigger()'::regprocedure))<>'3b61ae3698bebae60d50507fddb44ab4' then
      raise exception '0016 restore pre-flight: revocation trigger function hash mismatch';
    end if;
    for v_table,v_hash in select * from (values
      ('private.device_pairing_config'::regclass,'ff2303be13914b4dff1fef1783a52626'),
      ('private.device_pairings'::regclass,'945f59954e48c3d50c8217ac398e1a26'),
      ('private.device_pairing_audit'::regclass,'40ddc4467f929ccf14492235167f374a'),
      ('private.devices'::regclass,'b6f7906a92f2d1cb0e42b90eaa4ae7e4')) expected(tbl,hash) loop
      select md5(coalesce((select string_agg(pg_get_constraintdef(x.oid),'|' order by x.conname) from pg_constraint x where x.conrelid=v_table),'')||'|'||
        coalesce((select string_agg(indexdef,'|' order by indexname) from pg_indexes where schemaname=split_part(v_table::text,'.',1) and tablename=split_part(v_table::text,'.',2)),'')||'|'||c.relrowsecurity||'|'||c.relforcerowsecurity)
        into v_actual from pg_class c where c.oid=v_table;
      if v_actual is distinct from v_hash then raise exception '0016 restore pre-flight: object hash mismatch for %',v_table; end if;
    end loop;
  end if;
  perform set_config('fdb.browser_pairing_restore',case when v_schema=4 then 'retained' else 'empty' end,false);
end $preflight$;
commit;
select (current_setting('fdb.browser_pairing_restore')='retained')::int retained \gset
\if :retained
begin;
set local lock_timeout='10s';
set local statement_timeout='30s';
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

-- Registered-browser RPCs. Browser identity is derived only from the verified JWT.
-- Their lock order is installation -> global budget -> exact session -> pairing row.
create function public.fdb_account_device_pair_preview(p_pairing_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare
    v_uid uuid; v_sid uuid; v_installation text; v_pair private.device_pairings; v_owner uuid;
    v_session_deadline timestamptz; v_compatible boolean := true;
begin
    if p_pairing_id is null or p_pairing_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        return jsonb_build_object('ok',false,'error','pairing_not_available');
    end if;
    if not exists(select 1 from private.device_pairing_config where singleton and enabled) then
        return jsonb_build_object('ok',false,'error','feature_disabled');
    end if;
    begin v_uid:=private.fdb_registered_caller(); v_sid:=(auth.jwt()->>'session_id')::uuid;
    exception when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','unauthenticated');
              when sqlstate 'PT403' then return jsonb_build_object('ok',false,'error','forbidden'); end;
    perform private.foreverdb_take_budget('pair_preview:uid:'||v_uid::text,300,30);
    select installation_id into v_installation from private.device_pairings where id=p_pairing_id;
    if found then perform pg_advisory_xact_lock(hashtextextended(v_installation,0)); end if;
    perform private.foreverdb_take_budget('pair_preview:global',300,600);
    begin
        perform private.fdb_registered_caller();
        perform private.fdb_lock_live_session(v_uid,v_sid,false);
        select s.not_after into v_session_deadline from auth.sessions s where s.id=v_sid and s.user_id=v_uid
            and (s.not_after is null or s.not_after>clock_timestamp()) for share;
        if not found then raise sqlstate 'PT401'; end if;
        perform 1 from auth.users where id=v_uid for share nowait;
        perform 1 from auth.refresh_tokens where session_id=v_sid and not revoked order by id for share nowait;
        if not found then raise sqlstate 'PT401'; end if;
        perform private.fdb_registered_caller();
    exception when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','unauthenticated');
              when sqlstate 'PT403' then return jsonb_build_object('ok',false,'error','forbidden'); end;
    select * into v_pair from private.device_pairings where id=p_pairing_id for update;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    if not found or v_pair.installation_id is distinct from v_installation then
        return jsonb_build_object('ok',false,'error','pairing_not_available');
    end if;
    perform private.foreverdb_take_budget('pair_preview:pair:'||v_pair.id::text,300,60);
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    if v_pair.status in ('pending','approved') and v_pair.expires_at<=clock_timestamp() then
        update private.device_pairings set status='expired' where id=v_pair.id;
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid)
        values('pairing_expired',v_pair.audit_ref,v_pair.installation_id,v_pair.approved_account_uid);
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        return jsonb_build_object('state','expired');
    end if;
    if v_pair.status in ('connected','expired','denied','revoked') then return jsonb_build_object('state',v_pair.status); end if;
    if v_pair.status not in ('pending','approved') then return jsonb_build_object('ok',false,'error','pairing_not_available'); end if;
    if v_pair.status='approved' and v_pair.approved_account_uid is distinct from v_uid then
        return jsonb_build_object('ok',false,'error','cannot_connect_to_this_account');
    end if;
    select owner_user_id into v_owner from public.installations where id=v_pair.installation_id;
    if found and v_owner is distinct from v_pair.initiator_uid and v_owner is distinct from v_uid then v_compatible:=false; end if;
    if not v_compatible then return jsonb_build_object('ok',false,'error','cannot_connect_to_this_account'); end if;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    return jsonb_build_object('state',v_pair.status,'computerName',v_pair.computer_label,
        'installationSuffix','…'||right(v_pair.installation_id,6),
        'requestedAt',to_char(v_pair.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'expiresAt',to_char(v_pair.expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'canApprove',v_pair.status='pending');
exception
    when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','unauthenticated');
    when sqlstate 'PT429' then return jsonb_build_object('ok',false,'error','rate_limited');
    when others then return jsonb_build_object('ok',false,'error','temporarily_unavailable');
end;
$$;

create function public.fdb_account_device_pair_approve(p_pairing_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare
    v_uid uuid; v_sid uuid; v_installation text; v_pair private.device_pairings; v_owner uuid;
    v_session_deadline timestamptz;
begin
    if p_pairing_id is null or p_pairing_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        return jsonb_build_object('ok',false,'error','already_decided');
    end if;
    if not exists(select 1 from private.device_pairing_config where singleton and enabled) then
        return jsonb_build_object('ok',false,'error','feature_disabled');
    end if;
    begin v_uid:=private.fdb_registered_caller(); v_sid:=(auth.jwt()->>'session_id')::uuid;
    exception when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','unauthenticated');
              when sqlstate 'PT403' then return jsonb_build_object('ok',false,'error','forbidden'); end;
    perform private.foreverdb_take_budget('pair_decide:uid:'||v_uid::text,300,10);
    select installation_id into v_installation from private.device_pairings where id=p_pairing_id;
    if found then perform pg_advisory_xact_lock(hashtextextended(v_installation,0)); end if;
    perform private.foreverdb_take_budget('pair_decide:global',300,120);
    begin
        perform private.fdb_registered_caller(); perform private.fdb_lock_live_session(v_uid,v_sid,false);
        select s.not_after into v_session_deadline from auth.sessions s where s.id=v_sid and s.user_id=v_uid
            and (s.not_after is null or s.not_after>clock_timestamp()) for share;
        if not found then raise sqlstate 'PT401'; end if;
        perform 1 from auth.users where id=v_uid for share nowait;
        perform 1 from auth.refresh_tokens where session_id=v_sid and not revoked order by id for share nowait;
        if not found then raise sqlstate 'PT401'; end if;
        perform private.fdb_registered_caller();
    exception when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','unauthenticated');
              when sqlstate 'PT403' then return jsonb_build_object('ok',false,'error','forbidden'); end;
    select * into v_pair from private.device_pairings where id=p_pairing_id for update;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    if not found or v_pair.installation_id is distinct from v_installation then return jsonb_build_object('ok',false,'error','already_decided'); end if;
    perform private.foreverdb_take_budget('pair_decide:pair:'||v_pair.id::text,300,5);
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    if v_pair.status in ('pending','approved') and v_pair.expires_at<=clock_timestamp() then
        update private.device_pairings set status='expired' where id=v_pair.id;
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid)
        values('pairing_expired',v_pair.audit_ref,v_pair.installation_id,v_pair.approved_account_uid);
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        return jsonb_build_object('ok',false,'error','expired');
    end if;
    if v_pair.status<>'pending' then return jsonb_build_object('ok',false,'error','already_decided'); end if;
    select owner_user_id into v_owner from public.installations where id=v_pair.installation_id;
    if found and v_owner is distinct from v_pair.initiator_uid and v_owner is distinct from v_uid then
        return jsonb_build_object('ok',false,'error','cannot_connect_to_this_account');
    end if;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    update private.device_pairings set status='approved',approved_account_uid=v_uid,approved_session_id=v_sid,
        approved_at=clock_timestamp() where id=v_pair.id;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid)
    values('pairing_approved',v_pair.audit_ref,v_pair.installation_id,v_uid);
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    return jsonb_build_object('ok',true,'state','approved');
exception
    when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','unauthenticated');
    when sqlstate 'PT429' then return jsonb_build_object('ok',false,'error','rate_limited');
    when others then return jsonb_build_object('ok',false,'error','temporarily_unavailable');
end;
$$;

create function public.fdb_account_device_pair_deny(p_pairing_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
set lock_timeout = '5s' set statement_timeout = '15s'
as $$
declare
    v_uid uuid; v_sid uuid; v_installation text; v_pair private.device_pairings;
    v_session_deadline timestamptz;
begin
    if p_pairing_id is null or p_pairing_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        return jsonb_build_object('ok',false,'error','already_decided');
    end if;
    if not exists(select 1 from private.device_pairing_config where singleton and enabled) then
        return jsonb_build_object('ok',false,'error','feature_disabled');
    end if;
    begin v_uid:=private.fdb_registered_caller(); v_sid:=(auth.jwt()->>'session_id')::uuid;
    exception when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','unauthenticated');
              when sqlstate 'PT403' then return jsonb_build_object('ok',false,'error','forbidden'); end;
    perform private.foreverdb_take_budget('pair_decide:uid:'||v_uid::text,300,10);
    select installation_id into v_installation from private.device_pairings where id=p_pairing_id;
    if found then perform pg_advisory_xact_lock(hashtextextended(v_installation,0)); end if;
    perform private.foreverdb_take_budget('pair_decide:global',300,120);
    begin
        perform private.fdb_registered_caller(); perform private.fdb_lock_live_session(v_uid,v_sid,false);
        select s.not_after into v_session_deadline from auth.sessions s where s.id=v_sid and s.user_id=v_uid
            and (s.not_after is null or s.not_after>clock_timestamp()) for share;
        if not found then raise sqlstate 'PT401'; end if;
        perform 1 from auth.users where id=v_uid for share nowait;
        perform 1 from auth.refresh_tokens where session_id=v_sid and not revoked order by id for share nowait;
        if not found then raise sqlstate 'PT401'; end if;
        perform private.fdb_registered_caller();
    exception when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','unauthenticated');
              when sqlstate 'PT403' then return jsonb_build_object('ok',false,'error','forbidden'); end;
    select * into v_pair from private.device_pairings where id=p_pairing_id for update;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    if not found or v_pair.installation_id is distinct from v_installation then return jsonb_build_object('ok',false,'error','already_decided'); end if;
    perform private.foreverdb_take_budget('pair_decide:pair:'||v_pair.id::text,300,5);
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    if v_pair.status in ('pending','approved') and v_pair.expires_at<=clock_timestamp() then
        update private.device_pairings set status='expired' where id=v_pair.id;
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid)
        values('pairing_expired',v_pair.audit_ref,v_pair.installation_id,v_pair.approved_account_uid);
        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
        return jsonb_build_object('ok',false,'error','expired');
    end if;
    if v_pair.status='approved' and v_pair.approved_account_uid is distinct from v_uid then
        return jsonb_build_object('ok',false,'error','already_decided');
    end if;
    if v_pair.status not in ('pending','approved') then return jsonb_build_object('ok',false,'error','already_decided'); end if;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    update private.device_pairings set status='denied',denied_at=clock_timestamp(),denied_reason='browser_denied' where id=v_pair.id;
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid,reason)
    values('pairing_denied',v_pair.audit_ref,v_pair.installation_id,v_uid,'browser_denied');
    if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;
    return jsonb_build_object('ok',true,'state','denied');
exception
    when sqlstate 'PT401' then return jsonb_build_object('ok',false,'error','unauthenticated');
    when sqlstate 'PT429' then return jsonb_build_object('ok',false,'error','rate_limited');
    when others then return jsonb_build_object('ok',false,'error','temporarily_unavailable');
end;
$$;


revoke all on function private.fdb_pair_poll_global_budget(),private.fdb_device_pair_native(uuid,text,boolean),
    public.fdb_device_pair_start(uuid,text,uuid,text,text,text),public.fdb_device_pair_poll(uuid,text),public.fdb_device_pair_cancel(uuid,text),
    public.fdb_account_device_pair_preview(uuid),public.fdb_account_device_pair_approve(uuid),public.fdb_account_device_pair_deny(uuid)
    from public,anon,authenticated,service_role;
grant execute on function public.fdb_device_pair_start(uuid,text,uuid,text,text,text),public.fdb_device_pair_poll(uuid,text),public.fdb_device_pair_cancel(uuid,text),
    public.fdb_account_device_pair_preview(uuid),public.fdb_account_device_pair_approve(uuid),public.fdb_account_device_pair_deny(uuid) to authenticated;
update private.device_pairing_config set enabled=false where singleton;
do $verify$
declare v_sig text; v_role text; v_hash text; v_actual text;
begin
  if exists(select 1 from private.devices d join private.device_pairings p on p.id=d.pairing_id where d.status='revoked' and p.status<>'revoked') then
    raise exception '0016 restore post-condition: revoked provenance device has a non-revoked pairing';
  end if;
  foreach v_sig in array array['public.fdb_device_pair_start(uuid,text,uuid,text,text,text)','public.fdb_device_pair_poll(uuid,text)',
    'public.fdb_device_pair_cancel(uuid,text)','public.fdb_account_device_pair_preview(uuid)','public.fdb_account_device_pair_approve(uuid)',
    'public.fdb_account_device_pair_deny(uuid)'] loop
    if not has_function_privilege('authenticated',v_sig,'execute') then raise exception '0016 restore post-condition: authenticated lacks %',v_sig; end if;
    foreach v_role in array array['public','anon','service_role'] loop
      if has_function_privilege(v_role,v_sig,'execute') then raise exception '0016 restore post-condition: % can execute %',v_role,v_sig; end if;
    end loop;
  end loop;
  for v_sig,v_hash in select * from (values
    ('private.fdb_pair_poll_global_budget()','3935a3f5cb1a54dc67428579ad6a9763'),
    ('private.fdb_device_pair_native(uuid,text,boolean)','4a815759c8213f55a41db8116ed76e8e'),
    ('public.fdb_device_pair_start(uuid,text,uuid,text,text,text)','bb21a8c21b7fcc4c633d1bdef3b0fefc'),
    ('public.fdb_device_pair_poll(uuid,text)','f55845835ebf3caef94cb1c2fe815ac1'),('public.fdb_device_pair_cancel(uuid,text)','a38d2346be589791ffdeeca8e4a3daa8'),
    ('public.fdb_account_device_pair_preview(uuid)','638c37eb34e3956d2f7736f5e6a3258c'),('public.fdb_account_device_pair_approve(uuid)','b7b8a854247cc7e9ef2e3d537f27ad9c'),
    ('public.fdb_account_device_pair_deny(uuid)','12568dcbc0e61fa72a3639887e1969a3')) expected(sig,hash) loop
    select md5(pg_get_functiondef(v_sig::regprocedure)) into v_actual;
    if v_actual is distinct from v_hash then raise exception '0016 restore post-condition: function hash mismatch for %',v_sig; end if;
  end loop;
  if not exists(select 1 from private.device_pairing_config where singleton and not enabled) then raise exception '0016 restore post-condition: pairing gate is not OFF'; end if;
end $verify$;
notify pgrst,'reload schema';
commit;
\else
\ir ../migrations/0016_browser_pairing.sql
\endif
select set_config('fdb.browser_pairing_restore','',false) \g /dev/null
