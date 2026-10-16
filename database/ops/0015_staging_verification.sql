-- READ-ONLY verification of the welcome outbox on a HOSTED STAGING project (run with the database owner role, e.g. in the SQL editor or psql).
-- Changes nothing. Every check raises on deviation, so a clean run printing 'OK' is the evidence. Safe to re-run at any time.
--   psql "$STAGING_DB_URL" -X -v ON_ERROR_STOP=1 -f database/ops/0015_staging_verification.sql
do $verify$
declare
    t text; r text; f record; n integer;
begin
    -- 1. tables: forced RLS, no policy, no privilege for any API role
    foreach t in array array['azerdex_welcome_config','azerdex_welcome_candidates','azerdex_welcome_outbox','azerdex_welcome_trigger_failures'] loop
        if not coalesce((select c.relrowsecurity and c.relforcerowsecurity from pg_class c where c.oid = to_regclass('private.' || t)), false) then raise exception 'RLS not forced on private.%', t; end if;
        if exists (select 1 from pg_policy p where p.polrelid = to_regclass('private.' || t)) then raise exception 'private.% has a policy', t; end if;
        foreach r in array array['anon','authenticated','service_role'] loop
            if has_any_column_privilege(r, 'private.' || t, 'SELECT,INSERT,UPDATE,REFERENCES') or has_table_privilege(r, 'private.' || t, 'DELETE,TRUNCATE,TRIGGER') then
                raise exception 'role % holds a privilege on private.%', r, t; end if;
        end loop;
    end loop;
    -- 2. functions: twelve, SECURITY DEFINER, pinned search_path, only the three RPCs executable and only by service_role
    n := 0;
    for f in select p.oid, p.oid::regprocedure::text sig, n.nspname, p.prosecdef, coalesce(p.proconfig, '{}') cfg
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname like 'azerdex\_welcome\_%' loop
        n := n + 1;
        if not f.prosecdef or not exists (select 1 from unnest(f.cfg) c where c like 'search_path=%') then raise exception '% is not SECURITY DEFINER with a pinned search_path', f.sig; end if;
        if has_function_privilege('anon', f.oid, 'EXECUTE') or has_function_privilege('authenticated', f.oid, 'EXECUTE') or has_function_privilege('public', f.oid, 'EXECUTE') then
            raise exception '% is executable by anon/authenticated/public', f.sig; end if;
        if has_function_privilege('service_role', f.oid, 'EXECUTE') <> (f.nspname = 'public') then raise exception '% has the wrong service_role EXECUTE grant', f.sig; end if;
    end loop;
    if n <> 12 then raise exception 'expected 12 welcome functions, found %', n; end if;
    -- 3. triggers on auth.users
    if (select count(*) from pg_trigger t where t.tgrelid = 'auth.users'::regclass and t.tgname in ('azerdex_welcome_on_signup','azerdex_welcome_on_confirm') and t.tgenabled = 'O' and not t.tgisinternal) <> 2 then
        raise exception 'the two auth.users triggers are missing or disabled'; end if;
    -- 4. kill switches: report (never assert a value: the owner moves them deliberately)
    raise notice 'switches: %', (select to_jsonb(c) - 'singleton' from private.azerdex_welcome_config c);
    -- 5. no unexpected exposure of the schema's objects through PostgREST-visible schemas
    if exists (select 1 from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relname like 'azerdex\_welcome\_%') then raise exception 'a welcome table leaked into schema public'; end if;
    raise notice 'OK: welcome outbox privilege / function / trigger verification passed';
end
$verify$;
