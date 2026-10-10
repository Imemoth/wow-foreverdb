# F-3 — Companion observed drop-rate denominator

**Status: CODE FIXED / PRODUCTION PENDING.**
Migration `0011_fix_observed_drop_rate_denominator.sql` is committed and tested but **has not been applied to the production Supabase project**. The live Companion keeps showing the old (inflated) multi-installation rates until the owner approves and applies it. Merging the PR that carries this change is **not** deployment approval.

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

## Production rollout (requires separate owner approval)

1. Confirm no other session is changing these functions (single production project, no staging).
2. Read-only precheck: `pg_get_functiondef` of the three functions equals `database/rollback/0011_restore_previous_observed_rate_functions.sql`, and `proacl` is `{postgres=X/postgres}` on each.
3. Apply `database/migrations/0011_fix_observed_drop_rate_denominator.sql` with the Supabase migration tool (single transaction; the in-migration assertions abort it on any drift).
4. Postchecks (read-only): ACL/owner/config unchanged; `anon` cannot execute the RPCs; an authenticated call to `get_foreverdb_item_stats` returns the same 12 columns; re-run the aggregate comparison and confirm `unchanged` buckets are equal and 21 buckets changed.
5. Windows Companion check: Search → item detail for a multi-installation item; the rate shown equals `drops / total source observations`.
6. Record the ledger version in `docs/ROADMAP.md` and flip F-3 to **FIXED IN PRODUCTION** only after step 4–5 pass.

## Rollback

Apply `database/rollback/0011_restore_previous_observed_rate_functions.sql` (verbatim previous definitions; owner and ACL are preserved by `CREATE OR REPLACE`). This reintroduces the F-3 inflation. It is tested in the suite (rollback → defect returns, ACLs identical → 0011 re-applies).

## Remaining risks

- Production is not changed; the live Companion is still affected until the owner applies 0011.
- The previous function definitions exist only in production and in the rollback file (they were provisioned outside the numbered migrations). The rollback file was verified **byte-identical** to production: md5 of `pg_get_functiondef` equals md5 of the file's definitions for all three functions (`all_stats` 8d9d8cf1…, `item_stats` 434fea25…, `source_stats` 0010ecb5…), read-only, 2026-10-10.
- Thin contributor base (7 installations): corrected rates are still small-sample figures; the website's sample thresholds remain the honest presentation.
- The Windows Companion UI was not run in this session (no .NET/Windows runner); the contract argument above is from reading `SearchService.cs`.

## Independent review

A separate reviewer agent (given the files and the review dimensions, not the author's conclusions) reviewed aggregation math, join multiplicity, zero-denominator and precision, privileges, response contract, performance, migration safety and test quality.

- Critical / high: **none**.
- Medium (fixed): an installation holding an item row but no source row would have been added to the numerator (rate 60 % instead of the old 10 % in the reproduction). Item rows are now restricted to installations that also have the matching source row; new scenario 900015 fails against the first draft and passes now.
- Low (fixed): header claims about `LIMIT 500` ordering and "unchanged" columns corrected; dangling doc path fixed; the unused item-view baseline is now compared; comment accuracy.
- Low (open, documented): neither version indexes `installation_item_stats` by source, so the source view scans that table (not a regression; the table is small today).
- Nothing found in: aggregation math, join multiplicity, zero-drop coverage, NULL/zero handling, bigint/numeric precision, privilege escalation, response contract, migration safety.
