-- 0015 ROLLBACK. Removes the triggers and functions. Tables are KEPT by default (they hold the "already welcomed" memory that stops a
-- later re-install from sending duplicates). To drop them as well:  psql -v drop_data=1 -f this.sql
--
-- OWNERSHIP: DROP TRIGGER on auth.users needs ownership of that table (role supabase_auth_admin on Supabase). Run this file as a role that
-- has it. If you cannot, do NOT run it: use database/rollback/0015_kill_switch.sql instead (the triggers are inert while both switches are
-- OFF: they only read the config row). The functions cannot be dropped while the triggers exist, so a partial rollback is not offered.
-- The script stops at the first error and rolls back as a whole (ON_ERROR_STOP), so nothing is half-removed.
\set ON_ERROR_STOP on
\if :{?drop_data}
\else
\set drop_data 0
\endif
begin;
do $off$
begin
    if to_regprocedure('private.azerdex_welcome_set_switch(boolean,boolean)') is not null then
        perform private.azerdex_welcome_set_switch(false, false);
    end if;
end
$off$;
drop trigger if exists azerdex_welcome_on_confirm on auth.users;
drop trigger if exists azerdex_welcome_on_signup on auth.users;
drop function if exists public.azerdex_welcome_claim(integer);
drop function if exists public.azerdex_welcome_finish(uuid, uuid, text, text, text, integer);
drop function if exists public.azerdex_welcome_stats();
drop function if exists private.azerdex_welcome_prune();
drop function if exists private.azerdex_welcome_operator_resolve(uuid, boolean, text);
drop function if exists private.azerdex_welcome_operator_requeue(uuid, boolean);
drop function if exists private.azerdex_welcome_reconcile();
drop function if exists private.azerdex_welcome_on_confirm();
drop function if exists private.azerdex_welcome_on_signup();
drop function if exists private.azerdex_welcome_note_failure(uuid, text, boolean);
drop function if exists private.azerdex_welcome_require_server_role();
drop function if exists private.azerdex_welcome_set_switch(boolean, boolean);
\if :drop_data
drop table if exists private.azerdex_welcome_trigger_failures, private.azerdex_welcome_outbox, private.azerdex_welcome_candidates, private.azerdex_welcome_config;
\endif
commit;
