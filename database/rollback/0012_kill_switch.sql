-- ForeverDB 0012 KILL SWITCH (non-destructive, instantly reversible).
--
-- Stops every account/claim RPC for every client role WITHOUT dropping anything and WITHOUT touching ownership or data:
--   * claims can no longer be started or redeemed, the account Guildbook/installation reads stop, link status stops;
--   * installations.owner_user_id, private.installation_claims / account_installations / account_audit and every observation,
--     Guildbook and statistics row stay exactly as they are;
--   * ingest, search and statistics (the Companion's existing, anonymous-owner features) are NOT affected.
-- Re-enable with database/rollback/0012_kill_switch_restore.sql after the incident is understood.
--
-- Run as the migration role (owner of the functions). Operator-approved; record the action in the incident log.
begin;
set local lock_timeout = '10s';

revoke all on function public.fdb_account_claim_start(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_claim_redeem(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_installation_link_status(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_installations() from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_guildbook_guilds(text) from public, anon, authenticated, service_role;
revoke all on function public.fdb_account_guildbook_members(text, text, integer, integer) from public, anon, authenticated, service_role;

do $verify$
begin
    if has_function_privilege('authenticated', 'public.fdb_account_claim_start(text)', 'execute')
       or has_function_privilege('authenticated', 'public.fdb_account_claim_redeem(text)', 'execute')
       or has_function_privilege('authenticated', 'public.fdb_installation_link_status(text)', 'execute')
       or has_function_privilege('authenticated', 'public.fdb_account_installations()', 'execute')
       or has_function_privilege('authenticated', 'public.fdb_account_guildbook_guilds(text)', 'execute')
       or has_function_privilege('authenticated', 'public.fdb_account_guildbook_members(text,text,integer,integer)', 'execute') then
        raise exception 'kill switch failed: an account function is still executable by authenticated';
    end if;
    if not has_function_privilege('authenticated', 'public.ingest_foreverdb_snapshot_auth(jsonb)', 'execute') then
        raise exception 'unexpected: the existing ingest RPC lost its privilege';
    end if;
end $verify$;

notify pgrst, 'reload schema';
commit;
