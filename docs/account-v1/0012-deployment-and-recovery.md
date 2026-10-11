# Migration 0012 — deployment, rollback and incident recovery (runbook)

Status: **prepared in PR C; NOT applied anywhere real.** Applying `0012` to the production Supabase project, applying the reserved migration `0010`, changing production ownership records, creating Auth users in production, changing Supabase settings or deploying account functions to a release all require **explicit owner approval** and are outside PR C.

Files:

| File | Purpose |
| --- | --- |
| `database/migrations/0012_account_ownership_claims.sql` | forward-only, idempotent migration (pre-flight, objects, post-apply assertions), one transaction |
| `database/rollback/0012_kill_switch.sql` / `0012_kill_switch_restore.sql` | instant, non-destructive stop / re-enable of all six account RPCs |
| `database/rollback/0012_rollback.sql` | safe rollback: drops functions; drops tables only when all are empty; never moves ownership, never deletes data |
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
4. **Ledger:** record exactly one entry named `account_ownership_claims` (Supabase `apply_migration` does this itself; for SQL-editor/`psql` applications insert it manually: `insert into supabase_migrations.schema_migrations (version, name) values (to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), 'account_ownership_claims')`). Never reuse or renumber `0010`; `0012` may be applied before `0010` (they are independent).
5. Post-apply verification (read-only): the six functions and three guards exist with the expected ACLs (`anon`/`public`/`service_role` cannot execute; `authenticated` can execute the six, nobody the guards); tables empty; `prosrc` hash of every pre-existing function unchanged; one smoke claim in a **throwaway** database, never in production data.
6. No client can use the feature until Companion/website releases enable it; the RPCs are inert for anonymous callers that never start a claim.

## 4. Kill switch (non-destructive)

`database/rollback/0012_kill_switch.sql` revokes `EXECUTE` on all six functions from every client role. Effects: no claim can start or complete, account Guildbook/installation reads and link status stop. **Unchanged:** `installations.owner_user_id`, every link/claim/audit row, every observation, Guildbook and statistics row, and the existing ingest/search/stats RPCs. Lift with `0012_kill_switch_restore.sql`. Use it first in any incident; it is safe to run repeatedly and takes effect for the next PostgREST request (`notify pgrst, 'reload schema'` is sent).

## 5. Rollback

`database/rollback/0012_rollback.sql`: revokes the functions, drops the six RPCs and three guards, then drops the three private tables **only if all of them are empty** (otherwise they are retained, so provenance, claim history and the audit trail survive). It asserts that installation ownership and the row counts of the history tables are unchanged. After it, ingest, search and statistics work exactly as before; already-transferred installations **stay with their registered accounts** (ownership lives in `installations.owner_user_id`, which no rollback touches). Re-applying `0012` afterwards is safe and reconnects to the retained tables (rehearsed in the suite).

**Ledger:** record the rollback as its own entry (e.g. `rollback_account_ownership_claims`) and keep the `account_ownership_claims` entry; do not delete ledger rows.

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

## 8. Known limits and deferred items (see the review record in the PR)

- **Ban/delete race window of one statement.** `FOR SHARE` locks the *session* row only (the specification's choice; also avoiding a lock cycle with GoTrue's own transactions on `auth.users`). A user ban commits without touching the session row, so a ban racing exactly between the unlocked user check and the end of the transaction is not serialised. Deleting a user deletes its sessions (blocked by the share lock) and is covered. Mitigation: bans are rare administrative actions; the claim code is 10 minutes and single use; the previous-owner record and audit allow recovery.
- **Global budget row contention.** The per-UID and global budget rows are charged before the advisory lock (the specified order, shared with ingest). A claim queued behind a long ingest holds its budget rows; `lock_timeout = 5s` bounds the wait and returns `55P03` cleanly.
- **Professions in the private Guildbook** are not exposed: the registry has no professions function (the contract fixes the six RPCs); adding one is a reviewed contract change.
- **Active stolen anonymous bearer** can still start a claim until it is revoked: a documented residual risk of the protocol ([ownership-claim-protocol.md §6](ownership-claim-protocol.md)).
- **Ingest and the read RPCs still only check the JWT** (unchanged V1 behaviour, characterised by a test): a revoked-but-unexpired token can ingest for its own installation until `exp`; it can no longer change ownership.
