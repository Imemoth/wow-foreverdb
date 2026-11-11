-- 0021: removes the direct LOGIN credential (role azerdex_ops_reporter) created by 0019. OWNER/OPERATOR, run as the platform `postgres` admin. Idempotent.
-- DO NOT RUN until ALL of these hold (see docs/ops-bot/reporting-gated-rpc.md "Cut-over"):
--   1. 0020 is applied and the Edge Function with the gated Data API source is deployed;
--   2. the owner-run check (ops-bot/scripts/check-health-endpoint.ts) printed READY against it;
--   3. at least 48 hours have passed without the bot showing the reporting source as UNKNOWN;
--   4. the Edge Function secret OPS_HEALTH_DATABASE_URL has been removed (or will be right after).
-- After this the only way into the report is the HMAC-gated RPC. Revoking the grants and dropping the role changes no other object.
-- Roll back by re-applying 0019_ops_health_report.sql (it re-creates the role without a password; set one out of band) and redeploying the previous index.ts.
-- ops_report.health() stays, now executable by postgres only (reached through gated_health, which runs as its owner).
begin;
do $do$
begin
    if exists (select 1 from pg_roles where rolname = 'azerdex_ops_reporter') then
        drop owned by azerdex_ops_reporter;
        drop role azerdex_ops_reporter;
    end if;
end
$do$;
commit;
