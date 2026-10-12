-- Account System V1 integration environment: Supabase-like roles and Auth helper functions.
-- Run ONLY against a disposable, isolated database (never a real Supabase project). The roles mirror what the
-- Supabase platform provides so the migration runs as a NON-superuser owner with BYPASSRLS, like the real `postgres` role.
-- Usage (superuser): psql -v ON_ERROR_STOP=1 -v db=fdb_account_it -f 00_bootstrap_roles.sql   (database must exist)

-- Cluster-level roles (idempotent).
do $roles$
begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticator') then
        create role authenticator noinherit login password 'local-test-password';
    end if;
    -- GoTrue's database role (owns the auth schema on Supabase).
    if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
        create role supabase_auth_admin noinherit createrole login password 'local-test-password';
    end if;
    -- Stand-in for Supabase's `postgres` role: NOT a superuser, BYPASSRLS, owns public/private objects.
    if not exists (select 1 from pg_roles where rolname = 'fdb_migrator') then
        create role fdb_migrator login password 'local-test-password' bypassrls createrole;
    end if;
end $roles$;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to fdb_migrator;   -- the real postgres role can SET ROLE to the API roles
