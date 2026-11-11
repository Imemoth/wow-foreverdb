-- Rollback for 0019_ops_health_report.sql. OWNER/OPERATOR, run as the platform `postgres` admin. Idempotent.
-- Removes ONLY what 0019 created: the function, its schema and the reporting role. It changes no other object, no cron job and no data.
-- (Existing sessions of the role, if any, end when the role's connections close; stop the Edge Function first to make that immediate.)
begin;
drop function if exists ops_report.health();
drop schema if exists ops_report;
do $do$
begin
    if exists (select 1 from pg_roles where rolname = 'azerdex_ops_reporter') then
        drop owned by azerdex_ops_reporter;
        drop role azerdex_ops_reporter;
    end if;
end
$do$;
commit;
