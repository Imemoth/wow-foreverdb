-- Minimal Supabase-style bootstrap for GoTrue in an EPHEMERAL PostgreSQL (CI / local developer machine only).
-- Run as a superuser against a fresh, throw-away database. Never run against a real project.
-- Roles are cluster-wide: tolerate a cluster that already has them (re-runs on a developer machine).
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select from pg_roles where rolname = 'dashboard_user') then create role dashboard_user nologin; end if;
  if not exists (select from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin noinherit createrole login password 'authpw'; end if;
end $$;
create schema auth authorization supabase_auth_admin;
grant create on database :"dbname" to supabase_auth_admin;
alter role supabase_auth_admin set search_path = auth;
