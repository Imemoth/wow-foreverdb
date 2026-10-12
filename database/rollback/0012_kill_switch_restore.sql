-- ForeverDB 0012: lift the kill switch (re-grant EXECUTE on the six account RPCs to `authenticated` only).
-- Run as the migration role after the incident review. Nothing else changes.
begin;
set local lock_timeout = '10s';

grant execute on function public.fdb_account_claim_start(text) to authenticated;
grant execute on function public.fdb_account_claim_redeem(text) to authenticated;
grant execute on function public.fdb_installation_link_status(text) to authenticated;
grant execute on function public.fdb_account_installations() to authenticated;
grant execute on function public.fdb_account_guildbook_guilds(text) to authenticated;
grant execute on function public.fdb_account_guildbook_members(text, text, integer, integer) to authenticated;

do $verify$
declare
    v_sig text;
begin
    foreach v_sig in array array[
        'public.fdb_account_claim_start(text)', 'public.fdb_account_claim_redeem(text)', 'public.fdb_installation_link_status(text)',
        'public.fdb_account_installations()', 'public.fdb_account_guildbook_guilds(text)',
        'public.fdb_account_guildbook_members(text,text,integer,integer)'
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
