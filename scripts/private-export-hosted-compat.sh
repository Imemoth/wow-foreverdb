#!/usr/bin/env bash
# Applies migration 0010 (private aggregate export) the way the PRIVATE Supabase project's `postgres` role would: as a NON-superuser
# with CREATEROLE, on a database holding stand-ins (audited column layout of the real tables) for the objects 0010 reads. Then
# exercises the kill switch, its restore, the FULL rollback and a re-apply. EPHEMERAL SERVER ONLY (fresh cluster: roles are cluster-wide).
# Env: PGHOST PGPORT PGUSER (superuser of the throwaway server).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}"
case "${PGHOST}" in localhost|127.0.0.1|/tmp|/var/run/postgresql) ;; *) echo "Refusing non-local PGHOST=${PGHOST}"; exit 2;; esac
DB=${PRIVATE_COMPAT_DB:-az_private_probe}
S="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
$S -c "drop database if exists $DB" >/dev/null
for r in anon authenticated service_role; do psql -X -q -d postgres -c "create role $r nologin" 2>/dev/null || true; done
ADMIN_PW=${ADMIN_PW:-it-only-admin}
psql -X -q -d postgres -c "create role sbadmin login createrole createdb bypassrls inherit" 2>/dev/null || true
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "alter role sbadmin password '$ADMIN_PW'"
$S -c "create database $DB owner sbadmin" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -d $DB >/dev/null <<'SQL'
-- stand-ins with the column layout read from the real private project on 2026-10-21 (no data)
create table public.installations (installation_id text primary key);
create table public.sources (source_type text not null, source_id bigint not null, source_level integer not null, name text, first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), primary key (source_type, source_id, source_level));
create table public.items (item_id bigint primary key, name text, first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now());
create table public.installation_source_stats (installation_id text not null, source_type text not null, source_id bigint not null, source_level integer not null, loot_kind text not null, observations bigint not null, updated_at timestamptz not null default now(), primary key (installation_id, source_type, source_id, source_level, loot_kind));
create table public.installation_item_stats (installation_id text not null, source_type text not null, source_id bigint not null, source_level integer not null, loot_kind text not null, item_id bigint not null, drop_count bigint not null, quantity bigint not null, quest_drop_count bigint not null, quest_ids bigint[] not null default '{}', updated_at timestamptz not null default now(), primary key (installation_id, source_type, source_id, source_level, loot_kind, item_id));
create table public.installation_location_stats (installation_id text not null, source_type text not null, source_id bigint not null, source_level integer not null, loot_kind text not null, map_id bigint not null, zone_name text, subzone_name text not null, x numeric not null, y numeric not null, observations bigint not null, updated_at timestamptz not null default now(), primary key (installation_id, source_type, source_id, source_level, loot_kind, map_id, subzone_name, x, y));
create table public.installation_guilds (installation_id text);
create table public.installation_guild_members (installation_id text);
create table public.installation_guild_professions (installation_id text);
create table public.map_asset_diagnostics (installation_id text);
create schema private;
SQL
psql -X -q -v ON_ERROR_STOP=1 -d $DB -c "alter schema public owner to sbadmin" -c "alter table public.installations owner to sbadmin" >/dev/null
for t in sources items installation_source_stats installation_item_stats installation_location_stats installation_guilds installation_guild_members installation_guild_professions map_asset_diagnostics; do
  psql -X -q -d $DB -c "alter table public.$t owner to sbadmin" >/dev/null; done
psql -X -q -d $DB -c "alter schema private owner to sbadmin" >/dev/null
A="env PGPASSWORD=$ADMIN_PW psql -X -q -v ON_ERROR_STOP=1 -U sbadmin -d $DB"
$A -c "select rolsuper from pg_roles where rolname = current_user" -At | grep -q f || { echo "FAIL: admin must not be superuser"; exit 1; }
$A -f database/private-export/0010_public_projection_export.sql >/dev/null
echo "PASS: 0010 applied as a non-superuser admin (boundary assertions inside the migration passed)"

q() { $A -At -c "$1"; }
[ "$(q "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='publication_export'")" = "6" ] || { echo "FAIL: expected 6 export functions"; exit 1; }
[ "$(q "select rolcanlogin::text || rolsuper::text || rolbypassrls::text || rolcreaterole::text from pg_roles where rolname='foreverdb_projection_reader'")" = "falsefalsefalsefalse" ] || { echo "FAIL: reader role attributes"; exit 1; }
for f in export_meta_v1 export_sources_v1 export_items_v1 export_buckets_v1 export_drops_v1; do
  q "select has_function_privilege('foreverdb_projection_reader','publication_export.$f()','execute')" | grep -q t || { echo "FAIL: reader cannot execute $f"; exit 1; }
done
q "select has_function_privilege('foreverdb_projection_reader','publication_export.export_locations_v1(numeric)','execute')" | grep -q t || { echo "FAIL: reader cannot execute export_locations_v1"; exit 1; }
for r in anon authenticated service_role public; do
  [ "$(q "select (has_schema_privilege('$r','publication_export','usage') or has_function_privilege('$r','publication_export.export_drops_v1()','execute'))::text")" = "false" ] || { echo "FAIL: $r reaches the export"; exit 1; }
done
echo "PASS: only foreverdb_projection_reader can execute the six export functions; anon/authenticated/service_role/PUBLIC cannot"

# the export functions run (empty data) as the reader and the reader cannot touch tables
$A -c "grant foreverdb_projection_reader to current_user with set true, inherit false" >/dev/null
$A -c "set role foreverdb_projection_reader; select count(*) from publication_export.export_buckets_v1(); select count(*) from publication_export.export_locations_v1(1.0);" >/dev/null
if $A -c "set role foreverdb_projection_reader; select 1 from public.installation_location_stats limit 1" >/dev/null 2>&1; then echo "FAIL: reader read a table"; exit 1; fi
if $A -c "set role foreverdb_projection_reader; select * from publication_export.export_locations_v1(0.25)" >/dev/null 2>&1; then echo "FAIL: fine grid accepted"; exit 1; fi
echo "PASS: reader executes the functions, cannot read tables, and cannot request a finer grid than 0.5"

# kill switch + restore
$A -f database/rollback/0010_public_projection_export_kill_switch.sql >/dev/null
[ "$(q "select rolcanlogin::text from pg_roles where rolname='foreverdb_projection_reader'")" = "false" ] || { echo "FAIL: kill switch"; exit 1; }
$A -c "alter role foreverdb_projection_reader login password 'it-only'" >/dev/null
$A -f database/rollback/0010_public_projection_export_kill_switch.sql >/dev/null
$A -f database/rollback/0010_public_projection_export_kill_switch_restore.sql >/dev/null
[ "$(q "select rolcanlogin::text from pg_roles where rolname='foreverdb_projection_reader'")" = "true" ] || { echo "FAIL: restore"; exit 1; }
$A -c "alter role foreverdb_projection_reader nologin" >/dev/null
echo "PASS: kill switch disables login, restore re-enables it, nothing dropped"

# full rollback, then re-apply
$A -f database/rollback/0010_public_projection_export_rollback.sql >/dev/null
[ "$(q "select (select count(*) from pg_namespace where nspname='publication_export') + (select count(*) from pg_roles where rolname='foreverdb_projection_reader')")" = "0" ] || { echo "FAIL: rollback left objects"; exit 1; }
[ "$(q "select count(*) from public.installation_location_stats")" = "0" ] || { echo "FAIL: data table touched"; exit 1; }
$A -f database/private-export/0010_public_projection_export.sql >/dev/null
echo "PASS: full rollback removes exactly the export boundary; 0010 re-applies cleanly afterwards"
echo "PRIVATE EXPORT COMPAT CHECKS PASSED"
