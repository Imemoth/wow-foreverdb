-- Disposable subset of the pinned GoTrue schema for evaluator denial/race tests.
alter table auth.users add column is_anonymous boolean not null default false;
alter table auth.users add column deleted_at timestamptz;
alter table auth.users add column banned_until timestamptz;
create table auth.sessions (
    id uuid primary key,
    user_id uuid not null references auth.users(id),
    not_after timestamptz
);
create table auth.refresh_tokens (
    id bigint generated always as identity primary key,
    session_id uuid not null references auth.sessions(id),
    revoked boolean not null default false
);
grant select on auth.users, auth.sessions, auth.refresh_tokens to fdb_migrator;
grant update on auth.sessions to fdb_migrator;
