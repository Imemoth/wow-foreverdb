-- LOCAL TEST ONLY: minimal stand-ins for the Supabase platform pieces that 0004 touches, so the migrations and the Edge
-- Function can be exercised on a throwaway PostgreSQL without Supabase. Real behaviour is verified on the hosted project.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text not null, description text);
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;
create function vault.create_secret(s text, n text default null, d text default '') returns uuid language sql as
$$ insert into vault.secrets (name, secret, description) values (n, s, d) returning id $$;
create function vault.update_secret(i uuid, s text) returns void language sql as $$ update vault.secrets set secret = s where id = i $$;

create schema cron;
create table cron.job (jobid bigserial primary key, schedule text, command text, jobname text unique, active boolean default true);
create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, return_message text, start_time timestamptz default now(), end_time timestamptz default now());
create function cron.schedule(n text, s text, c text) returns bigint language sql as
$$ insert into cron.job (jobname, schedule, command) values (n, s, c) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create function cron.unschedule(n text) returns boolean language sql as $$ with d as (delete from cron.job where jobname = n returning 1) select exists (select 1 from d) $$;

create schema net;
create table net._http_response (id bigint generated always as identity primary key, status_code integer, content text, timed_out boolean, error_msg text, created timestamptz default now());
create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000)
returns bigint language sql as $$ insert into net._http_response (status_code, content) values (null, left(url, 40)) returning id $$;
