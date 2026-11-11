grant create on database fdb_admin_it to fdb_migrator;

create schema auth;
create table auth.users (id uuid primary key);
grant usage on schema auth to fdb_migrator;
grant select, insert, delete, references on auth.users to fdb_migrator;

create schema private;
create table private.guildbook_sentinel (id integer primary key, payload text not null);
insert into private.guildbook_sentinel values (1, 'untouched');

create table public.account_sentinel (id integer primary key, payload text not null);
insert into public.account_sentinel values (1, 'untouched');

create schema supabase_migrations;
create table supabase_migrations.schema_migrations (name text primary key);
grant usage on schema supabase_migrations to fdb_migrator;
grant select on supabase_migrations.schema_migrations to fdb_migrator;
