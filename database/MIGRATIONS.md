# Migration registry, namespaces and ledger identifiers

Status: **registry, derived on 2026-11-11 from the repository and from a read-only read of both Supabase migration ledgers.** It changes no schema and applies nothing, and no historical migration is renamed or reapplied. Where a mapping is by name only, the row says so; verify against the file header before relying on it. It is checked by `scripts/check-migration-registry.mjs` (section 8).

## 1. Why this exists

Migration numbers are **not global**. The same number names different changes in different directories and different Supabase projects (for example 0010, 0012, 0013, 0015 to 0020 each appear in both projects), two files in one directory share the number 0002, and several ledger names do not match their file names. This document fixes the vocabulary so a number, a file and a ledger row can be tied together unambiguously. **Never refer to a bare number; always use the registry ID.**

## 2. Namespaces and project ownership

| Namespace | Supabase project (ref) | Holds | Repository locations |
| --- | --- | --- | --- |
| `acct` | `wow-forever` (`klxhikdlfwgxurdyexdi`): Auth users, accounts, Companion ingest, Guildbook cloud tables (sync disabled by 0018) | the account and Companion backend | `database/migrations/`, `database/private-export/`, `database/rollback/`, `database/restore/`, and the account-side operator scripts in `database/ops/` (0012\_\*, 0015\_\*) |
| `pubread` | `azerdex-public-read` (`chcoypkjzxfznsqmmbrq`): public read model, News collector, publisher, Ops health report and the Ops Bot gate, Edge Functions | the public/read side | `database/public-read/migrations/`, `database/public-read/ops/`, and the operator migrations `database/ops/0016` to `0021` |

Rules: a number belongs to exactly one namespace; **rollback, restore, schedule, unschedule, staging and verification files reuse the number of the migration they belong to** (same change, different file); every Pull Request that adds or renames a migration names its namespace and target project in the description. PR #191 (admin, `acct/0020`) names neither today; it must before any hosted application. Un-numbered operator scripts (for example `retention_*`, `guildbook_*`, `verify_*`) are outside the registry.

## 3. Identifiers

- **Registry ID:** `<namespace>/<NNNN><optional letter>`, for example `acct/0019`, `pubread/0020`, `acct/0008a`. **An ID is unique, permanent and never reused.**
- **ID assignment:** the ID is the migration's file number. When two files in one namespace share a number, the one whose recorded ledger alias carries a different, still-unused number takes that number as its ID; if there is no such alias, a letter suffix is used (the `0008a`, `0008b` convention). The file keeps its name. Example: `0002_news_model.sql` is `pubread/0007` (section 7).
- **Ledger alias:** the name as recorded in the project's Supabase migration ledger, kept exactly as it is (the registry lists it with its **version**, the ledger timestamp). New ledger names follow `<namespace>_<NNNN>_<slug>`.
- **Ledger version:** the timestamp Supabase assigns (`apply_migration`) or, for a change applied in the SQL editor, the time of application. A history row for an SQL-editor application is recorded afterwards with the **exact released file text** (precedent: `ops_0020_gated_rpc`, version `20261111092220`, stored text sha256 equal to the released file; the insert was guarded on that hash). Ledger rows are only ever inserted, never edited or deleted.
- **Checksum:** the sha256 of the released file (LF line endings). Record it in the evidence for the application.

## 4. Collision prevention (rules)

1. **Reserve before writing.** Add the row to this registry (status `reserved`, owner PR) in the same PR that adds the first file, or earlier. One open PR per ID.
2. **Never reuse an ID or a number**, including reserved and abandoned ones (`acct/0016` is permanently reserved; the Guildbook guard enforces it).
3. **Gaps are fine, renumbering applied migrations is not.** A number applied to a project stays with that change forever. A historical difference between file number, ledger alias or ID is **recorded** (section 7), not repaired.
4. **Order of application is the ledger's, not the number's.** A lower number may be applied after a higher one if the two are independent; state the dependency in the file header when they are not (for example `acct/0019` requires the `acct/0018` guard).
5. **Next free numbers** (2026-11-11): `acct` **0021**; `pubread` **0022** (0014 and 0015 are unassigned gaps in `pubread`; do not reuse them).
6. **Policy-checked names.** The Guildbook guard pins names and content (0016 reserved, 0018 pinned, the reviewed 0019 bytes). Renumbering 0019 means updating that guard in a separate reviewed PR.
7. **The check runs in CI** (section 8) and fails on duplicate IDs, duplicate ledger aliases or versions, unregistered or doubly claimed files, and unexplained number differences.

## 5. Registry: `acct` (project `wow-forever`)

Ledger read 2026-11-11: 15 rows. Status keywords: `applied`, `no-ledger`, `restore-only`, `reserved`, `main-only`, `pending`, `ledger-only`.

| ID | Files | Ledger alias (version) | Status |
| --- | --- | --- | --- |
| `acct/0001` | `database/migrations/0001_initial_schema.sql` | none | no-ledger: predates ledger tracking or applied outside it (unverified) |
| `acct/0002` | `database/migrations/0002_sync_safety.sql` | none | no-ledger: predates ledger tracking or applied outside it (unverified) |
| `acct/0003` | `database/migrations/0003_companion_auth.sql` | none | no-ledger: predates ledger tracking or applied outside it (unverified) |
| `acct/0004` | `database/migrations/0004_remove_legacy_ingest.sql` | none | no-ledger: predates ledger tracking or applied outside it (unverified) |
| `acct/0005` | `database/migrations/0005_guildbook_v1.sql` | `guildbook_v1` (20260926182007) | applied |
| `acct/0006` | `database/migrations/0006_companion_search_zone.sql` | `companion_search_zone_scope` (20261007184105), `companion_zone_scoped_search` (20261007184206), `companion_zone_scoped_search_signed_ids` (20261007184942) | applied: one file, three ledger rows |
| `acct/0007` | `database/migrations/0007_restrict_legacy_public_stats.sql` | `restrict_legacy_public_stats` (20261008153743) | applied |
| `acct/0008` | `database/migrations/0008_zone_catalog_browse.sql` | `zone_catalog_browse` (20261009072627) | applied |
| `acct/0008a` | `database/migrations/0008a_close_unused_private_rpcs.sql` | `close_unused_private_rpcs` (20261009112031) | applied |
| `acct/0008b` | `database/migrations/0008b_prepare_authenticated_global_search.sql` | `prepare_authenticated_global_search` (20261009112339) | applied |
| `acct/0009` | `database/migrations/0009_api_security_rate_limits.sql` | `api_security_rate_limits` (20261009124630) | applied |
| `acct/0010` | `database/private-export/0010_public_projection_export.sql`, `database/rollback/0010_*.sql` | `public_projection_export_0010` (20261021093848) | applied: the file lives outside `database/migrations/` |
| `acct/0011` | `database/migrations/0011_fix_observed_drop_rate_denominator.sql`, `database/rollback/0011_*.sql` | `fix_observed_drop_rate_denominator` (20261010151518) | applied |
| `acct/0012` | `database/migrations/0012_account_ownership_claims.sql`, `database/rollback/0012_*.sql`, `database/ops/0012_*.sql` | `account_ownership_claims` (20261012124839) | applied |
| `acct/0013` | `database/restore/0013_account_ownership_claims_restore.sql` | none | restore-only: a restore script, not a forward migration; `account_ownership_claims_restore` is the ledger name the ledger script allows; no row |
| `acct/0014` | `database/migrations/0014_zero_touch_enrollment.sql`, `database/rollback/0014_*.sql` | `zero_touch_enrollment` (20261013112920) | applied |
| `acct/0015` | `database/migrations/0015_azerdex_welcome_outbox.sql`, `database/rollback/0015_*.sql`, `database/ops/0015_*.sql` | `azerdex_welcome_outbox` (20261022072835) | applied |
| `acct/0016` | none | none | reserved: permanently reserved by the Guildbook guard; never to be used |
| `acct/0018` | `database/migrations/0018_disable_guildbook_cloud_sync.sql`, `database/rollback/0018_restore.sql` | `disable_guildbook_cloud_sync` (20261030133052) | applied: pinned by the Guildbook guard |
| `acct/0019` | `database/migrations/0019_technical_installation_ingest.sql` | none | reserved: PR #179 (Draft), not applied; the Guildbook guard pins its reviewed bytes; hosted application needs its own owner approval |
| `acct/0020` | `database/migrations/0020_admin_private_authorization.sql` | none | main-only: merged to `main` by PR #191 on 2026-11-11, not on `release`, not applied; its target project is not named in the PR |

## 6. Registry: `pubread` (project `azerdex-public-read`)

Ledger read 2026-11-11: 18 rows (including `ops_0020_gated_rpc`). Mapping is by name unless noted.

| ID | Files | Ledger alias (version) | Status |
| --- | --- | --- | --- |
| `pubread/0000` | none | `public_read_prelude_extensions` (20261021084945) | ledger-only: no file in the repository (applied inline) |
| `pubread/0001` | `database/public-read/migrations/0001_public_read_model.sql` | `public_read_0001_public_read_model` (20261021085425) | applied |
| `pubread/0002` | `database/public-read/migrations/0002_zone_map_points.sql` | `public_read_0002_zone_map_points` (20261021085605) | applied |
| `pubread/0003` | `database/public-read/migrations/0003_publication_operations.sql` | `public_read_0003_publication_operations` (20261021090318) | applied |
| `pubread/0004` | `database/public-read/migrations/0004_publisher_schedule.sql` | `public_read_0004_publisher_schedule` (20261021090400) | applied |
| `pubread/0005` | `database/public-read/migrations/0005_source_map_points.sql` | `public_read_0005_source_map_points` (20261021090500) | applied |
| `pubread/0006` | `database/public-read/migrations/0006_private_export_credential.sql` | `public_read_0006_private_export_credential` (20261021090600) | applied |
| `pubread/0007` | `database/public-read/migrations/0002_news_model.sql` | `public_read_0007_news_model` (20261022080136) | applied: **the file is named 0002 but its recorded ledger alias is 0007**; the ID follows the ledger alias (section 7) |
| `pubread/0008` | `database/public-read/migrations/0008_news_ingest_role.sql` | `public_read_0008_news_ingest_role` (20261022082401) | applied |
| `pubread/0009` | `database/public-read/migrations/0009_news_ingest_search_path.sql` | `public_read_0009_news_ingest_search_path` (20261022083126) | applied |
| `pubread/0010` | `database/public-read/migrations/0010_news_bluepost_suppression.sql` | `news_bluepost_suppression_v1` (20261023090320) | applied |
| `pubread/0011` | `database/public-read/migrations/0011_news_collector_v2.sql` | `news_collector_v2` (20261104094201) | applied |
| `pubread/0012` | `database/public-read/migrations/0012_news_revision_due_tolerance.sql` | `news_revision_due_tolerance` (20261104221331) | applied |
| `pubread/0013` | `database/public-read/migrations/0013_news_global_story_grouping.sql` | `news_global_story_grouping` (20261105052509) | applied: applied text equals the file with comments removed; the file reached `release` with PR #165 on 2026-11-11 |
| `pubread/0016` | `database/ops/0016_*.sql` | none | no-ledger: operator schedule scripts; no ledger row found by name |
| `pubread/0017` | `database/ops/0017_schedule_news_collector_vault.sql` | `public_read_0010_news_vault_scheduler` (20261022104843) | applied: **the ledger alias carries 0010, the file is 0017**; the ID follows the file (section 7) |
| `pubread/0018` | `database/ops/0018_*.sql` | `news_health_monitoring` (20261105184417) | applied: the migration plus its schedule and unschedule scripts |
| `pubread/0019` | `database/ops/0019_*.sql` | `ops_0019_health_report` (20261110130029) | applied |
| `pubread/0020` | `database/ops/0020_*.sql` | `ops_0020_gated_rpc` (20261111092220) | applied: history row recorded afterwards |
| `pubread/0021` | `database/ops/0021_drop_ops_reporter_login.sql` | none | pending: not applied; only after the Option G 48 h observation ends clean and on a separate owner decision |

## 7. Resolved collisions and other potential collisions reviewed

**Resolved, without renaming or reapplying anything**

1. **`pubread/0002` was ambiguous** (two files in `database/public-read/migrations/` are numbered 0002). `0002_zone_map_points.sql` keeps `pubread/0002` (its ledger alias also says 0002). `0002_news_model.sql` is **`pubread/0007`**: its recorded ledger alias is `public_read_0007_news_model`, and nothing else in the namespace holds 0007. The file name, the alias and the version `20261022080136` are unchanged. The check lists this as a known file-number difference.
2. **A ledger alias whose number is held by another ID.** `public_read_0010_news_vault_scheduler` (20261022104843) belongs to `pubread/0017` (file `database/ops/0017_schedule_news_collector_vault.sql`), while `pubread/0010` is `0010_news_bluepost_suppression` (alias `news_bluepost_suppression_v1`, which carries no number). The alias is kept exactly as recorded; the check lists it as a known alias-number difference. Read the alias as a name, not as a number.

**Reviewed, no change needed**

- **Same number in both namespaces** (0010, 0011, 0012, 0013, 0015 to 0020): resolved by the namespace prefix; always cite `acct/NNNN` or `pubread/NNNN`.
- **Sibling files sharing a number** (rollback, restore, kill-switch, schedule, unschedule, staging, monitoring, verify): the same change in several files; each row lists them with a glob and the check requires each file to be claimed by exactly one row.
- **Letter suffixes** `acct/0008`, `0008a`, `0008b`: three distinct IDs.
- **One file, several ledger rows** (`acct/0006`): one ID, three aliases.
- **IDs without a ledger row** (`acct/0001` to `0004`, `acct/0013`, `pubread/0016`): recorded with their status; nothing is inferred.
- **A reserved or main-only ID with no file on this branch** (`acct/0016`, `0019`, `0020`): the row exists so the number cannot be taken; the check waives file existence only for `reserved`, `main-only` and `ledger-only`.
- **Un-numbered operator scripts** (`retention_*`, `guildbook_*`, `configure_*`, `verify_*`): outside the registry by design.
- **Duplicate ledger versions** are impossible by construction (timestamps) and are checked anyway.

## 8. Consistency check

`node scripts/check-migration-registry.mjs` reads this file and the migration directories and fails on: a malformed or duplicate registry ID; a duplicate ledger alias or version within a namespace; a numbered migration file that no row claims, or that two rows claim; a file whose number differs from its ID's number (other than the listed historical difference); a numbered ledger alias that differs from its ID's number (other than the listed historical difference); a row claiming files from the other namespace's directories; and a row whose status requires a file that does not exist. It runs in the `Migration registry` workflow (informational, not a required check, so unrelated PRs are never blocked) and as part of `node --test scripts/check-migration-registry.test.mjs`. The two "known difference" lists live in the script and change only together with section 7.

## 9. How to keep it true

- Update this file in the PR that adds, renames or applies a migration; a migration PR without a registry row fails the check.
- After any hosted application, add the ledger alias, version and checksum to the row, in the same PR that records the evidence.
- A registry row is documentation only: it never authorises applying anything. Hosted application always needs its own explicit owner approval.
