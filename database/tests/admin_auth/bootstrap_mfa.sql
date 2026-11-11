-- Disposable shape of the pinned GoTrue v2.197.0 MFA tables.
alter schema public owner to fdb_migrator;
alter table auth.sessions add column factor_id uuid;
alter table auth.sessions add column aal text;
create table auth.mfa_factors (
  id uuid primary key, user_id uuid not null references auth.users(id),
  factor_type text not null, status text not null
);
create table auth.mfa_amr_claims (
  session_id uuid not null references auth.sessions(id),
  authentication_method text not null, updated_at timestamptz not null,
  primary key(session_id,authentication_method)
);
grant select, update on auth.mfa_factors, auth.mfa_amr_claims to fdb_migrator;
