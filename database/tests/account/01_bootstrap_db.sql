-- Per-database part of the bootstrap (connect to the disposable database as superuser).
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role, fdb_migrator;

alter database :"db" owner to fdb_migrator;
alter schema public owner to fdb_migrator;
grant all on schema public to fdb_migrator;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase creates the auth schema owned by supabase_auth_admin; GoTrue then runs its own migrations in it.
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role, fdb_migrator;
grant all on schema auth to fdb_migrator;
-- Supabase grants the `postgres` role everything in auth (tables created later too).
alter default privileges for role supabase_auth_admin in schema auth grant all on tables to fdb_migrator;
alter default privileges for role supabase_auth_admin in schema auth grant all on sequences to fdb_migrator;
alter default privileges for role supabase_auth_admin in schema auth grant all on functions to fdb_migrator;
