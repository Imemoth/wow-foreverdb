-- ForeverDB 0014: lift the kill switch (re-grant EXECUTE on the nine enrollment/device RPCs to `authenticated` only).
-- Run as the migration role after the incident review. Nothing else changes.
begin;
set local lock_timeout = '10s';

grant execute on function public.fdb_account_enrollment_ticket_issue(text) to authenticated;
grant execute on function public.fdb_account_enrollment_tickets() to authenticated;
grant execute on function public.fdb_account_enrollment_ticket_revoke(uuid) to authenticated;
grant execute on function public.fdb_account_devices() to authenticated;
grant execute on function public.fdb_account_device_revoke(uuid) to authenticated;
grant execute on function public.fdb_device_enroll(text, text, text) to authenticated;
grant execute on function public.fdb_device_status(text) to authenticated;
grant execute on function public.fdb_device_ingest(text, jsonb) to authenticated;
grant execute on function public.fdb_device_rotate_credential(text) to authenticated;

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
        if not has_function_privilege('authenticated', v_sig, 'execute')
           or has_function_privilege('anon', v_sig, 'execute') or has_function_privilege('public', v_sig, 'execute')
           or has_function_privilege('service_role', v_sig, 'execute') then
            raise exception 'restore failed for %', v_sig;
        end if;
    end loop;
end $verify$;

notify pgrst, 'reload schema';
commit;
