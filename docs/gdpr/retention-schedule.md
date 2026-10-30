# Retention schedule and cleanup findings

Principle: the privacy notice describes **enforced** retention, not intended retention. No period below was invented; where no rule exists the notice says "kept until deleted on request".

## Findings: who deletes what today

Investigated `database/ops/0012_prune_account_claims.sql` and every prune path in the repository (`grep` of SQL, TS, workflows, ops scripts):

| Store | Rule in code | Enforced by | Verdict |
| --- | --- | --- | --- |
| `private.installation_claims` (revoked / expired-pending) | 7 days | `database/ops/0012_prune_account_claims.sql`, **operator-run only**; referenced only by docs and a CI rehearsal test | **not scheduled** |
| `private.account_audit` | 180 days | same script | **not scheduled**; its delete is also **unbounded** (no LIMIT), and its "pruned N" notice counts attempts, not deletions |
| `private.enrollment_tickets` (terminal) | 90 days | `private.fdb_prune_enrollment()` (0014), no caller anywhere | **not scheduled**; unbounded |
| `private.foreverdb_api_budgets` | 24 h | `private.foreverdb_prune_api_budgets()` (0009), no caller anywhere | **not scheduled** |
| `azerdex_welcome_candidates`, `_trigger_failures` | 30 days | `private.azerdex_welcome_prune()`; cron `azerdex-welcome-prune` 03:17 daily (owner-run script, reported active) | **scheduled** (only this and `azerdex-welcome-worker` are) |
| `azerdex_welcome_outbox` | until the account is deleted (FK cascade) | cascade | by design |
| `private.devices`, `private.device_audit` | none ("audit rows are retained", ADR-017) | - | **kept indefinitely** |
| `public.installations` + statistics + Guildbook tables | replaced on each sync; installation never deleted | - | **kept indefinitely**; idle installations never removed |
| `public.map_asset_diagnostics` | none (table created "directly", not in `migrations/`) | - | **kept indefinitely** |
| `auth.users` anonymous Companion identities | none | - | never pruned |
| Rate-limit counters (Upstash/memory) | expire at 2× window | store TTL | enforced |
| Cookies / local storage | lifetimes in code and notice | browser | enforced |

The notice (`PrivacyContent.tsx`, section *Retention*) states exactly this: the 7/180/90 rules are applied by a script run by hand and "not yet scheduled".
`web/tests/unit/privacy-disclosure.test.ts` fails if a migration ever schedules the cleanup, so the notice cannot silently become wrong.

## Prepared cleanup (NOT deployed, NOT scheduled)

`database/ops/retention_cleanup_install.sql` (objects), `retention_cleanup_schedule.sql` (two pg_cron jobs), `retention_cleanup_unschedule.sql` (kill switch), `retention_cleanup_monitoring.sql` (read-only checks). Tested by `database/tests/account/10_retention_cleanup.test.mjs` on a clone DB in the existing real-GoTrue CI job.

| Property | How |
| --- | --- |
| Same rules, no new period | claims 7 d, audit 180 d, tickets 90 d, API budgets 24 h |
| Bounded | ≤ `p_batch_rows` (default 100, max 1000) × `p_max_batches` (default 5) per task per run; backlog → `more_pending`, drains on later runs |
| No overlap | transaction-level advisory lock; a concurrent run exits as `skipped_locked` |
| Never blocks users | `lock_timeout` 5 s; each claim is deleted only if `pg_try_advisory_xact_lock(installation)` succeeds (the same key ingest/claim/transfer take), otherwise it is skipped and retried next run |
| Never deletes the wrong thing | consumed claims and claims referenced by a link row are never touched; tickets referenced by a device are kept |
| Isolated failures | one sub-transaction per task; a failing task rolls back alone and the others still run |
| Execution log | `private.retention_run_log`: run id, task, status, row count, batches, more_pending, SQLSTATE, ≤120-char message; **no personal data**; self-trimmed to 5000 rows |
| Failure visibility | `private.azerdex_retention_assert_healthy()` raises if the last real run failed or is older than 36 h → job shows `failed` in `cron.job_run_details` (a dry run never satisfies it) |
| Private | SECURITY DEFINER, `search_path=''`, no grant to public/anon/authenticated/service_role, log table RLS-on |
| Reviewable first run | `select private.azerdex_retention_run(p_dry_run := true);` counts without deleting |

**Not covered (no rule exists; decision needed)**: `device_audit`, `devices`, idle installations/Guildbook, `map_asset_diagnostics`, anonymous auth users, privacy-inbox correspondence.

### Installation sequence (each step needs separate owner authorization; none has been run)
1. Staging project: apply `retention_cleanup_install.sql`; run the dry run; review counts; run once for real; run `retention_cleanup_monitoring.sql`.
2. Production: same, then `retention_cleanup_schedule.sql`.
3. In the same change, update the notice's retention paragraph (claims/audit/tickets/counters become "removed automatically") and the guard test in `privacy-disclosure.test.ts`. Prefer assigning the next free migration number at that point (0018 is reserved by the Guildbook local-only work).
4. Kill switch any time: `retention_cleanup_unschedule.sql`.
