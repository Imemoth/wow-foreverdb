# Account System V1 — ownership backend integration suite

Real PostgreSQL + **real GoTrue** (`supabase/auth`), disposable and isolated. It never connects to a real Supabase project; every credential in
these files is test-container-only.

| File | What it proves |
| --- | --- |
| `build-gotrue.sh` | builds the pinned upstream GoTrue (see the header for the pin and the one `go.mod` adjustment) |
| `stack.sh` | `up`: roles, database, real GoTrue (runs its own Auth migrations), repository migrations 0001–0011 as a **non-superuser** migration role with `BYPASSRLS` (stand-in for Supabase `postgres`); `apply`: migration 0012; `down` |
| `00..03_*.sql` | Supabase-like roles, `auth.uid()/role()/jwt()` as shipped by the platform, historical stubs (same as the existing api-security workflow) |
| `01_privileges.test.mjs` | ACLs, SECURITY DEFINER, search_path, VOLATILE guards, closed private tables, existing-function `prosrc`/ACL hashes unchanged |
| `02_live_session.test.mjs` | LS-1..LS-5 and LS-8 (derived from `ACCOUNT_RPC_GUARDS`; a new registry entry fails the suite until covered), against the real `auth.users`/`auth.sessions` tables |
| `03_claims.test.mjs` | claim protocol, LS-6/LS-7, failure shapes, budgets, link status, installation listing, private Guildbook scoping and bounds |
| `04_concurrency.test.mjs` | real parallel transactions: double redeem, replacement races, ingest vs transfer (shared advisory lock), LS-11 (including commit-timestamp ordering), lock timeouts, disconnect atomicity, mixed workload without deadlocks |
| `05_preservation.test.mjs` | row counts and stable hashes of every history table before/after a transfer; stats unchanged and correct; write access moves with ownership |
| `06_gotrue.test.mjs` | **LS-9** and real session semantics with tokens issued by real GoTrue (signup, logout, refresh, ban, delete, confirmation) |
| `07_rollback_recovery.test.mjs` | rehearsal on clones: kill switch, rollback (tables retained / dropped), forward re-apply, operator recovery and its refusals, prune |
| `08_existing_regression.test.mjs` | the repository's existing SQL regression files still pass after 0012 |
| `mutation_check.mjs` | 24 deliberately weakened copies of 0012; every one must be caught by the suite (not part of the PR gate) |

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
