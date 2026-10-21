-- ForeverDB 0017: allow one independently revocable collector identity to serve multiple installations.
--
-- The anonymous Auth identity remains the device session. Each installation still has its own private.devices row,
-- credential, owner check and ingest scope; this migration only removes the obsolete one-installation-per-device-session
-- restriction. Existing device rows, installation owners and observations are retained.

begin;

do $preflight$
begin
    if to_regprocedure('public.fdb_device_enroll(text,text,text)') is null
       or to_regclass('private.devices') is null
       or to_regclass('public.installations') is null then
        raise exception '0017 pre-flight: zero-touch enrollment objects are missing';
    end if;
end $preflight$;

-- The installation partial unique index remains authoritative. A device session may now have one live credential per
-- installation, while each installation may still have only one live device credential.
drop index if exists private.devices_one_live_per_identity;

create or replace function public.fdb_device_enroll(p_ticket text, p_installation_id text, p_label text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_d uuid;
    v_sid uuid;
    v_label text;
    v_hash bytea;
    v_ticket_id uuid;
    v_account uuid;
    v_status text;
    v_expires timestamptz;
    v_owner uuid;
    v_found boolean;
    v_dev record;
    v_live integer;
    v_owned integer;
    v_device_id uuid := gen_random_uuid();
    v_secret text;
begin
    v_d := private.fdb_anonymous_caller();
    v_sid := (auth.jwt() ->> 'session_id')::uuid;

    perform private.foreverdb_take_budget('enroll:uid:' || v_d::text, 300, 5);

    if p_ticket is null or p_ticket !~ '^fdba1_[A-Za-z0-9_-]{43}$' then
        perform private.foreverdb_take_budget('enroll:global', 300, 120);
        insert into private.device_audit (event, actor_uid, detail) values ('enroll_refused', v_d, 'ticket_format');
        return jsonb_build_object('ok', false, 'error', 'invalid_ticket');
    end if;
    if p_installation_id is null or length(p_installation_id) not between 16 and 128
       or p_installation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$' then
        perform private.foreverdb_take_budget('enroll:global', 300, 120);
        insert into private.device_audit (event, actor_uid, detail) values ('enroll_refused', v_d, 'installation_format');
        return jsonb_build_object('ok', false, 'error', 'invalid_installation');
    end if;
    v_label := nullif(btrim(left(regexp_replace(coalesce(p_label, ''), '[[:cntrl:]]', '', 'g'), 60)), '');
    v_hash := extensions.digest(p_ticket, 'sha256');

    select t.id into v_ticket_id from private.enrollment_tickets t where t.ticket_hash = v_hash;
    if not found then
        perform private.foreverdb_take_budget('enroll:global', 300, 120);
        insert into private.device_audit (event, actor_uid, installation_id, detail) values ('enroll_refused', v_d, p_installation_id, 'unknown_ticket');
        return jsonb_build_object('ok', false, 'error', 'invalid_ticket');
    end if;

    perform pg_advisory_xact_lock(hashtextextended(p_installation_id, 0));
    perform private.foreverdb_take_budget('enroll:global', 300, 120);
    perform private.fdb_lock_live_session(v_d, v_sid, true);

    select t.account_uid, t.status, t.expires_at into v_account, v_status, v_expires
    from private.enrollment_tickets t where t.id = v_ticket_id for update;
    if not found then
        return jsonb_build_object('ok', false, 'error', 'invalid_ticket');
    end if;

    if v_status = 'consumed' or v_status = 'revoked' or v_expires <= clock_timestamp() then
        insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
        values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id,
                case when v_status = 'consumed' then 'ticket_consumed' when v_status = 'revoked' then 'ticket_revoked' else 'ticket_expired' end);
        return jsonb_build_object('ok', false, 'error',
                case when v_status = 'consumed' then 'ticket_consumed' when v_status = 'revoked' then 'ticket_revoked' else 'ticket_expired' end);
    end if;

    if not private.fdb_account_usable(v_account) then
        insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
        values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'account_unavailable');
        return jsonb_build_object('ok', false, 'error', 'account_unavailable');
    end if;

    -- Serialize this session without requiring it to have only one installation. The installation lock below still
    -- prevents two credentials from concurrently binding the same installation.
    perform pg_advisory_xact_lock(hashtextextended('fdb-account:' || v_account::text, 0));
    perform pg_advisory_xact_lock(hashtextextended('fdb-device-identity:' || v_d::text, 0));

    select i.owner_user_id into v_owner from public.installations i where i.id = p_installation_id for update;
    v_found := found;

    if v_found then
        if v_owner is distinct from v_account then
            insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
            values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'installation_conflict');
            return jsonb_build_object('ok', false, 'error', 'installation_conflict');
        end if;

        select d.id, d.auth_uid into v_dev from private.devices d where d.installation_id = p_installation_id and d.status <> 'revoked' for update;
        if found then
            if v_dev.auth_uid <> v_d then
                insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
                values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'installation_bound');
                return jsonb_build_object('ok', false, 'error', 'installation_bound');
            end if;
            update private.devices set status = 'revoked', revoked_at = clock_timestamp(), revoked_reason = 'replaced' where id = v_dev.id;
            insert into private.device_audit (event, account_uid, actor_uid, device_id, installation_id, detail)
            values ('device_replaced', v_account, v_d, v_dev.id, p_installation_id, 'same_identity');
        end if;
    else
        select count(*) into v_owned from public.installations i where i.owner_user_id = v_account;
        if v_owned >= 50 then
            insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
            values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'account_limit');
            return jsonb_build_object('ok', false, 'error', 'account_limit');
        end if;
    end if;

    select count(*) into v_live from private.devices d where d.account_uid = v_account and d.status <> 'revoked';
    if v_live >= 10 then
        insert into private.device_audit (event, account_uid, actor_uid, ticket_id, installation_id, detail)
        values ('enroll_refused', v_account, v_d, v_ticket_id, p_installation_id, 'device_limit');
        return jsonb_build_object('ok', false, 'error', 'device_limit');
    end if;

    if not v_found then
        insert into public.installations (id, owner_user_id, schema_version, addon_version, first_seen_at, last_seen_at)
        values (p_installation_id, v_account, 0, 'enrolled', now(), now());
    end if;

    v_secret := 'fdbd1_' || replace(v_device_id::text, '-', '') || '_' || translate(rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='), '+/', '-_');

    insert into private.devices (id, account_uid, installation_id, auth_uid, label, status, ticket_id, credential_hash, credential_issued_at, last_seen_at)
    values (v_device_id, v_account, p_installation_id, v_d, v_label, 'active', v_ticket_id, extensions.digest(v_secret, 'sha256'), clock_timestamp(), clock_timestamp());

    update private.enrollment_tickets
    set status = 'consumed', consumed_at = clock_timestamp(), consumed_device_id = v_device_id
    where id = v_ticket_id;

    insert into private.device_audit (event, account_uid, actor_uid, device_id, ticket_id, installation_id)
    values ('enroll_succeeded', v_account, v_d, v_device_id, v_ticket_id, p_installation_id);

    return jsonb_build_object('ok', true, 'device_id', v_device_id, 'device_secret', v_secret, 'installation_id', p_installation_id);
end;
$$;

alter function public.fdb_device_enroll(text, text, text) set lock_timeout = '5s';
revoke all on function public.fdb_device_enroll(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.fdb_device_enroll(text, text, text) to authenticated;

do $postflight$
begin
    if to_regclass('private.devices_one_live_per_identity') is not null then
        raise exception '0017 post-condition: obsolete identity uniqueness index remains';
    end if;
    if to_regclass('private.devices_one_live_per_installation') is null then
        raise exception '0017 post-condition: installation uniqueness index is missing';
    end if;
    if not has_function_privilege('authenticated', 'public.fdb_device_enroll(text,text,text)', 'execute')
       or has_function_privilege('anon', 'public.fdb_device_enroll(text,text,text)', 'execute') then
        raise exception '0017 post-condition: enrollment ACL is incorrect';
    end if;
end $postflight$;

notify pgrst, 'reload schema';

commit;
