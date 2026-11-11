-- READ-ONLY verifier for 0020 (gated RPC). Safe to run on production as the platform `postgres` admin: it only reads catalogs, never key material, and writes nothing.
-- Usage: psql -X -tA -f database/ops/verify_ops_health_gated_rpc.sql   -> one line per check: STATUS|check|detail   (STATUS is PASS, FAIL or INFO).
-- A run is clean when no line starts with FAIL. INFO lines carry the fingerprints to compare with the baseline recorded before 0020 (see docs/ops-bot/reporting-gated-rpc.md).
-- The fingerprint expressions are the ones in scripts/ops-health-sql-tests.sh (`fp()`, with `~` as separator) minus what 0020/0019 legitimately add
-- (schema ops_report, the function public.ops_health_report and the role azerdex_ops_reporter), so they must equal the pre-change production values.
with
fn as (
    select p.oid, n.nspname, p.proname, p.prosecdef, p.provolatile, p.proconfig, p.proowner, p.proacl,
           n.nspname || '.' || p.proname as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'ops_report' or (n.nspname = 'public' and p.proname = 'ops_health_report')
),
grantees as (   -- who holds EXECUTE (PUBLIC shows as 'PUBLIC'; a function with no explicit ACL is PUBLIC-executable by default, so it is visible here)
    select f.sig, array_agg(distinct case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end order by case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end) as who
      from fn f cross join lateral aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
     where a.privilege_type = 'EXECUTE'
     group by f.sig
),
exp(sig, allowed, required) as (values
    ('ops_report.gated_health',   array['anon','postgres'],                              array['anon','postgres']),
    ('ops_report.rotate_gate_key', array['postgres'],                                    array['postgres']),
    ('ops_report.revoke_gate',    array['postgres'],                                     array['postgres']),
    ('ops_report.gate_status',    array['postgres'],                                     array['postgres']),
    ('ops_report.health',         array['azerdex_ops_reporter','postgres'],              array['postgres']),
    ('public.ops_health_report',  array['anon','postgres'],                              array['anon','postgres'])
),
sch as (
    select case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end || ':' || a.privilege_type as g
      from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname = 'ops_report'
),
keys as (select count(*) filter (where slot = 'current') as cur, count(*) filter (where slot = 'previous') as prev,
                count(*) filter (where slot = 'previous' and expires_at > created_at + interval '1 hour') as overlong
           from ops_report.gate_keys),
rel as (
    select c.relrowsecurity, c.relowner::regrole::text as owner,
           (select array_agg(distinct case a.grantee when 0 then 'PUBLIC' else a.grantee::regrole::text end) from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a) as who,
           (select count(*) from pg_attribute at where at.attrelid = c.oid and at.attacl is not null) as column_acls
      from pg_class c where c.oid = to_regclass('ops_report.gate_keys')
),
checks(status, check_name, detail) as (
    select case when (select count(*) from fn where nspname = 'ops_report') = 5 then 'PASS' else 'FAIL' end,
           'ops_report contains exactly the five expected functions',
           (select string_agg(proname, ',' order by proname) from fn where nspname = 'ops_report')
    union all
    select case when g.who is not null and g.who <@ e.allowed and g.who @> e.required then 'PASS' else 'FAIL' end,
           'EXECUTE grantees of ' || e.sig, coalesce(array_to_string(g.who, ','), 'none')
      from exp e left join grantees g on g.sig = e.sig
    union all
    select case when not exists (select 1 from grantees where 'PUBLIC' = any (who)) then 'PASS' else 'FAIL' end, 'no new function is executable by PUBLIC', ''
    union all
    select case when (select array_agg(g order by g) from sch) <@ array['anon:USAGE','azerdex_ops_reporter:USAGE','postgres:CREATE','postgres:USAGE']
                  and exists (select 1 from sch where g = 'anon:USAGE') and not exists (select 1 from sch where g like 'PUBLIC:%') then 'PASS' else 'FAIL' end,
           'schema ops_report ACL is postgres + anon USAGE (+ the reporter until 0021)', (select string_agg(g, ',' order by g) from sch)
    union all
    select case when (select bool_and(owner = 'postgres') from (select proowner::regrole::text as owner from fn) o) then 'PASS' else 'FAIL' end, 'all functions are owned by postgres', ''
    union all
    select case when (select bool_and(prosecdef) from fn where sig in ('ops_report.gated_health','ops_report.rotate_gate_key','ops_report.revoke_gate','ops_report.gate_status','ops_report.health'))
                  and (select not prosecdef from fn where sig = 'public.ops_health_report') then 'PASS' else 'FAIL' end,
           'ops_report functions are SECURITY DEFINER; the public wrapper is SECURITY INVOKER', ''
    union all
    select case when (select bool_and(proconfig @> array['search_path=pg_catalog']) from fn) then 'PASS' else 'FAIL' end, 'every function pins search_path = pg_catalog', ''
    union all
    select case when (select bool_and(provolatile = 's') from fn where sig in ('ops_report.gated_health','ops_report.health','ops_report.gate_status','public.ops_health_report')) then 'PASS' else 'FAIL' end,
           'read paths are STABLE (cannot write)', ''
    union all
    select case when (select bool_and(prosrc !~* '\mexecute\M\s+(format|\x27|\$)' and prosrc !~* '\mexecute\M\s+[a-z_]+\s*\(') from pg_proc p where p.oid in (select oid from fn)) then 'PASS' else 'FAIL' end,
           'no dynamic SQL in any function body', ''
    union all
    select case when r.relrowsecurity and r.owner = 'postgres' and r.who = array['postgres'] and r.column_acls = 0 then 'PASS' else 'FAIL' end,
           'ops_report.gate_keys: RLS on, owner-only ACL, no column grants', coalesce(array_to_string(r.who, ','), 'missing') from rel r
    union all
    select case when has_function_privilege('anon', 'public.ops_health_report()', 'execute')
                  and not has_function_privilege('authenticated', 'public.ops_health_report()', 'execute')
                  and not has_function_privilege('service_role', 'public.ops_health_report()', 'execute') then 'PASS' else 'FAIL' end,
           'Data API: only anon can call public.ops_health_report()', ''
    union all
    select case when not exists (select 1 from fn where nspname = 'ops_report' and sig <> 'ops_report.gated_health'
                                   and (has_function_privilege('anon', oid, 'execute') or has_function_privilege('authenticated', oid, 'execute') or has_function_privilege('service_role', oid, 'execute')))
                  and not has_function_privilege('authenticated', 'ops_report.gated_health()', 'execute') and not has_function_privilege('service_role', 'ops_report.gated_health()', 'execute')
                  and not has_table_privilege('anon', 'ops_report.gate_keys', 'select,insert,update,delete,truncate,references,trigger')
                  and not has_table_privilege('authenticated', 'ops_report.gate_keys', 'select,insert,update,delete,truncate,references,trigger')
                  and not has_table_privilege('service_role', 'ops_report.gate_keys', 'select,insert,update,delete,truncate,references,trigger') then 'PASS' else 'FAIL' end,
           'anon reaches only gated_health in ops_report; authenticated/service_role reach nothing there; nobody reads gate_keys', ''
    union all
    select case when k.prev <= 1 and k.cur <= 1 and k.overlong = 0 then 'PASS' else 'FAIL' end, 'key slots: at most one current and one previous, previous overlap at most 1 hour',
           'current=' || k.cur || ' previous=' || k.prev from keys k
    union all
    select 'INFO', 'gate state', case when k.cur = 1 then 'open (a current key exists)' else 'CLOSED (no current key: every request is refused)' end from keys k
    union all
    select 'INFO', 'login role azerdex_ops_reporter', case when exists (select 1 from pg_roles where rolname = 'azerdex_ops_reporter') then 'present (expected until 0021)' else 'absent (expected after 0021)' end
    union all
    select 'INFO', 'fingerprint cron.job', (select md5(coalesce(string_agg(jobid || '|' || jobname || '|' || schedule || '|' || command || '|' || active, '~' order by jobid), '')) from cron.job)
    union all
    select 'INFO', 'fingerprint functions (outside ops_report and public.ops_health_report)',
           (select md5(coalesce(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || p.proowner::regrole::text || coalesce(p.proacl::text, '') || coalesce(p.proconfig::text, ''), '~' order by p.oid::regprocedure::text), ''))
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname not in ('pg_catalog', 'information_schema', 'ops_report') and not (n.nspname = 'public' and p.proname = 'ops_health_report'))
    union all
    select 'INFO', 'fingerprint schemas+ACL (outside ops_report)',
           (select md5(coalesce(string_agg(nspname || coalesce(nspacl::text, '') || nspowner::regrole::text, '~' order by nspname), '')) from pg_namespace where nspname not in ('information_schema', 'ops_report') and nspname !~ '^pg_')
    union all
    select 'INFO', 'fingerprint relations+ACL (outside ops_report)',
           (select md5(coalesce(string_agg(n.nspname || '.' || c.relname || coalesce(c.relacl::text, ''), '~' order by n.nspname, c.relname), ''))
              from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog', 'information_schema', 'ops_report', 'pg_toast', 'pg_temp_1'))
    union all
    select 'INFO', 'fingerprint roles (outside azerdex_ops_reporter)',
           (select md5(coalesce(string_agg(rolname || rolsuper::text || rolcreaterole::text || rolcanlogin::text || rolbypassrls::text, '~' order by rolname), '')) from pg_roles where rolname <> 'azerdex_ops_reporter' and rolname !~ '^pg_')
)
select status || '|' || check_name || '|' || coalesce(detail, '') from checks
order by case status when 'FAIL' then 0 when 'PASS' then 1 else 2 end, check_name;
