# Migration 0012 — deployment, rollback and incident recovery (runbook)

Status update **2026-10-12**: migration `account_ownership_claims` (`0012`) was **APPLIED to the existing private `wow-forever` Supabase project**, recorded by Supabase ledger version `20261012124839`. The pre-existing text below describes the original preparation and the still-mandatory recovery procedures; it is not the current deployment status. **The public site, account activation, ownership transfers and migrations `0010`/`0013` remain untouched.** The owner-run `0012` deployment was executed separately via Supabase-managed migration transaction; it was **not** applied by PR C or PR #53. Future changes to ownership, Auth users, settings, other migrations or releases still require explicit approval. Full disaster-recovery restoration remains untested.

Files:

| File | Purpose |
| --- | --- |
| `database/migrations/0012_account_ownership_claims.sql` | forward-only migration whose body is written idempotently, but which a production ledger will refuse to run twice (pre-flight, objects, post-apply assertions), one transaction |
| `database/rollback/0012_kill_switch.sql` / `0012_kill_switch_restore.sql` | instant, non-destructive stop / re-enable of all six account RPCs |
| `database/rollback/0012_rollback.sql` | safe full rollback: drops functions; drops tables only when all are empty; never moves ownership, never deletes data, never touches the ledger |
| `database/restore/0013_account_ownership_claims_restore.sql` | **ledger-consistent restoration** after a completed, recorded rollback (forward migration, ledger name `account_ownership_claims_restore`) |
| `database/ops/0012_record_migration_ledger.sql` | append-only ledger recorder for steps applied with psql (not needed with `apply_migration`) |
| `database/rollback/0012_recovery_restore_owner.sql` | operator-run, owner-approved restore of **one** installation to its previous owner, with audit |
| `database/ops/0012_prune_account_claims.sql` | bounded retention prune (revoked/expired-pending claims > 7 days, audit > 180 days; never consumed claims) |
| `database/tests/account/` | disposable integration stack (PostgreSQL + **real GoTrue**) and the test suite |

## 1. What 0012 contains (and does not)

Creates: `private.installation_claims`, `private.account_installations`, `private.account_audit` (RLS on, no policy, no privilege for `public`/`anon`/`authenticated`/`service_role`), three private guards (`private.fdb_caller`, `private.fdb_anonymous_caller`, `private.fdb_registered_caller`) and the six registered RPCs (`fdb_account_claim_start`, `fdb_account_claim_redeem`, `fdb_installation_link_status`, `fdb_account_installations`, `fdb_account_guildbook_guilds`, `fdb_account_guildbook_members`).

Does **not**: alter, update or delete any existing table or row; replace any existing function (the migration snapshots `md5(prosrc)` and ACL of every function in `public` and `private` before it starts and aborts if any differs afterwards); touch `0010`; change any Auth/Supabase setting. **Data preservation is an invariant, not a hope:** `public.installations.owner_user_id` stays the single source of truth, and the only data change the account functions ever make to an existing table is that one column on redemption.

## 2. Pre-flight (inside the migration; read-only; raises on failure)

The transaction aborts before creating anything unless:

- if `supabase_migrations.schema_migrations` exists: `fix_observed_drop_rate_denominator` (0011) is recorded and `account_ownership_claims` is not;
- schema `private`, `private.foreverdb_take_budget`, `private.foreverdb_api_gate`, `private.foreverdb_ingest_snapshot_impl_v1`, `public.ingest_foreverdb_snapshot_auth`, `extensions.gen_random_bytes` and `extensions.digest` exist (0009 and pgcrypto);
- the ingest implementation still takes `pg_advisory_xact_lock(hashtextextended(installation, 0))` and keeps the owner check (the shared lock key and "belongs to another authenticated client" rule this migration relies on);
- `auth.users` has `id, is_anonymous, email_confirmed_at, deleted_at, banned_until`; `auth.sessions` has `id, user_id, not_after`;
- the migration role can `SELECT` and `UPDATE` `auth.sessions` (needed for `FOR SHARE`), `SELECT` `auth.users`, is not hidden from `auth.sessions` by row level security, and can actually run `select … from auth.sessions limit 1 for share`;
- it only **reports** (does not fail on) ownerless installations (they can never be claimed).

An empty `auth.sessions` proves little about locking, so the CI suite also locks a real row of the real GoTrue table (LS-11).

## 3. Applying (only after owner approval)

1. Backup/point-in-time marker; announce a short window (the migration is metadata-only and takes seconds; it takes `ACCESS EXCLUSIVE` locks only on the new objects).
2. Dry-run on the **isolated staging project** (never production first): `psql -v ON_ERROR_STOP=1 -f database/migrations/0012_account_ownership_claims.sql`, then the full suite of this PR against staging data copy if available.
3. Apply as the migration role (Supabase `postgres`). Because the migration is one transaction with post-apply assertions, a failure leaves nothing behind.
4. **Ledger (append-only).** Record exactly one entry named `account_ownership_claims`: Supabase `apply_migration` does this itself; for `psql`/SQL-editor applications run `psql -X -v ON_ERROR_STOP=1 -v name=account_ownership_claims -f database/ops/0012_record_migration_ledger.sql` (it only INSERTS, refuses duplicates and out-of-order names). **0012's pre-flight refuses to run again once that entry exists; this is deliberate and is never bypassed.** Never reuse or renumber `0010`; `0012` may be applied before `0010` (they are independent).
5. Post-apply verification (read-only): the six functions and three guards exist with the expected ACLs (`anon`/`public`/`service_role` cannot execute; `authenticated` can execute the six, nobody the guards); tables empty; `prosrc` hash of every pre-existing function unchanged; one smoke claim in a **throwaway** database, never in production data.
6. No client can use the feature until Companion/website releases enable it; the RPCs are inert for anonymous callers that never start a claim.

## 4. Kill switch (non-destructive)

`database/rollback/0012_kill_switch.sql` revokes `EXECUTE` on all six functions from every client role. Effects: no claim can start or complete, account Guildbook/installation reads and link status stop. **Unchanged:** `installations.owner_user_id`, every link/claim/audit row, every observation, Guildbook and statistics row, and the existing ingest/search/stats RPCs. Lift with `0012_kill_switch_restore.sql`. Use it first in any incident; it is safe to run repeatedly and takes effect for the next PostgREST request (`notify pgrst, 'reload schema'` is sent).

## 5. Full rollback and ledger-consistent restoration

Two different procedures exist and must not be confused: the **kill switch** (section 4: nothing dropped, no ledger entry, lifted with `0012_kill_switch_restore.sql`) and the **full rollback + restoration** below.

### 5.1 Full rollback

`database/rollback/0012_rollback.sql`: revokes the functions, drops the six RPCs and three guards, then drops the three private tables **only if all of them are empty** (otherwise they are retained, so provenance, claim history and the audit trail survive). It asserts that installation ownership and the row counts of the history tables are unchanged. After it, ingest, search and statistics work exactly as before; already-transferred installations **stay with their registered accounts** (ownership lives in `installations.owner_user_id`, which no rollback touches). **It does not read or write the migration ledger: the `account_ownership_claims` entry stays.** Then record the rollback (append-only): `psql -X -v ON_ERROR_STOP=1 -v name=rollback_account_ownership_claims -f database/ops/0012_record_migration_ledger.sql` (or let your apply tool record it).

### 5.2 Restoration after a recorded rollback (the only supported way back)

Because the ledger keeps `account_ownership_claims`, **re-running 0012 is refused** by its unchanged pre-flight (tested: `09_ledger_rollback_restore`). The way back is a **new forward migration with its own ledger name**: `database/restore/0013_account_ownership_claims_restore.sql` (`0013` was checked against every remote branch and the reserved `0010`; it is unused). Order:

1. `0012` applied and recorded (`account_ownership_claims`).
2. Full rollback (5.1) and its ledger record (`rollback_account_ownership_claims`).
3. Apply `0013` (owner approval needed anywhere real). Its pre-flight READS the ledger and refuses unless 0012 and the rollback are recorded and the restoration is not; refuses if any account function still exists (use the kill-switch restore instead) and if the private tables are only partially present; verifies the retained tables' STRUCTURE (column names and types, primary keys, the `code_hash` unique constraint, the one-pending partial unique index, the status and audit-event CHECKs, foreign keys, row level security on, no policy, no trigger, owner = migration role; a drifted table is refused because `create table if not exists` would otherwise keep it silently); then repeats the dependency, `auth.*` and privilege checks of 0012.
4. Record `account_ownership_claims_restore` (only if the applying tool does not).

What 0013 does: recreates the three guards and six RPCs with **byte-identical** 0012 bodies (sections 2-6 of both files are identical; a unit test enforces it), creates the private tables only if the rollback dropped them (retained tables and all their rows are untouched), re-grants `EXECUTE` to `authenticated` only, and runs the same in-migration post-assertions (ACLs, SECURITY DEFINER, search_path, VOLATILE guards, closed private tables, every pre-existing function's `prosrc`/ACL unchanged, exactly nine account functions). It never moves ownership, never deletes or rewrites a row, never writes the ledger, and aborts with nothing applied if any assertion fails. It lives in `database/restore/` (not `database/migrations/`) because the account conformance gate lints `database/migrations` as one unit, where a second definition of the same functions would be a duplicate; the restore file is linted on its own (`web/tests/unit/account-restore-migration.test.ts`).

**Tested behaviour** (ledger fixture `supabase_migrations.schema_migrations`, `09_ledger_rollback_restore.test.mjs`):

- *Scenario A, no transfers:* record 0012; re-running 0012 is refused; rollback drops the empty tables and keeps the ledger entry; restore is refused until the rollback is recorded and refused with partially present tables; 0013 restores nine functions (identical bodies, exact ACLs) and three empty tables; a full claim cycle works; a second restore is refused; the ledger only gained the three account entries.
- *Scenario B, existing transfers made through the authenticated RPCs:* rollback retains the tables; owners, observation/Guildbook hashes, link rows (provenance), claims and audit rows are identical before and after rollback and after restoration; while rolled back the account API is gone but ingest still works for the registered owner and is closed to the former owner; after restoration authorization, Guildbook, ingest and new claims work; the kill switch is a separate, ledger-free procedure.

### 5.3 One restoration cycle per ledger history (limit)

The ledger names are unique, so the cycle `account_ownership_claims` -> `rollback_account_ownership_claims` -> `account_ownership_claims_restore` can happen **once**. After the restore is recorded, a second full rollback would leave no ledger-consistent way back (0012 and 0013 are both refused by their pre-flights). Therefore `0012_rollback.sql` refuses to run in that state unless `-v acknowledge_second_cycle=yes` is given, and the correct tool for a second incident is the **kill switch**. If a second full rollback is ever genuinely required, a new restoration migration with new ledger names (`0014`, cloned from 0013, with its own conformance test) must be prepared and reviewed first. The recorder (`0012_record_migration_ledger.sql`) also ties the ledger to the database (the nine functions must exist to record `account_ownership_claims` / `account_ownership_claims_restore`, and must be gone to record the rollback) and serialises with an advisory lock. Pending claims that were retained by a rollback and have not expired (10 minutes) become redeemable again after the restore; every 0012 check (owner, issuing session, initiator) still applies to them.

In a **disposable database without a ledger** the 0012 body is idempotent and can be re-applied; the repository tests still do that in two places (`07_rollback_recovery`, labelled "no ledger entry", and the CI re-apply step) to prove the body, but **a production ledger will not allow it** and no procedure here relies on it.

## 6. Incident recovery: mistaken or malicious claim (operator-approved, never automatic)

Ownership is **never** reversed automatically, by a rollback, by the kill switch or by pruning. A restore is a deliberate, audited, per-installation operation.

Preconditions (all required before running anything):

1. The project owner approved restoring the **specific** installation in writing (record the reference).
2. The kill switch was considered/applied if the incident may be ongoing.
3. The operator read the link row: `select installation_id, account_uid, previous_owner_uid, linked_at, claim_id from private.account_installations where installation_id = '<id>'` and the audit rows `select * from private.account_audit where installation_id = '<id>' order by id` (no codes, emails or IPs are stored; correlate with Auth logs if needed).
4. The previous owner identity still exists as an active **anonymous** user (the script verifies this; if the identity is gone, restoring is meaningless and the case needs a manual decision).

Run, as the migration role:

```
psql -X -v ON_ERROR_STOP=1 \
  -v installation_id='<installation id>' \
  -v expected_account_uid='<current owner uid from the link row>' \
  -v operator='<operator name>' -v approval_ref='<ticket/approval reference, no secrets>' \
  -f database/rollback/0012_recovery_restore_owner.sql
```

In one transaction, under the same per-installation advisory lock ingest takes, it: verifies the link row exists and `owner_user_id` equals the linked account **and** `expected_account_uid`; verifies the previous owner; sets `owner_user_id` back; deletes the link row (the claim row stays `consumed` as history); inserts an `ownership_restored` audit row with `detail = 'operator=…; approval=…'`; recomputes counts and hashes of the installation's item/source/location/Guildbook rows and **aborts if anything changed**. It refuses on any mismatch, malformed input, missing link or missing variables. It never deletes or alters observations.

Recovery audit requirements: every restore leaves exactly one `ownership_restored` row (operator and approval reference), the preserved `consumed` claim, and the operator's incident record. The `ownership_restored` event type and the `detail` column extend the schema of the protocol specification for this purpose only; the account functions never write `detail`.

After recovery the previous owner's Companion sees `owned` again (the `transferred` signal is derived from the link row, which is gone), the account no longer lists the installation, the account's token can no longer ingest it, and the installation can be claimed again through the normal protocol. The runbook is **rehearsed in the suite** (`07_rollback_recovery.test.mjs`), including every refusal path.

## 7. Retention

`database/ops/0012_prune_account_claims.sql` (operator or scheduled): deletes revoked and never-redeemed expired claims older than 7 days (each under the installation advisory lock, at most 500 per run) and audit rows older than 180 days. **Consumed claims are never pruned**: the link row references them and the `transferred` signal is derived from the link row, which has no expiry.

## 8. Auth versions and integrated acceptance

The web-auth suite (PR #49, `account-web-auth.yml`) and this suite both build real GoTrue from the same pinned upstream tag, **`supabase/auth v2.197.0`** (`GOTRUE_TAG` / `database/tests/account/build-gotrue.sh`, which also verifies the tag still resolves to commit `4eee58f2…`; bump both together; the web-auth workflow `account-web-auth.yml` is on main since PR #49 and uses the same tag). Earlier revisions of this PR were verified against upstream master of 2026-09-22 and the gap is closed by re-running the whole suite on `v2.197.0` (the session/refresh-token semantics the guards depend on are covered by LS-9, LS-9b). Neither of those two suites runs PostgREST, Kong or the hosted Supabase Auth. PR E adds the third check `Account end-to-end (GoTrue + PostgREST)` (real GoTrue + real PostgREST v12.2.12 + this migration, [web/tests/e2e-stack](../../web/tests/e2e-stack/README.md)), which shows integrated PostgREST behaviour in CI; **hosted-GoTrue/PostgREST version equality, the hosted gateway and staging acceptance are still NOT shown.** Integrated staging acceptance (owner-provisioned, isolated Supabase project) must use `v2.197.0`-equivalent hosted Auth (owner to confirm the hosted Auth version, which Supabase manages) and must repeat LS-1..LS-9b through real PostgREST (including `db-tx-end = commit`).

## 9. Known limits and deferred items (see the review record in the PR)

- **Ban/delete race window of one statement.** `FOR SHARE` locks the *session* row only (the specification's choice; also avoiding a lock cycle with GoTrue's own transactions on `auth.users`). A user ban commits without touching the session row, so a ban racing exactly between the unlocked user check and the end of the transaction is not serialised. Deleting a user deletes its sessions (blocked by the share lock) and is covered. Mitigation: bans are rare administrative actions; the claim code is 10 minutes and single use; the previous-owner record and audit allow recovery.
- **Budget rows.** The per-UID budget row is charged before the advisory lock (the order ingest uses); the global ceiling after it, so a claim queued behind a long ingest cannot stall unrelated claims. `lock_timeout = 5s` bounds the wait and returns `55P03` cleanly (its budget charge rolls back).
- **Claim-feature denial of service (threat A23, accepted).** Anonymous accounts are free; about 20 of them exhaust the global `claim_start` ceiling (60 per 300 s) and block claiming (never ingest or reads) until the window passes. The ceilings are alarms: monitor `private.foreverdb_api_budgets` rows `claim_%` and audit growth (every failed redeem writes an audit row; run the prune script regularly; there is no scheduler in V1). A launch spike can also trip the ceiling.
- **Audit retention vs late detection.** Pruning removes audit rows after 180 days, including `claim_redeemed` / `ownership_restored`; link rows (with `previous_owner_uid`) are never pruned, so recovery stays possible.
- **Deployment assumptions the database cannot enforce** (verify on staging): PostgREST must commit RPC transactions (`db-tx-end = commit`, not `commit-allow-override`; with override a client could send `Prefer: tx=rollback` to keep every counter from persisting); Supabase **Confirm email must be on** (the registered guard trusts `email_confirmed_at`); there is no `aal` check, so MFA-enrolled users at `aal1` can read their own private Guildbook; the hosted migration role must hold `UPDATE` on `auth.sessions` (the pre-flight checks it); installation ids outside `^[A-Za-z0-9][A-Za-z0-9._:-]*$` (ingest accepts any 1-128 characters) can never be claimed or read through the account API; ownerless legacy installations remain adoptable by the first ingest (existing behaviour).
- **Function-level `statement_timeout` is not set** (inert in PostgreSQL); rely on the API role's timeout.
- **Professions in the private Guildbook** are not exposed: the registry has no professions function (the contract fixes the six RPCs); adding one is a reviewed contract change.
- **Active stolen anonymous bearer** can still start a claim until it is revoked: a documented residual risk of the protocol ([ownership-claim-protocol.md §6](ownership-claim-protocol.md)).
- **Ingest and the read RPCs still only check the JWT** (unchanged V1 behaviour, characterised by a test): a revoked-but-unexpired token can ingest for its own installation until `exp`; it can no longer change ownership.
