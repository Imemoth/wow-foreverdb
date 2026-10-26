-- Fixture of the Supabase migration ledger (supabase_migrations.schema_migrations: version text primary key, statements text[], name text),
-- seeded with the entries the production ledger holds through 0011 (names only; versions are fixture values). Disposable databases only.
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
    version text not null primary key,
    statements text[],
    name text
);
insert into supabase_migrations.schema_migrations (version, name, statements) values
    ('20261008120000', 'restrict_legacy_public_stats', array['fixture']),
    ('20261009120000', 'api_security_rate_limits', array['fixture']),
    ('20261010151518', 'fix_observed_drop_rate_denominator', array['fixture'])
on conflict do nothing;
grant usage on schema supabase_migrations to fdb_migrator;
grant select, insert on supabase_migrations.schema_migrations to fdb_migrator;
