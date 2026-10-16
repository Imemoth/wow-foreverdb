-- ForeverDB 0014 KILL SWITCH (non-destructive, instantly reversible).
--
-- Stops zero-touch enrollment and registered DEVICE synchronization for every client role WITHOUT dropping anything and WITHOUT
-- touching ownership or data:
--   * no activation ticket can be issued, listed, revoked or redeemed; no device can enroll, introspect, rotate or ingest;
--   * private.enrollment_tickets / devices / device_audit, installations.owner_user_id and every observation and Guildbook row stay;
--   * anonymous ingest, the 0012 claim/account functions, search and statistics are NOT affected.
-- Re-enable with database/rollback/0014_kill_switch_restore.sql. Run as the migration role. Operator-approved; record it in the incident log.
begin;
set local lock_timeout = '10s';

revoke all on function public.fdb_account_enrollment_ticket_issue(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_enrollment_tickets() from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_enrollment_ticket_revoke(uuid) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_devices() from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_device_revoke(uuid) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_enroll(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_status(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_ingest(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.fdb_device_rotate_credential(text) from public, anon, authenticated, service_role;

do $verify$
declare
    v_sig text;
begin
    foreach v_sig in array array[
        'public.fdb_account_enrollment_ticket_issue(text)', 'public.fdb_account_enrollment_tickets()',
        'public.fdb_account_enrollment_ticket_revoke(uuid)', 'public.fdb_account_devices()', 'public.fdb_account_device_revoke(uuid)',
        'public.fdb_device_enroll(text,text,text)', 'public.fdb_device_status(text)', 'public.fdb_device_ingest(text,jsonb)',
        'public.fdb_device_rotate_credential(text)'
    ] loop
        if has_function_privilege('authenticated', v_sig, 'execute') then
            raise exception 'kill switch failed: % is still executable by authenticated', v_sig;
        end if;
    end loop;
    if not has_function_privilege('authenticated', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'execute') then
        raise exception 'unexpected: the existing ingest RPC lost its privilege';
    end if;
end $verify$;

notify pgrst, 'reload schema';
commit;
