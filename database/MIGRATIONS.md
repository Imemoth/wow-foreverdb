# Migration registry, namespaces and ledger identifiers

Status: **proposed registry, derived on 2026-11-11 from the repository and from a read-only read of both Supabase migration ledgers.** It changes no schema and applies nothing. Where a mapping is by name only, it says so; verify against the file header before relying on it.

## 1. Why this exists

Migration numbers are **not global**. The same number currently names different changes in different directories and different Supabase projects (for example 0012, 0015, 0016, 0018, 0019 and 0020 each appear more than once), and several ledger names do not match their file names. This document fixes the vocabulary so a number, a file and a ledger row can be tied together unambiguously.

## 2. Namespaces and project ownership

| Namespace | Supabase project (ref) | Holds | Repository locations |
| --- | --- | --- | --- |
| `acct` | `wow-forever` (`klxhikdlfwgxurdyexdi`): Auth users, accounts, Companion ingest, Guildbook cloud tables (sync disabled by 0018) | the account and Companion backend | `database/migrations/`, `database/private-export/`, `database/rollback/`, `database/restore/`, and the account-side operator scripts in `database/ops/` (0012\_\*, 0015\_\*, `retention_cleanup_*`, `guildbook_*`; assigned by subject, confirm in each file header) |
| `pubread` | `azerdex-public-read` (`chcoypkjzxfznsqmmbrq`): public read model, News collector, publisher, Ops health report and the Ops Bot gate, Edge Functions | the public/read side | `database/public-read/migrations/`, `database/public-read/ops/`, and the operator migrations `database/ops/0016` to `0021`, `database/ops/verify_*` |

Rules: a number belongs to exactly one namespace; **rollback, restore, schedule, unschedule and verify files reuse the number of the migration they belong to** (same change, different file); every Pull Request that adds or renames a migration names its namespace and target project in the description. PR #191 (admin) names neither today; it must before any hosted application.

## 3. Identifiers

- **Registry ID:** `<namespace>/<NNNN>`, for example `acct/0019`, `pubread/0020`.
- **Ledger name going forward:** `<namespace>_<NNNN>_<slug>` (for example `pubread_0022_news_x`). Existing ledger names are kept as recorded; the tables below list each as the **legacy alias**.
- **Ledger version:** the timestamp Supabase assigns (`apply_migration`) or, for a change applied in the SQL editor, the timestamp of application. A history row for an SQL-editor application is recorded afterwards with the **exact released file text** (precedent: `ops_0020_gated_rpc`, version `20261111092220`, stored text sha256 equal to the released file; the insert was guarded on that hash). Ledger rows are only ever inserted, never edited or deleted.
- **Checksum:** the sha256 of the released file (LF line endings). The registry records it when a migration is applied.

## 4. Collision prevention (rules)

1. **Reserve before writing.** Add the row to this registry (status `reserved`, owner PR) in the same PR that adds the first file, or earlier. One open PR per number.
2. **Never reuse a number**, including reserved and abandoned ones (0016 is permanently reserved in `acct`; the Guildbook guard enforces it).
3. **Gaps are fine, renumbering applied migrations is not.** A number applied to a project stays with that change forever.
4. **Order of application is the ledger's, not the number's.** A lower number may be applied after a higher one if the two are independent; state the dependency in the file header when they are not (for example 0019 requires the 0018 guard).
5. **Next free numbers** (2026-11-11): `acct` **0021**; `pubread` **0022** (0014 and 0015 are unassigned gaps in `pubread`; do not reuse them, because 0015 is an `acct` change).
6. **Policy-checked names.** The Guildbook guard pins names and content (0016 reserved, 0018 pinned, the reviewed 0019 use of the ingest wrapper). Renumbering 0019 means updating that guard in a separate reviewed PR.
7. **Proposed CI check (not implemented here):** a small script that fails a PR when a new file's `<namespace>/<NNNN>` is already in the registry for a different slug, or the registry has no row for a new migration.

## 5. Registry: `acct` (project `wow-forever`)

Ledger read 2026-11-11: 15 rows. Mapping is by name unless noted.

| ID | File(s) | Ledger name (legacy alias) | Status |
| --- | --- | --- | --- |
| acct/0001 to 0004 | `0001_initial_schema` to `0004_remove_legacy_ingest` | none | no ledger row found (applied before ledger tracking or outside it; unverified) |
| acct/0005 | `0005_guildbook_v1` | `guildbook_v1` | applied |
| acct/0006 | `0006_companion_search_zone` | `companion_search_zone_scope`, `companion_zone_scoped_search`, `companion_zone_scoped_search_signed_ids` | applied (one file, three ledger rows) |
| acct/0007 | `0007_restrict_legacy_public_stats` | `restrict_legacy_public_stats` | applied |
| acct/0008, 0008a, 0008b | `0008_zone_catalog_browse`, `0008a_close_unused_private_rpcs`, `0008b_prepare_authenticated_global_search` | `zone_catalog_browse`, `close_unused_private_rpcs`, `prepare_authenticated_global_search` | applied |
| acct/0009 | `0009_api_security_rate_limits` | `api_security_rate_limits` | applied |
| acct/0010 | `database/private-export/0010_public_projection_export` (+ rollback files) | `public_projection_export_0010` | applied (file lives outside `database/migrations/`) |
| acct/0011 | `0011_fix_observed_drop_rate_denominator` | `fix_observed_drop_rate_denominator` | applied |
| acct/0012 | `0012_account_ownership_claims` (+ rollback, ops scripts) | `account_ownership_claims` | applied |
| acct/0013 | `database/restore/0013_account_ownership_claims_restore` | (`account_ownership_claims_restore` is the name the ledger script allows) | restore script only; no row |
| acct/0014 | `0014_zero_touch_enrollment` | `zero_touch_enrollment` | applied |
| acct/0015 | `0015_azerdex_welcome_outbox` (+ ops scripts) | `azerdex_welcome_outbox` | applied |
| acct/0016 | none | none | **permanently reserved** (Guildbook guard) |
| acct/0017 | none | none | unassigned (the number 0017 is used in `pubread`) |
| acct/0018 | `0018_disable_guildbook_cloud_sync` (+ `0018_restore`) | `disable_guildbook_cloud_sync` | applied; pinned by the Guildbook guard |
| acct/0019 | `0019_technical_installation_ingest` on PR #179 | none | **reserved, PR #179 (Draft), not applied; hosted application needs its own owner approval** |
| acct/0020 | `0020_admin_private_authorization` (+ rollback), merged to `main` by PR #191 on 2026-11-11, **not on `release`** | none | merged to `main`, not applied; target project not named in the PR |

## 6. Registry: `pubread` (project `azerdex-public-read`)

Ledger read 2026-11-11: 18 rows (including `ops_0020_gated_rpc`). Mapping is by name unless noted.

| ID | File(s) | Ledger name (legacy alias) | Status |
| --- | --- | --- | --- |
| (prelude) | none found in the repository | `public_read_prelude_extensions` | applied |
| pubread/0001 | `0001_public_read_model` | `public_read_0001_public_read_model` | applied |
| pubread/0002 | `0002_zone_map_points` | `public_read_0002_zone_map_points` | applied |
| pubread/0002 (file) | `0002_news_model` | `public_read_0007_news_model` | applied; **ledger number differs from the file number** |
| pubread/0003 to 0006 | `0003_publication_operations`, `0004_publisher_schedule`, `0005_source_map_points`, `0006_private_export_credential` | `public_read_0003_…` to `public_read_0006_…` | applied |
| pubread/0008, 0009 | `0008_news_ingest_role`, `0009_news_ingest_search_path` | `public_read_0008_news_ingest_role`, `public_read_0009_news_ingest_search_path` | applied |
| pubread/0010 | `0010_news_bluepost_suppression` | `news_bluepost_suppression_v1` | applied |
| pubread/0011 | `0011_news_collector_v2` | `news_collector_v2` | applied |
| pubread/0012 | `0012_news_revision_due_tolerance` | `news_revision_due_tolerance` | applied |
| pubread/0013 | `0013_news_global_story_grouping` on PR #165 (approved for code merge 2026-11-11) | `news_global_story_grouping` (applied 2026-11-05) | applied in production; file not yet on `release`; applied text equals the file with comments removed |
| pubread/0016 | `database/ops/0016_schedule_news_collector`, `…_unschedule_…` | none found by name | operator scripts; no ledger row found |
| pubread/0017 | `database/ops/0017_schedule_news_collector_vault` | `public_read_0010_news_vault_scheduler` | applied; **ledger number differs from the file number** |
| pubread/0018 | `database/ops/0018_news_health_monitoring` (+ `0018_schedule_news_health_check`, `…_unschedule_…`) | `news_health_monitoring` | applied |
| pubread/0019 | `database/ops/0019_ops_health_report` (+ rollback) | `ops_0019_health_report` | applied |
| pubread/0020 | `database/ops/0020_ops_health_gated_rpc` (+ rollback, `verify_ops_health_gated_rpc.sql`) | `ops_0020_gated_rpc` | applied 2026-11-11; history row recorded afterwards |
| pubread/0021 | `database/ops/0021_drop_ops_reporter_login` | none | **not applied; only after the Option G 48 h observation ends clean** |

## 7. How to keep it true

- Update this file in the PR that adds, renames or applies a migration; a migration PR without a registry row is incomplete.
- After any hosted application, add the ledger name, version and checksum to the row, in the same PR that records the evidence.
- A registry row is documentation only: it never authorises applying anything. Hosted application always needs its own explicit owner approval.
