-- Disposable Supabase-like roles. Never point this fixture at a hosted project.
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login password 'local-test-only' noinherit;
create role fdb_migrator login password 'local-test-only' createrole bypassrls;
grant anon, authenticated, service_role to fdb_migrator;
grant anon, authenticated, service_role to authenticator;

-- Simulate permissive managed defaults. Migration must explicitly revoke actual ACLs.
alter default privileges for role fdb_migrator
    grant select on tables to anon, authenticated, service_role;
