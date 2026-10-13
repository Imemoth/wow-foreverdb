-- 0015 ROLLBACK. Removes the triggers and functions. Tables are KEPT by default (they hold the "already welcomed" memory that stops a
-- later re-install from sending duplicates). To drop them as well:  psql -v drop_data=1 -f this.sql
-- DROP TRIGGER on auth.users needs ownership of that table (role supabase_auth_admin on Supabase). If your role lacks it, run the two
-- drop-trigger statements as that role, or leave the (inert, switch-gated) triggers in place: with both switches OFF they only read config.
\if :{?drop_data}
\else
\set drop_data 0
\endif
begin;
select private.azerdex_welcome_set_switch(false, false);
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
-- set_switch is dropped last because the first statement above uses it.
drop function if exists private.azerdex_welcome_set_switch(boolean, boolean);
\if :drop_data
drop table if exists private.azerdex_welcome_trigger_failures, private.azerdex_welcome_outbox, private.azerdex_welcome_candidates, private.azerdex_welcome_config;
\endif
commit;
