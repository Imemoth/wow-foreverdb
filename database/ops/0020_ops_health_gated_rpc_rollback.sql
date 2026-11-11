-- Rollback for 0020_ops_health_gated_rpc.sql. OWNER/OPERATOR, run as the platform `postgres` admin. Idempotent.
-- Removes ONLY what 0020 created (the public wrapper, the ops_report gate functions, the key table, and anon's USAGE on ops_report).
-- It does not touch ops_report.health(), the 0019 login role, any existing object, cron job or data.
-- ORDER: run this BEFORE 0019_ops_health_report_rollback.sql (which drops the schema and would refuse while gate_keys exists).
-- First stop the Edge Function from calling the RPC (redeploy the previous index.ts) or accept that it answers 503 meanwhile.
begin;
drop function if exists public.ops_health_report();
drop function if exists ops_report.gated_health();
drop function if exists ops_report.gate_status();
drop function if exists ops_report.revoke_gate();
drop function if exists ops_report.rotate_gate_key(interval);
drop table if exists ops_report.gate_keys;
revoke usage on schema ops_report from anon;
commit;
