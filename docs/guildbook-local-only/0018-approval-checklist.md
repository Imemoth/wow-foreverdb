# Migration 0018: owner approval checklist and evidence pack

**Status: prepared for owner review. NOTHING in this document has been executed against any real project. The server migration and the historical
cleanup are two distinct production approvals; neither is granted, and neither may be run by CI, by an assistant, or as a side effect of another step.**
Companion documents: [server-deployment-runbook.md](server-deployment-runbook.md) (procedure and SQL), [historical-guildbook-data.md](historical-guildbook-data.md)
(inventory and cleanup), [db-changes.md](db-changes.md) (what changed relative to #112, forward-compatibility with 0016/0017).

## A. Which project (identity must be proven before ANY database action)

| | Private application project (target of 0018) | Public-read project (NOT a target) |
| --- | --- | --- |
| Reference | `klxhikdlfwgxurdyexdi` (name `wow-forever`) | `chcoypkjzxfznsqmmbrq` |
| Holds | accounts (Auth), private observation tables, the Guildbook tables, `private.*` | published aggregate read model only; no `private` schema, no Guildbook tables |
| Evidence in this repo | `docs/0.7-zone-only-database-browse.md:132`, `docs/0.8-api-security-hardening.md:217`, `docs/account-v1/architecture.md:148`, hard-coded in `companion/.../CompanionSettings.cs`; the CI "Supabase Preview" integration also points at it | `docs/web/public-beta-release.md` / `AZERDEX_READ_DB_URL` |

Rules (all must be true, recorded in the change record):
1. The dashboard URL, the connection string and the Management API response all show `klxhikdlfwgxurdyexdi`. A `chcoypkjzxfznsqmmbrq` string anywhere stops the procedure.
2. First statement of every session is read-only and compares to the table above: `select current_database(), (select count(*) from information_schema.schemata where schema_name = 'private') as has_private_schema;` The private project has the `private` schema and `public.installation_guilds`; the public-read project does not. Mismatch: stop.
3. No one runs a statement against `klxhikdlfwgxurdyexdi` before the owner has granted **Approval 1 (read-only preflight)** below. This task did not.

## B. Three distinct approvals (each needs its own reference; none implies another)

| # | Approval | Scope | Status |
| --- | --- | --- | --- |
| 1 | Read-only production preflight and historical inventory | `SELECT` only: runbook section 1 and `guildbook_historical_inventory.sql` (counts only) | **not requested/granted** |
| 2 | Apply migration 0018 to production | exactly the file and hash in section C, after the staging evidence in section D | **not requested/granted** |
| 3 | Historical Guildbook cleanup | `guildbook_historical_cleanup.sql`, dry run first, verified backup, own change record | **not requested/granted** |

## C. Exact artefacts (immutable once approved)

Hashes are SHA-256 over the file with line endings normalised to LF (identical on Windows and Linux). `web/tests/unit/guildbook-approval-pins.test.ts` recomputes them in CI: **editing any of these files fails that test until this table is updated, which restarts the review and invalidates any approval given for the old hash.**

| File | SHA-256 (LF-normalised) |
| --- | --- |
| `database/migrations/0018_disable_guildbook_cloud_sync.sql` | `976aea6957c06710f9f0cfb1027eb66284b7a614f1cea979952727966e2250ee` |
| `database/ops/guildbook_local_only_reassert.sql` | `79eadc37bce093863b652e5b3155def8e991bd2596faff29b3752e27fed23683` |
| `database/ops/guildbook_historical_inventory.sql` | `0f69ad97d85f24ca47915460a73080235eceb23e01c73384c623cdd7c375930f` |
| `database/ops/guildbook_historical_cleanup.sql` | `76bb50a3b8ae60d3ba19ee26f5495db48a07da8a874e9f3d036e1ad46da4274a` |
| `database/rollback/0018_restore.sql` | `f27c37c2d3f8009a3ca118728bfa8c2bb95b25f3ca7d7e89948d2d170e284557` |

At approval time record: the git commit SHA being deployed (`git rev-parse HEAD`), the PR number, and re-run the hash command from a clean checkout of that commit:
`node -e "const c=require('crypto'),fs=require('fs');console.log(c.createHash('sha256').update(fs.readFileSync(process.argv[1],'utf8').replace(/\r\n/g,'\n')).digest('hex'))" database/migrations/0018_disable_guildbook_cloud_sync.sql`

## D. Evidence required BEFORE Approval 2 (to be attached; none exists yet for production)

| # | Item | How | Evidence to attach | Done |
| --- | --- | --- | --- | --- |
| D1 | Production ledger state | Approval 1 only: runbook 1.1 | ledger rows for 0011, 0012, 0014, 0015 present, `disable_guildbook_cloud_sync` absent; **0010 is documented as prepared-not-applied: record its actual state** | no |
| D2 | Production ingest original | runbook 1.2 | the three booleans all `true` | no |
| D3 | Staging parity | compare staging ledger and the function/ACL catalog hash with production (read-only both) | identical migration set 0001-0015; any difference explained | no |
| D4 | Successful staging application | apply the exact file (hash C) on **staging** with the migration role and `lock_timeout=10s` | psql transcript, no error; post-checks D6 pass | no |
| D5 | Backup and tested recovery | runbook section 2: PITR/backup confirmed for the production project, encrypted export of the three Guildbook tables to a private location (never the repo, GitHub, CI), restored into a scratch database and row counts compared | restore point time, export SHA-256, scratch-restore counts equal to production counts, destruction date | no |
| D6 | API permission verification | after staging apply, call through the real PostgREST with the publishable key and a registered user token: every `fdb_account_guildbook_*` returns 401/403/404 (never 200); `fdb_account_installations` still 200 | table of status codes per role (anon, anonymous user, registered user, service_role) | no |
| D7 | Legacy Companion ingest compatibility | staging: post an old-shaped payload (with `guilds`) through `ingest_foreverdb_snapshot_auth` and `fdb_device_ingest` | observation rows written; **zero** new guild/member/profession rows; existing rows unchanged (fingerprint) | no |
| D8 | CI evidence on the exact commit | the PR's checks incl. "Account ownership SQL + real GoTrue", "AzerDex welcome outbox SQL", "Account end-to-end", "Account web auth" | all green for the commit in C | **see PR #143** |
| D9 | Companion release plan | the new Companion build, its acceptance (interactive Windows + real WoW Forever client), and the rollout order (D1 in the runbook) | owner decision recorded | no |

## E. Apply (Approval 2 only) and verify

1. Maintenance window not required (catalog-level, short locks). `PGOPTIONS='-c lock_timeout=10s'`; migration role only; run the exact file once.
2. Post-checks (runbook section 4): grants closed for all four API roles on every `guildbook` function; wrapper in place (`prosrc` contains `fdb_public_snapshot`); marker row present; **row fingerprints of the three Guildbook tables identical to the pre-apply capture** (0018 asserts this itself and aborts otherwise); a synthetic old-style ingest on a throwaway installation id stores observations and no guild rows (delete that synthetic installation afterwards through the documented path only if the owner agreed; otherwise leave it).
3. Observation ingestion health: ingest success rate and `foreverdb_api_budgets` behaviour for the next hour (runbook section 5); no rise in `ingest` errors.
4. Monitoring afterwards: weekly `guildbook_historical_inventory.sql` counts must not grow (`installations_with_guild_rows_updated last_24h` must be 0 after the apply; non-zero means a path that is still writing guild rows: stop and investigate); `database/tests` guard test in CI keeps later migrations from replacing the wrapper.

## F. Emergency recovery that does not re-enable Guildbook cloud processing unnecessarily

0018 changes no row, so there is **no data rollback**. If something is wrong after the apply, use this ladder and stop at the first rung that fixes it:
1. **Observation ingest errors:** diagnose first (PostgREST schema cache reload, `lock_timeout`, a payload shape the legacy body rejects: the wrapper adds no checks of its own). Fix FORWARD with a reviewed patch to the wrapper only (it must keep calling `fdb_public_snapshot`). This keeps the kill switch on.
2. **A function was re-granted by accident (for example after `database/rollback/0012_kill_switch_restore.sql`):** run `database/ops/guildbook_local_only_reassert.sql`. It only closes, and it refuses when 0018 is not active (controlled message, no catalog error).
3. **Last resort only, with the owner's explicit written agreement that old Companions will store Guildbook again:** `database/rollback/0018_restore.sql` with `scope=ingest` (removes the projection). It deletes no data and requires a confirmation token, operator and approval reference. `scope=reads` (re-open the legacy read RPCs) is never needed for ingest recovery; do not use it. Re-assert as soon as the cause is fixed.
Record every rung used, with time and reference.

## G. Documents to change with the rollout (so no document overstates or understates protection)
- `web/src/components/PrivacyContent.tsx`, section "Older Companion versions still installed": today it says older versions can still upload and that the server does not yet discard it. **When 0018 is applied in production**, change it to say the server discards Guildbook data from every Companion version on arrival and that historical rows remain until the cleanup; update `web/tests/unit/companion-disclosure.test.ts` in the same change (the test currently forbids the claim).
- After the cleanup (Approval 3) **and its verification** (runbook/historical document, zero rows, evidence recorded): only then may the notice say historical rows were deleted, and the test file that forbids that claim must be updated together with a completed-cleanup record. Backups and provider logs keep data until their retention expires: say so.
- The Companion/addon version and changelog for the local-only build (owner decision; no installer was built here).

## H. Old versus new Companion (what each does, exactly)
| Actor | Sends Guildbook? | Server stores it? |
| --- | --- | --- |
| New Companion (this PR) | **No**: explicit public projection plus a transport allowlist that refuses anything else | n/a |
| Old Companion, **before** 0018 is applied | Yes (whole snapshot) | **Yes**, privately (current production behaviour) |
| Old Companion, **after** 0018 is applied | Yes (it cannot know) | **No**: dropped before persistence; its observations are stored normally |
| Historical rows (already stored) | n/a | **Yes**, unchanged by 0018, until Approval 3 |
