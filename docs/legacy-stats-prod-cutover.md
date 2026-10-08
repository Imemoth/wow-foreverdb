# Legacy stats view: production-only rollout and rollback

Status: **PREPARED, NOT DEPLOYED** (2026-10-08). This procedure applies
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

## Production cutover (explicit approval required)

In **one database transaction**, execute:

```sql
begin;
revoke select on table public.observed_loot_stats
from public, anon, authenticated;

-- Insert and run the full DO-block from:
-- database/tests/legacy_stats_access_smoke.sql

commit;
```

Paste the real assertions between the REVOKE and COMMIT; a SQL comment
does **not** execute the test. If any assertion raises an exception,
ROLLBACK instead of COMMIT. A separate execution of the smoke script is
still useful for verification but would not protect the initial cutover
atomically.

Do **not** apply this migration by automatically merging the PR: a GitHub
merge alone does not execute SQL in Supabase. Do not change the public
search RPCs or upload a new external-facing API.

## Post-cutover gates (before PASS / merge)

1. Repeat the ACL query above and the SQL smoke test. Expect neither `anon`
   nor `authenticated` to have view SELECT, with service_role intact.
2. Data API: GET `/rest/v1/observed_loot_stats?select=*&limit=1` using
   (a) only the anon key, and (b) an anonymous Auth-user JWT. Both must
   reject direct access; check actual HTTP status and body.
3. Confirm the old `items`, `sources`, Search-zone RPCs, item/source
   statistics RPCs and location RPCs still return the same sample results.
4. In the **existing** Companion release, perform Search (including zone
   change), Item/Source Stats, Locations/map details, Manual Sync and
   Auto Sync. Record the test version and evidence; do not create a separate
   build from this SQL-only branch.
5. Re-run Supabase security advisors. Treat unrelated existing findings
   separately, without classifying this narrow task as broader security PASS.

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

Leave the ROADMAP item OPEN until production ACL, Data API, Companion
runtime, and rollback-readiness checks pass. New external Discord-bot /
third-party read APIs remain explicitly out of scope.
