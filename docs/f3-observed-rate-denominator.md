# F-3 — Companion observed drop-rate denominator

**Status: MERGED / PRODUCTION MIGRATION PENDING.**
The fix was merged to `main` by PR #37 (squash commit `6d0df83`, 2026-10-10) with all CI green. Migration `0011_fix_observed_drop_rate_denominator.sql` is on `main` but **has not been applied to the production Supabase project** (production ledger still ends at `20261009124630 api_security_rate_limits`). The live Companion keeps showing the old (inflated) multi-installation rates until the owner separately approves and applies it. **Merging was not deployment approval.** F-3 must not be called fixed in production until the postchecks below pass.

Rollout readiness (read-only preflight, 2026-10-10): **READY_FOR_PRODUCTION_APPROVAL**. Nothing below has been executed against production.

Finding origin: `docs/web/00-current-state-assessment.md` (F-3).

## Root cause (verified against the live definitions)

Read with `pg_get_functiondef` (read-only metadata) on 2026-10-10. Three SECURITY DEFINER functions in schema `private` share one defect:

| Function | API exposure |
| --- | --- |
| `private.foreverdb_item_stats(bigint)` | via `public.get_foreverdb_item_stats` (authenticated, budgeted by 0009) |
| `private.foreverdb_source_stats(text,bigint,integer)` | via `public.get_foreverdb_source_stats` (authenticated, budgeted by 0009) |
| `private.foreverdb_all_stats()` | none (EXECUTE revoked from every API role by 0008a); fixed for consistency |

Each one did:

```
from installation_source_stats ss
join installation_item_stats ii on ii.installation_id = ss.installation_id and <same source key> and ii.loot_kind = ss.loot_kind
...
sum(ss.observations)   -- denominator
```

The **inner join per installation** keeps a source row only if that installation also has an item row. An installation that observed the source but never received the item has no item row, so its observations vanish from the denominator.

Not defective: `foreverdb_search_in_zone` and `foreverdb_zone_catalog` (membership only, no rates), the ingest functions (they write one `installation_source_stats` row per bucket regardless of drops, which is what makes the correct denominator available), and the public website projection (already uses all observations of the bucket).

### What is affected

| Column | Affected? |
| --- | --- |
| `observations` | **Yes**: under-counted for multi-installation buckets |
| `observed_drop_rate` | **Yes**: over-stated |
| Companion `RatePercent` and Wilson `ConfidenceScore` | **Yes**: the client computes both from the RPC's `observations` and `drop_count` (`SearchService.ParseObservedRows`), not from `observed_drop_rate` |
| `drop_count`, `quantity`, `quest_drop_count` | No: already summed over the item rows |
| Single-installation buckets | No |

## Mathematical correction

```
observed_rate = SUM(drop_count of the item) / SUM(observations of ALL installations
                for that exact source_type + source_id + source_level + loot_kind)
```

Installation A: 100 observations, 10 drops of X. Installation B: 100 observations, 0 drops.
Before: 10 / 100 = 10 %. After: 10 / 200 = **5 %**.

Numerator semantics are unchanged: an item row counts only for an installation that also recorded the matching source row (exactly what the old per-installation join did). Ingest always writes both together, so this only matters for manually repaired data, where it prevents a numerator larger than the denominator.

Implementation: item totals and source totals are aggregated **independently** and joined on the full source identity. Source totals are computed once per source key (never per item), so several items from one source cannot multiply the denominator. Division is `numeric`; a zero denominator returns `NULL`; sums stay `bigint`.

## What changed

| File | Change |
| --- | --- |
| `database/migrations/0011_fix_observed_drop_rate_denominator.sql` | `CREATE OR REPLACE` of the three function bodies only. Pre-flight and post-condition assertions (see below). |
| `database/rollback/0011_restore_previous_observed_rate_functions.sql` | Verbatim previous production definitions: rollback, and the "before" baseline for tests. |
| `database/tests/f3_drop_rate_denominator.sql` | Regression suite (below). |
| `.github/workflows/api-security.yml` | Runs the suite; the existing security suite then runs on the post-0011 state. |

No client change. No table, view, policy, grant or data change. The public wrappers and the 0009 budgets are untouched. One deliberate non-denominator change: a deterministic `ORDER BY source_type, source_id, source_level, loot_kind, item_id`. The row set is unchanged; only for an item with **more than 500 sources** does the wrappers' `LIMIT 500` now keep the lowest source ids (stable) instead of an arbitrary 500 (the old functions had no ordering). The Companion re-sorts after the cut as before. No such item exists today.

### Security properties (asserted inside the migration, transaction aborts otherwise)

- Pre-flight: the three functions and both public wrappers exist; the functions are `SECURITY DEFINER`; no API role can execute them.
- Post-condition: owner, `SECURITY DEFINER`, `proconfig` (`search_path=""`), `proacl`, result type and argument list are **identical** to a snapshot taken before the replacement; `anon`/`authenticated`/`PUBLIC` still cannot execute the private functions; `anon` still cannot call the stats RPCs; `authenticated` still can; raw `installation_*_stats` tables stay unreadable.
- Production ACL on all three functions today: `{postgres=X/postgres}` (owner only).
- No `service_role`, no new RPC, no widened privilege.

## Regression tests

`database/tests/f3_drop_rate_denominator.sql` on an ephemeral PostgreSQL 16 (after the CI chain bootstrap → 0001–0009). It restores the real pre-fix definitions as the baseline, **proves the defect reproduces**, applies 0011, and checks:

| Scenario | Result |
| --- | --- |
| A single installation, 100 obs / 10 drops | 10 % |
| B zero-drop contributor, 100/10 + 100/0 | 5 %, quantity unchanged |
| C three installations, 100/20 + 200/0 + 100/20 | 10 % (before: 20 %) |
| D several items from one source | one shared denominator (200), not 200 × items; zero-drop item → 0, not NULL |
| E same creature id at levels 0, 10, 11 | separate rows, separate denominators |
| F mob, skinning, mining, herbalism, chest, gameobject, fishing, fishing pool, disenchant | never mixed |
| G zero observations, inconsistent zero denominator, unknown ids, NULL, orphan item row | NULL rate, no error, no invented rows |
| Large counts (9 × 10¹² observations) | exact |
| H response contract | identical result type; wrapper JSON keys unchanged |
| I security | ACL/owner/config byte-identical; API roles denied; anon and private access denied through real roles |
| J non-F-3 behaviour | same row set; identical non-denominator columns; single-installation buckets identical; exactly 11 corrected fixture buckets, all lower |
| Item row without that installation's own source row (900015) | excluded from the numerator, rate stays 10 % (found by the review; fails against the first draft) |
| Item view vs captured baseline | same row set and non-denominator columns for all fixture items |
| Item view vs source view vs `all_stats` | internally consistent |
| Rollback round trip | rollback restores the defect and identical ACLs; 0011 re-applies cleanly |

Mutation check: with the old formula swapped in for 0011 the suite fails at the zero-drop-contributor assertion. The existing `api_security_roles_and_quotas.sql` also passes with 0011 applied (authentication, quotas, validation unchanged).

## Before / after aggregate evidence (production, read-only, aggregates only)

Computed on 2026-10-10 with a SELECT that evaluates both formulas inline (no functions created, no installation identifiers read):

| Measure | Value |
| --- | --- |
| Installations | 7 |
| Source buckets (source + level + kind) | 152, of which 13 have more than one contributing installation |
| Item buckets | 374 |
| **Changed** item buckets | **21** (all in multi-installation sources) |
| Unchanged item buckets | 353 (including every single-installation bucket) |
| Denominator decreased | 0 |
| Zero-denominator buckets | 0 |
| Rate > 100 % (old or new) | 0 |
| New rate ÷ old rate (changed buckets) | min 0.0455, average 0.797, max 1.0 |
| Largest overstatement | 25 percentage points |
| Changed buckets meeting the public thresholds (≥ 10 drops and ≥ 30 observations) | 0 |

Direction: corrections only ever **lower** rates. The public website projection already uses the correct denominator, so website figures and corrected Companion figures agree where the denominators agree. The source data is sufficient; no estimate is invented.

Performance (synthetic 160k source rows, 480k item rows, local): item stats ≈ 21 ms (before ≈ 33 ms); legacy all-stats ≈ 1.0 s (before ≈ 1.9 s). Plans use `item_stats_item_idx` and `source_kind_idx`.

## Compatibility

- Same function names, argument lists and return columns; the public wrappers and the Companion JSON contract are unchanged.
- Existing Companion builds need no update: they compute rate and Wilson score from `observations`/`drop_count`, which are now correct.
- Behaviour change visible to users: some multi-installation drop rates drop (up to 25 points on current data) and their confidence scores fall with the larger denominators. This is the intended correction.
- Hidden rows: none. Rows with item stats but no source-stats row are excluded exactly as before (ingest never produces them).

## Production rollout runbook (prepared, NOT executed; needs explicit owner approval)

Target: Supabase project `wow-forever`, ref `klxhikdlfwgxurdyexdi` (the only production project; no staging exists). Confirm the ref before any write.

### Preflight (read-only, recomputed 2026-10-10 from the live database; repeat immediately before applying)

| Check | Expected (and observed on 2026-10-10) |
| --- | --- |
| Migration ledger | 9 rows, latest `20261009124630`; **no** `0011`-like and **no** `0010`-like row |
| `md5(pg_get_functiondef)` | `foreverdb_all_stats` `8d9d8cf1b0a9f240b430ef4368501e50`, `foreverdb_item_stats` `434fea25fe31e723258d73ec109da932`, `foreverdb_source_stats` `0010ecb56cede1d45ac4dc252593e8f4` (all matched) |
| `md5(prosrc)` (version-independent) | `all_stats` `5934a662e230a42079eb764e285e330a`, `item_stats` `4aaf9616360e88b70715d11f51ea08bb`, `source_stats` `86d2c5996624927083390f8e461d366d` (all equal the rollback file's bodies) |
| Owner / `SECURITY DEFINER` / config / ACL | `postgres` / true / `search_path=""` / `{postgres=X/postgres}`; no EXECUTE for `anon`, `authenticated`, `service_role` or PUBLIC |
| Public wrappers | `get_foreverdb_item_stats`, `get_foreverdb_source_stats`: `SECURITY DEFINER`, `search_path=""`, `statement_timeout=5s`, call `foreverdb_api_gate('detail')`; EXECUTE for `authenticated` and `service_role` only |
| 0009 intact | `foreverdb_api_gate` and `foreverdb_take_budget` present with owner-only ACL; `foreverdb_api_budgets` present; `anon`/`authenticated`: no `private` schema usage, no SELECT on `items`, `sources`, `installation_source_stats`, `installation_item_stats` |

If **any** value differs, STOP and investigate; do not force the migration.

### Deployment method (only 0011, recorded in the ledger)

`0009` was applied through the Supabase migration tool (`apply_migration`, ledger `20261009124630 api_security_rate_limits`). Use the same path:

- `apply_migration` with `project_id = klxhikdlfwgxurdyexdi`, `name = fix_observed_drop_rate_denominator`, `query` = the exact contents of `database/migrations/0011_fix_observed_drop_rate_denominator.sql` (including its own `begin`/`commit`, as 0009 did).
- The tool executes only the SQL it is given and writes one ledger row (`<timestamp> fix_observed_drop_rate_denominator`). It is **not** an "apply all pending migrations" command, and `0010` is not under `database/migrations/`, so it cannot be picked up. Do not use `supabase db push` or any command that replays the directory.
- The migration aborts (nothing applied) if the pre-flight or post-condition assertions fail.
- Do not execute the SQL through a path that skips the ledger (SQL editor, `execute_sql`); that would leave migration history inconsistent.

### Post-deployment verification plan

| # | Check | Expected |
| --- | --- | --- |
| 1 | Ledger | exactly one new row `fix_observed_drop_rate_denominator`; 10 rows total |
| 2 | Definitions updated | `md5(prosrc)`: `item_stats` `319353a93b82b982cbf435b6e0a347a7`, `source_stats` `ed7220a5d77dff73a12e16afaf0dbb5c`, `all_stats` `d1498eb1e9fc696c8bcf3b95748f97a5` |
| 3 | Owner/ACL/config unchanged | same owner, `SECURITY DEFINER`, `search_path=""`, `{postgres=X/postgres}`; wrappers unchanged (`md5(pg_get_functiondef)` of the two wrappers equals the preflight values `68a6fbe4…` and `4f37d9f5…`) |
| 4 | Anonymous access denied | `has_function_privilege('anon', …)` false for all five functions; direct call with the anon key returns 401/403 |
| 5 | Authenticated access | a real anonymous-auth JWT can call both wrappers; the 0009 budget still counts (`detail:uid:*` bucket increments) |
| 6 | Response schema | same 12 columns, names and types (`md5(pg_get_function_result)` `c85980c8006ab522b444d8c6e0342327` for all three private functions) |
| 7 | Corrected denominators | see acceptance pair below; the item row's `observations` includes zero-drop installations |
| 8 | Unaffected buckets | re-run the aggregate comparison: 353 unchanged buckets keep identical `observations`/rate (a changed count different from 21 needs an explanation: new data only) |
| 9 | Performance | baseline (old functions, production, 2026-10-10): item stats Shadowgem 8.3 ms, source stats Copper Vein 5.2 ms, item stats Linen Cloth (42 rows) 7.2 ms; the new versions must stay in the same order of magnitude (well below the 5 s wrapper timeout) |
| 10 | Companion Search | **MANUAL ACCEPTANCE PENDING** (needs the Windows Companion) |

**Manual Companion acceptance pair** (catalog identifiers only, no installation data):

| Item | Source | Before | After |
| --- | --- | --- | --- |
| Shadowgem (1210) | Copper Vein (gameobject 1731, level 0, mining) | 1 drop / 5 observations = 20.0 % | 1 / 110 = **0.9 %** |
| Fractured Canine (3299) | Cursed Darkhound (creature 1548, level 8, mob) | 1 / 3 = 33.3 % | 1 / 12 = **8.3 %** |
| Putrid Claw (2855) | Rotting Dead (creature 1525, level 6, mob) | 2 / 4 = 50.0 % | 2 / 5 = **40.0 %** |

Unaffected control: Raw Brilliant Smallfish (6291) at Tirisfal Glades fishing: 10 / 28 = 35.7 % before and after. Open the item and the source detail in the Companion: the Observations column and the Rate must show the "After" values, and the item view and source view must agree.

### Rollback (not executed)

- **Preconditions:** a verification check above failed or the corrected rates are judged wrong. The rollback only restores the pre-0011 function bodies; it changes no data and no grants.
- **Procedure:** `apply_migration` with `name = restore_previous_observed_rate_functions` and `query` = the exact contents of `database/rollback/0011_restore_previous_observed_rate_functions.sql`. `CREATE OR REPLACE` keeps owner and ACL.
- **History consistency:** the ledger is forward-only. The rollback is recorded as its own new row; the `fix_observed_drop_rate_denominator` row stays. Do not delete ledger rows by hand. A later re-apply uses the migration again under a new name or version.
- **Verification after rollback:** `md5(prosrc)` equals the baseline values (`5934a662…`, `4aaf9616…`, `86d2c599…`); owner/ACL/config unchanged; the acceptance pair shows the old values again (20.0 % for Shadowgem); anonymous access still denied; authenticated calls still work.
- **Consequence:** the F-3 inflation returns (multi-installation rates overstated by up to 25 percentage points on current data). No data is lost.
- The rollback file is verified identical to production (`prosrc` and `pg_get_functiondef` hashes above). The rollback is exercised only on ephemeral databases (the F-3 suite), never on production.

## Remaining risks

- Production is not changed; the live Companion is still affected until the owner approves and applies 0011.
- The previous function definitions exist only in production and in the rollback file (they were provisioned outside the numbered migrations). The rollback file was verified **byte-identical** to production: md5 of `pg_get_functiondef` equals md5 of the file's definitions for all three functions (`all_stats` 8d9d8cf1…, `item_stats` 434fea25…, `source_stats` 0010ecb5…), read-only, 2026-10-10.
- Production runs PostgreSQL 17.6; the CI/local suites ran on PostgreSQL 16 (as in the existing CI). The SQL uses only portable constructs; the verification plan compares `prosrc` hashes (formatter-independent) and re-runs the aggregate comparison on production to cover the version difference.
- Single production database, no staging: the in-migration assertions and the tested rollback are the safety net.
- Thin contributor base (7 installations): corrected rates are still small-sample figures; the website's sample thresholds remain the honest presentation.
- The Windows Companion UI was not run in this session (no .NET/Windows runner); the contract argument above is from reading `SearchService.cs`.

## Independent review

A separate reviewer agent (given the files and the review dimensions, not the author's conclusions) reviewed aggregation math, join multiplicity, zero-denominator and precision, privileges, response contract, performance, migration safety and test quality.

- Critical / high: **none**.
- Medium (fixed): an installation holding an item row but no source row would have been added to the numerator (rate 60 % instead of the old 10 % in the reproduction). Item rows are now restricted to installations that also have the matching source row; new scenario 900015 fails against the first draft and passes now.
- Low (fixed): header claims about `LIMIT 500` ordering and "unchanged" columns corrected; dangling doc path fixed; the unused item-view baseline is now compared; comment accuracy.
- Low (open, documented): neither version indexes `installation_item_stats` by source, so the source view scans that table (not a regression; the table is small today).
- Nothing found in: aggregation math, join multiplicity, zero-drop coverage, NULL/zero handling, bigint/numeric precision, privilege escalation, response contract, migration safety.
