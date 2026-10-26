# AzerDex Welcome Email V1 — Implementation Plan

**Date:** 2026-10-13 · **Spec (approved):** [`2026-10-13-azerdex-welcome-outbox-design.md`](https://github.com/Imemoth/wow-foreverdb/blob/docs/azerdex-welcome-outbox-design-20261013/docs/superpowers/specs/2026-10-13-azerdex-welcome-outbox-design.md) (on branch `docs/azerdex-welcome-outbox-design-20261013`)
**Branch:** `claude/azerdex-welcome-email-v1-mzlc7s` from `main` `ecda356` (historical baseline below); `main` has since absorbed the account chain and was merged back on 2026-10-16 (see the post-G4 round). **Scope:** isolated repository development, local tests and an unmerged **draft** PR. Nothing is applied, deployed, scheduled, enabled or merged.

## Baseline findings (task 0)

| Item | Finding |
| --- | --- |
| `main` (at planning time) | `ecda356`; migrations 0001–0012 (0010 reserved/unapplied under `private-export/`; 0013 exists only as `database/restore/`). |
| PR chain (at planning time; **merged to `main` since**) | #53 → #54 → #55 → #56, all **draft/open** then, heads `039d51a`, `b6c1937`, `f7b35e8`, `aa63f97`. #56 adds `0014_zero_touch_enrollment.sql` and edits `database/tests/account/stack.sh`. **Not touched, not rebased, not merged.** |
| Migration ID | `0014` reserved (#56); no `0015` anywhere on any chain branch → **`0015`**. 0015 references no 0012/0014 object and 0014 none of 0015's, so merge order is irrelevant. |
| Test harness | `database/tests/account/` (real GoTrue v2.197.0 + PostgreSQL 16, PostgREST emulated). Re-used; the welcome suites add their own `stack.sh` wrapper (SMTP sink, higher rate limits). The only edit to the existing suite is an exact-signature exclusion of 0015's 12 functions in `01_privileges.test.mjs` (see acceptance). |
| Existing UX | `/account/api/confirm` → `/account?welcome=1` shows "Your email address is confirmed. Welcome to ForeverDB." — states only the verified fact, never "email sent". **No web change is needed or made.** |
| CTA gate | Read-only Vercel check (rechecked 2026-10-14, correcting an earlier misread): `azerdex.com` **is** assigned to `wow-foreverdb` (verified, DNS ok) and aliased to a READY production-target deployment, but the project has `ssoProtection: enabled (all deployments)`. Anonymous reachability not tested. **B-1 stays open** (see acceptance record). |
| Resend | At planning time template + CID was unproven. **G-4 later PASSED** (owner-run real provider test, Gmail desktop, 2026-10-16). Both modes are implemented; code default stays rendered HTML, recommended operating mode `template` (see resend-integration.md). |

## Tasks

| # | Task | Evidence (TDD: tests written with/before code) | Status |
| --- | --- | --- | --- |
| 1 | Real-GoTrue provenance probe: which `auth.users` changes occur for signup / recovery / OTP / email change / invite / admin confirm | `database/tests/welcome/probe_gotrue_confirmation.mjs` → `docs/azerdex-welcome-email/gotrue-confirmation-probe.md`. **Finding: bare `email_confirmed_at` transition is unsafe** (recovery confirms unconfirmed signups). Distinguishing rule found and pinned. | done |
| 2 | Migration `0015`: private config/candidates/outbox/failures tables, RLS forced, no grants, FK `ON DELETE CASCADE`, hashed recipient | `10_privileges.test.mjs` (9) | done |
| 3 | Triggers on `auth.users` (signup candidate; confirm provenance → one event), no I/O, swallow + record failures, bounded reconciler | `20_gotrue_provenance.test.mjs` (20, real GoTrue) | done |
| 4 | Worker RPCs `azerdex_welcome_claim/_finish/_stats` (service_role only), leases, skip-locked, retry/unknown-outcome/idempotency-window, re-verification at dispatch, operator procedures, prune | `30_worker_rpc.test.mjs` (26) | done |
| 5 | Edge Function worker: config/flags, logo validation, payload (rendered HTML + text, or template), Resend taxonomy, run loop with circuit breaker, authenticated entry | `tests/welcome-worker/*.test.mjs` (44 now, incl. template-mode regression and real-Deno entry/bundle regression; 25 at first delivery) | done |
| 6 | Worker ↔ database integration (parallel workers, 429, timeout, crash, stale accounts, flags, recovery path) | `40_worker_e2e.test.mjs` (8) | done |
| 7 | Rollback / kill switch / reinstall / preservation of pre-existing functions | `50_rollback.test.mjs` (4) | done |
| 8 | Mutation check of the migration (20 mutants) | `mutation_check.mjs` | done (manual workflow) |
| 9 | CI workflow `azerdex-welcome-outbox.yml`; scheduler SQL (manual, `database/ops/`), rollback SQL (`database/rollback/`), function config | CI on the draft PR | done; CI result recorded in the PR |
| 10 | Docs: README, runbook, Resend integration, acceptance record, security review, ROADMAP, Account V1 index | this PR | done |
| 11 | Independent security review + code-quality review; fix actionable findings; re-run affected tests | [security-review.md](../../azerdex-welcome-email/security-review.md) | done |
| 12 | Existing regression suites (web lint/typecheck/vitest; Account SQL suite) | [acceptance.md](../../azerdex-welcome-email/acceptance.md) | done |
| 13 | Draft PR to `main` (not merge-ready) | PR | see PR |

## Verification gates (each must be green before the next phase)

1. `node --test tests/welcome-worker/worker.test.mjs` (no database).
2. Stack up + `node --test --test-concurrency=1 database/tests/welcome/*.test.mjs` (real GoTrue).
3. Account SQL suite green with 0015 applied (regression; only the exact-signature exclusion was added).
4. Web `lint`, `typecheck`, `vitest` unchanged (no web file is modified).
5. Independent reviews resolved.

## Explicit non-goals / forbidden in this task

Merging #53–#56; applying any migration to the live project; enabling auth or Companion gates; Vercel DNS/auth changes; deploying Edge Functions or Cron; real customer emails; test mails to third parties; hosted staging (owner-run gate).

## Post-G4 round (2026-10-16)

| # | Task | Evidence | Status |
| --- | --- | --- | --- |
| 14 | Merge `main` (account chain #53–#56 landed) into the branch; prove `0015` ⟂ `0014` in both orders | welcome suites on `0012→0014→0015`; Account 219/219 + enrollment 88/88 on `0012→0015→0014` | done |
| 15 | Record G-4 (owner-run real provider test) without personal data; keep deployed-path, Gmail mobile, Outlook as open checks | `acceptance.md`, `resend-integration.md` | done |
| 16 | Template-mode regression tests (exact request shape, CID byte-identity, 409 on payload change, template-wide failure, UUID id) | `tests/welcome-worker/template-mode.test.mjs` (TM-1…TM-11) | done |
| 17 | Remove the static-file dependency: embed the emblem (generated module + integrity check), Deno test with no file-read permission | `scripts/embed-azerdex-logo.mjs`, AS-1…AS-6 | done |
| 18 | Hosted-staging preparation: read-only discovery, staging plan, G-2 harness, staging verification SQL, 0015 ledger-record script | `staging-plan.md`, `scripts/azerdex-welcome-hosted-provenance.mjs`, `database/ops/0015_*` | done (nothing executed on hosted) |
| 19 | Vercel CTA / protection read-only audit (no change) | `acceptance.md` B-1 | done; B-1 OPEN |
| 20 | Final independent security + integration reviews on the final head | [security-review.md](../../azerdex-welcome-email/security-review.md) Round 3 | done |
