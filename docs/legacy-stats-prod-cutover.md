# Legacy stats view: production-only rollout and rollback

Status: **PRODUCTION MIGRATION DEPLOYED / DATABASE ROLE CHECKS PASS / USER-REPORTED COMPANION RUNTIME PASS** (2026-10-08). **Direct HTTP JWT/PostgREST denial probe is a separate, open follow-up, not yet executed.** This procedure applies
only to the existing **wow-forever** Supabase project. Do not run against any
other project or treat the branch checkout as a deployed DB migration.

## Why both roles must be revoked

The Companion can sign in anonymously using Supabase Auth
(`SupabaseAuthService.SignInAnonymouslyAsync`). An anonymous **Auth user**
receives the database `authenticated` role, while a request using only the
publishable/legacy anon key uses `anon`. Keeping the direct view SELECT
for `authenticated` would therefore leave it available to anonymously
created accounts. Neither role needs this view for the documented Companion
features:

- Search: `public.items`, `public.sources`, and `get_foreverdb_search_*`.
- Stats/locations: `get_foreverdb_*_stats`, `get_foreverdb_*_locations`.
- Sync: `ingest_foreverdb_snapshot_auth(jsonb)` using an Auth JWT.

**Important distinction:** As observed on 2026-10-08, the production view
already has `security_invoker=true`; raw installation statistics tables
deny `anon` and `authenticated` direct SELECT. Grants alone do not prove
the view returned rows to these roles. The migration removes the unnecessary
direct view permission, not the intentionally callable aggregate RPCs.

## Preflight (read-only)

1. Arrange a brief low-traffic window, and confirm that restoring the current
   ACL is acceptable if the Companion regression gate fails. Take note of the
   current version of main and the open PR.
2. Record the grants and view option in the Supabase SQL Editor:

```sql
select
    c.relacl::text as existing_acl,
    c.reloptions as view_options,
    has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
    has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
    has_table_privilege('service_role', c.oid, 'SELECT') as service_role_select
from pg_class c
where c.oid = 'public.observed_loot_stats'::regclass;
```

3. The 2026-10-08 baseline was `anon=r`, `authenticated=r`,
   `service_role=arwdDxtm` (full table privileges), and
   `security_invoker=true`. Stop if the ACL or database objects have
   materially changed or you discover an untracked consumer of direct view
   access. Do not test by creating or overwriting synthetic production
   snapshots.

## Production cutover (completed 2026-10-08)

Production migration `restrict_legacy_public_stats` (version
`20261008153743`) was applied **once**, after explicit user approval, using
the SQL in `database/migrations/0007_restrict_legacy_public_stats.sql`.
The migration runs the REVOKE and compatibility assertions inside **one
PL/pgSQL DO statement**, so a failed assertion would abort that statement
and roll back the privilege change. It changed only the view SELECT grant;
it did not change raw data, search/statistics/location RPCs or auth ingest.

Do **not** re-apply on PR merge. GitHub merge itself does not execute SQL.

## Post-cutover verification and open transport follow-up

- **PASS — ACL:** `anon` and `authenticated` lack SELECT on
  `public.observed_loot_stats`; `service_role` retains SELECT.
- **PASS — real PostgreSQL role simulation:** executed transactional
  `SET LOCAL ROLE anon` and `SET LOCAL ROLE authenticated` separately,
  then attempted a direct `SELECT` from the view. Both returned
  `insufficient_privilege`, caught and asserted. Each role still
  returned the same scoped stats/location/search-zone results as preflight;
  the `anon` role cannot execute authenticated ingest, while
  `authenticated` can. Both tests ended with `ROLLBACK` (no data changes).
- **PASS — aggregate regression:** 374 legacy rows; zone count 5,
  item stats 3, item locations 14, source stats 5, source locations 4;
  item catalog 137, source catalog 133. Counts match before and after.
- **PASS (user-reported 2026-10-08) — existing Windows Companion:**
  after the live migration, the user confirmed all requested checks
  worked: Search, zone switch, item/source stats, Locations/map and
  manual sync. This is *human runtime acceptance*, not an independently
  executed test by the SQL connector. Auto Sync has prior live
  acceptance (2026-10-02) but was not separately evidenced here.
- **PASS — security advisor rerun:** no new findings from this change;
  existing 7 INFO (RLS enabled without policy), 1 WARN (authenticated
  SECURITY DEFINER ingest), 1 WARN (leaked password protection) remain.
- **OPEN — real HTTP transport/JWT probe:** execute
  `GET /rest/v1/observed_loot_stats?select=*&limit=1` with both an
  `anon` API key and an anonymous Auth-user JWT; both should be
  rejected. Also confirm catalog and aggregate RPCs work via actual
  HTTP. The direct JWT/PostgREST test was **not** performed in this
  session because an authenticated HTTP transport was unavailable.
  **Do not claim an HTTP/JWT PASS.** Database-role rejection plus
  live Companion acceptance support closing the scoped privilege
  migration; this transport-level check stays tracked separately.

## Immediate rollback if required

The 2026-10-08 baseline showed explicit SELECT grants to both roles and no
PUBLIC SELECT grant. Restore that exact role-level configuration with:

```sql
begin;
grant select on table public.observed_loot_stats to anon, authenticated;
commit;
```

Re-run the baseline query. Because the view is already
`security_invoker=true`, restoring a GRANT does **not** guarantee access to
underlying rows when those tables deny direct SELECT. Treat any unexpected
runtime failure as a separate incident. Do not change RLS policies to
work around a permission error.

## Release gate

The legacy view privilege migration may be merged after its atomic SQL checks,
PostgreSQL role-simulation and Companion user acceptance pass. Keep the
separate **real HTTP/JWT PostgREST smoke** gate OPEN until validated; the
broader security-readiness milestone is not implied by this change. New
external Discord-bot / third-party read APIs remain explicitly out of scope.

## Production execution ledger (2026-10-08)

- Project: `wow-forever` (`klxhikdlfwgxurdyexdi`), Postgres 17.
- Applied using Supabase migration name `restrict_legacy_public_stats` (version `20261008153743`): **SUCCESS**. The migration is a single atomic PL/pgSQL DO block containing the REVOKE and all privilege assertions; a failing assertion would roll back the statement. The stand-alone smoke SQL remains for repeatable checks.
- Confirmed post-migration ACL: `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`. Both `anon` and `authenticated` `has_table_privilege(..., 'SELECT')` = false; `service_role` = true. View `security_invoker=true` unchanged.
- Pre-/post-migration elevated aggregate counts match: legacy view 374, zones 5, item stats 3, item locations 14, source stats 5, source locations 4, catalog items 137, sources 133. Fixture item 117, creature source 3098 level 1.
- Security advisor run after migration: 7 existing RLS-without-policy INFO findings; 1 authenticated security-definer ingest WARN; 1 leaked-password protection WARN. No new findings reported by the advisor in this scope.
- **Additional acceptance (2026-10-08):** direct SELECT denied under transactional `SET LOCAL ROLE anon` and `authenticated`; catalog/search/stats/location RPC results and ingest EXECUTE boundary remained correct for both roles. User reported PASS for the requested Windows Companion Search, zone change, Stats, Locations/map and Manual Sync checks. HTTP/JWT transport test is **still OPEN** and must not be reported as tested. No new public API was introduced.
- Rollback is documented above and **not executed**.
