# Historical Guildbook data in the cloud: inventory and cleanup plan

**Status: a plan and two scripts for review. NOT executed. The cleanup script deletes data irreversibly (except from a backup) and may be run only by the
project owner, only after separate written authorisation, and never by CI, an assistant or a migration runner.**

Owner policy (final): Guildbook data stays exclusively on the user's computer. Migration 0018 stops new cloud Guildbook data and closes every read path but
**deliberately deletes nothing** (see `server-deployment-runbook.md`). This document covers what is already there.

## 1. What the data is

The Companion uploaded the whole addon export, including the guild roster of the player's characters, to the private Supabase project. Per guild: guild key,
guild name, realm, capture time; per member: guid, character name, class, level, rank, zone, online flag, hours since last online; per member and profession: skill line,
name, skill, max skill, source. That is **other players' personal data** (character names with guild membership, ranks, activity), tied to an installation id
and, for registered or claimed installations, to an account.

## 2. Every structure that could hold or expose Guildbook data

Evidence is from the RC working tree (`file:line`); "searched" means a repository-wide search for `guild` (case-insensitive) over `database/`, `supabase/`,
`publisher/`, `installer/` and `scripts/` found nothing further.

| # | Structure | Holds / exposes Guildbook? | Evidence | Covered by cleanup |
|---|-----------|----------------------------|----------|--------------------|
| 1 | `public.installation_guilds` | **Holds** (guild key, name, realm, captured_at) | `database/migrations/0005_guildbook_v1.sql:5` | yes |
| 2 | `public.installation_guild_members` | **Holds** (guid, character name, class, rank, zone, level, online) | `0005_guildbook_v1.sql:16`, FK to 1 at `:36` | yes |
| 3 | `public.installation_guild_professions` | **Holds** (per-member professions) | `0005_guildbook_v1.sql:43`, FK to 2 at `:65` | yes |
| 4 | Indexes on 2 and 3 (`installation_guild_members_name_idx` on `lower(member_name)`, `installation_guild_professions_skill_idx`) | Index keys contain the same values; removed with the rows (after vacuum) | `0005_guildbook_v1.sql:73-82` | rows yes; bloat/vacuum is storage, see 3 |
| 5 | Legacy ingest body (writer) | Writes 1-3 from `p_snapshot->'guilds'`; also deletes and rebuilds them on every snapshot | `0005_guildbook_v1.sql:202-208` (delete), `:232`, `:264`, `:316` (insert); wrapped by `0009_api_security_rate_limits.sql:337-383`; called by `0014_zero_touch_enrollment.sql:741` | n/a (made observation-only by 0018) |
| 6 | Guildbook read RPCs `fdb_account_guildbook_guilds` / `_members` (reader) | Expose 1-2 to the verified registered owner | `0012_account_ownership_claims.sql:553-584`, `:586-630`; grants `:649-657` | n/a (revoked by 0018) |
| 7 | Installation list RPC | Exposes a **count** of guild rows per installation (`guild_count`) | `0012_account_ownership_claims.sql:528-551` (count at `:544`) | count becomes 0 after the cleanup; not redefined by 0018 |
| 8 | Restore/rollback scripts that re-create or re-grant 6 and 7 | Could re-open readers | `database/restore/0013_account_ownership_claims_restore.sql:628-732`; `database/rollback/0012_kill_switch_restore.sql:10-11` | n/a; `guildbook_local_only_reassert.sql` re-closes |
| 9 | `public.map_asset_diagnostics.details` (free-form `jsonb`) | **Not by design.** Repository code writes map-resolver fields only; the column is unconstrained, so the inventory counts rows whose `details` text mentions `guild` | `database/sql/map_asset_diagnostics.sql:21`; writer `companion/ForeverDB.Companion/Services/MapAssetDiagnosticUploader.cs:26,122` | no (inventory only; decide separately if a count is non-zero) |
| 10 | Private projection export / `foreverdb_projection_reader` | **No.** Asserts the reader has no SELECT on 1-3 | `database/private-export/0010_public_projection_export.sql:16,213-215` | n/a |
| 11 | `publish-observations` Edge Function and `publisher/` | **No** reference to guild data (aggregated statistics only) | searched | n/a |
| 12 | Public read model `pub.*` | **No** guild columns | `database/public-read/migrations/*` searched (only a search *term* in a test: `public-read/tests/public_read_model_security.sql:44`) | n/a |
| 13 | Views, materialized views, triggers, publications on 1-3 | None in the repository (`observed_loot_stats` view is item statistics, `0001_initial_schema.sql:151`); the account suite asserts zero triggers on `public` tables (`database/tests/account/05_preservation.test.mjs:148`). A hosted project could differ, so the inventory counts them live | inventory | n/a |
| 14 | DSAR / ops scripts that read or delete by installation | Read counts / cascade-delete installations (and thereby 1-3) | `docs/gdpr/dsar-runbook.md:61-62,100`; `database/ops/0012_single_project_preservation_baseline.sql:10-17` (count + hash only) | n/a |
| 15 | CI stubs | Empty stand-in tables only | `scripts/private-export-hosted-compat.sh:26-33` | n/a |
| 16 | **Sibling-branch** account-scoped tables `private.account_guildbook_{captures,guilds,members,professions}` | Would hold a **copy** of 1-3 for claimed installations if that branch's 0016 were ever applied; **absent from this RC** | `git show origin/feature/guildbook-local-only:database/migrations/0016_account_scoped_guildbook.sql` (creates the tables; copies existing rows in the "compatibility transition") | no; the inventory reports them, and the cleanup **refuses** to execute while they are non-empty unless acknowledged |
| 17 | **Provider backups / PITR** | Contain deleted rows until the backup ages out | Supabase plan setting (not visible from SQL) | no; see section 5 |
| 18 | **Provider and application logs, `pg_stat_statements` text** | Statement text can contain parameter values depending on logging settings; request bodies are not logged by default | owner must check the project's log and statement-logging settings | no; see section 5 |
| 19 | Exports made by the owner (DSAR, the section 4 backup) | Hold copies by definition | owner's records | no; destroy on the planned date |
| 20 | The user's own computer (addon SavedVariables, Companion local database) | Holds the data by design (this is the intended home) | n/a | n/a |

Rows 1-3 are the only cloud tables the repository defines that hold Guildbook data. Rows 17-19 are the ones that are easy to forget.

## 3. Inventory (read-only)

`database/ops/guildbook_historical_inventory.sql` reports, as counts and aggregates only: ledger and kill-switch state, row counts and sizes of the three tables
(including estimated dead tuples), guilds per installation (min/avg/max), the date range (`updated_at`, raw `captured_at`, installation first/last seen), how many
installations received Guildbook rows in the last 24 hours / 7 / 30 days and from which addon/schema versions (the "is an old Companion still uploading?" signal),
the owner class of the affected installations (ownerless / anonymous / registered / account-linked / with a live device), and the other structures of rows 7-9, 13
and 16 above. It runs in a `READ ONLY` transaction and prints no name, guid, installation id or user id. Run it before 0018, after 0018, and after the cleanup;
the three outputs are the evidence trail.

## 4. Cleanup (owner-run, irreversible)

`database/ops/guildbook_historical_cleanup.sql` is a psql script, **dry run by default**.

Preconditions, in order (each is checked or documented, none is skipped):

1. 0018 is applied on that project and the post-checks of the runbook passed (the script refuses to execute otherwise: old Companions would upload the data again).
2. The Companion release that stops sending Guildbook is out, or the owner accepts that old Companions' Guildbook is dropped server-side.
3. A verified backup exists (runbook section 2): restore point, table-level export encrypted, scratch-restore counts compared, destruction date set.
4. A dry run was reviewed: `psql ... -v scope=all -f database/ops/guildbook_historical_cleanup.sql` reports, as counts, what would be deleted (guild/member/profession rows,
   installations in scope, owner classes, how many remain for the next batch). The dry run is `begin read only` and rolled back.
5. Separate written owner authorisation for the execute run (reference number).
6. Account-scoped tables (row 16) are absent or empty. Otherwise decide how to handle the copy first; the script refuses unless `-v ack_account_scoped=1`.

Execute (example; every variable is required):

```bash
psql -X -v ON_ERROR_STOP=1 -v mode=execute -v scope=all \
     -v confirm='DELETE-HISTORICAL-GUILDBOOK-DATA' \
     -v backup_ref='<change-record id / encrypted-export SHA-256 prefix; no secrets>' -v operator='<name>' \
     -v max_installations=200 -f database/ops/guildbook_historical_cleanup.sql
```

What it guarantees (and `database/tests/account/14_guildbook_historical_cleanup.test.mjs` verifies on clones):

- One transaction with `lock_timeout 5s` and `statement_timeout 120s`; any failed verification aborts and commits nothing.
- Deletes **only** rows of the three Guildbook tables, children first (professions, members, guilds), one installation at a time while holding the same advisory lock
  ingest, claims, device ingest and the 0018 wrapper use. An installation that is busy right now is skipped and counted (`skipped_busy`), never waited for.
- Verifies, per installation, that the deleted counts equal the counted ones and that its statistics rows, its installation row and its claim/link/device rows did
  not change; verifies afterwards that no Guildbook row remains for the processed installations.
- **Bounded**: at most `max_installations` per run (default 200, maximum 500); it reports `remaining_installations_with_guild_rows_in_scope`. Re-run until 0.
  Re-running is safe and idempotent (a second run reports zeros).
- Output is **counts only**: no character, guild or realm name, no guid, no installation id (an installation is shown as 8 hex characters of `md5(id)`, only for
  `scope=list`, at most 25 lines). The operator and the backup reference are echoed so the console log is the record of the run.
- `scope=list -v installation_ids='a,b'` limits the run to named installations (for example to honour a single erasure request in addition to the DSAR runbook).

After the run:

1. Re-run the inventory: guild/member/profession rows 0 (or the expected remainder), `installations_with_guild_rows` 0.
2. Rows are gone logically; the **storage** is reclaimed by autovacuum. The inventory shows estimated dead tuples. Do not run `VACUUM FULL` on a live project without a window.
3. Record the run (date, counts, backup reference) in the change record. Update `docs/gdpr/retention-schedule.md`, the processing records and the privacy notice
   so they no longer describe a cloud Guildbook (owner task; the notice is not changed by this work).

## 5. What the cleanup does not remove (decide explicitly)

- **Backups and PITR** keep the deleted rows until they age out. Write down the retention window and the date by which the data is gone from them; do not shorten it
  by deleting backups blindly. If the owner needs earlier erasure, that is a provider-level action outside this repository.
- **Logs and statement text**: check the project's logging configuration; if statement text can contain Guildbook values, treat the log retention like a backup.
- **The section 4 export / backup file**: destroy on the planned date and record the destruction.
- **Anything already given out** (a previous DSAR response) cannot be recalled.

## 6. Interaction with the DSAR runbook

`docs/gdpr/dsar-runbook.md` lists Guildbook rows as data of an installation (and notes that they contain other people's data). After the cleanup an access request
finds none; before it, the runbook's rules apply unchanged. The cleanup is **not** an erasure-request procedure by itself: for an individual request use
`scope=list` or the runbook's installation deletion, and keep their own records.
