# Account System V1 — ownership backend integration suite

Real PostgreSQL + **real GoTrue** (`supabase/auth`), disposable and isolated. It never connects to a real Supabase project; every credential in
these files is test-container-only.

| File | What it proves |
| --- | --- |
| `build-gotrue.sh` | builds real GoTrue from the pinned upstream release tag `v2.197.0` (the same tag as the web-auth suite) |
| `stack.sh` | `up`: roles, database, real GoTrue (runs its own Auth migrations), repository migrations 0001–0011 as a **non-superuser** migration role with `BYPASSRLS` (stand-in for Supabase `postgres`); `apply`: migration 0012; `down` |
| `00..04_*.sql` | Supabase-like roles, `auth.uid()/role()/jwt()` as shipped by the platform, historical stubs (same as the existing api-security workflow), and a realistic `supabase_migrations.schema_migrations` ledger fixture (0012 NOT recorded) |
| `01_privileges.test.mjs` | ACLs, SECURITY DEFINER, search_path, VOLATILE guards, closed private tables, existing-function `prosrc`/ACL hashes unchanged |
| `02_live_session.test.mjs` | LS-1..LS-5 and LS-8 (derived from `ACCOUNT_RPC_GUARDS`; a new registry entry fails the suite until covered), against the real `auth.users`/`auth.sessions` tables |
| `03_claims.test.mjs` | claim protocol, LS-6/LS-7, failure shapes, budgets, link status, installation listing, private Guildbook scoping and bounds |
| `04_concurrency.test.mjs` | real parallel transactions: double redeem, replacement races, ingest vs transfer (shared advisory lock), LS-11 (including commit-timestamp ordering), lock timeouts, disconnect atomicity, mixed workload without deadlocks |
| `05_preservation.test.mjs` | row counts and stable hashes of every history table before/after a transfer; stats unchanged and correct; write access moves with ownership |
| `06_gotrue.test.mjs` | **LS-9** and real session semantics with tokens issued by real GoTrue (signup, logout, refresh, ban, delete, confirmation) |
| `07_rollback_recovery.test.mjs` | rehearsal on clones: kill switch, rollback (tables retained / dropped), re-applying the body on a ledger-less database, operator recovery and its refusals, prune |
| `09_ledger_rollback_restore.test.mjs` | ledger-backed rollback and restoration through `database/restore/0013_*`: scenarios A (no transfers) and B (existing transfers), 0012 refusal while recorded, append-only ledger, kill switch as a separate procedure |
| `08_existing_regression.test.mjs` | the repository's existing SQL regression files still pass after 0012 |
| `11_legacy_guildbook_paths.test.mjs` | migration 0018 (Guildbook is Companion-local only) on a **clone**: legacy anonymous/registered ingest persists observations but no Guildbook, pre-existing rows are neither erased nor exposed, every Guildbook RPC is closed (42501), guard table private, refusals (missing/foreign ingest body, ledger) |
| `12_guildbook_migration_order.test.mjs` | 0018 in three orders on clones (0012>0014>0015>0018, ...>0018>0015, 0012>0018>0014>0015): same final privilege state, device/public ingest observation-only, 0014/0015/0018 re-apply idempotent, 0012 re-apply refused |
| `13_guildbook_restore_and_reassert.test.mjs` | `database/rollback/0018_restore.sql` (refuses without the exact confirmation; scopes reads / ingest / all) and `database/ops/guildbook_local_only_reassert.sql`, on clones |
| `14_guildbook_historical_cleanup.test.mjs` | `database/ops/guildbook_historical_inventory.sql` (read-only) and `guildbook_historical_cleanup.sql` (dry run by default; execute needs confirmation + backup reference + active kill switch; only Guildbook rows of the scope; bounded, idempotent, counts-only output) on clones |
| `mutation_check.mjs` | 27 deliberately weakened copies of 0012; every one must be caught by the suite (not part of the PR gate) |

The 0018 suites (11-14) never apply 0018 to the shared database: it would invalidate the exact-function-set assertions of 01/02/07/09 and of the enrollment suite. They clone the integration database (whatever the job layout provides: 0012 only, 0012 + 0015, or 0012 + 0014 + 0015) and apply what they need on the clone.

Only PostgREST is emulated: `harness.mjs` verifies the HS256 signature and `exp` and hands the claims to the database exactly as PostgREST does
(`SET LOCAL ROLE authenticated` + `request.jwt.claims`). LS-10 (the conformance tripwire) runs in `web/tests/unit/account-migration-conformance.test.ts`.

```bash
# needs: PostgreSQL 16 with track_commit_timestamp=on (LS-11 compares commit timestamps), Go, Node 22+, `npm ci` in web/
export PGHOST=127.0.0.1 PGPORT=5432 PGUSER=<superuser of the DISPOSABLE cluster> PGPASSWORD=...
database/tests/account/build-gotrue.sh
database/tests/account/stack.sh up
database/tests/account/stack.sh apply
FDB_REQUIRE_GOTRUE=1 node --test --test-concurrency=1 database/tests/account/*.test.mjs
database/tests/account/stack.sh down
```

`FDB_REQUIRE_GOTRUE=1` turns "GoTrue unreachable" from a skip (reported as **BLOCKED**) into a failure; CI sets it.
