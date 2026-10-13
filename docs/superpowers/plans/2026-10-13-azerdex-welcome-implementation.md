# AzerDex Welcome Email V1 — Implementation Plan

**Date:** 2026-10-13 · **Spec (approved):** [`2026-10-13-azerdex-welcome-outbox-design.md`](https://github.com/Imemoth/wow-foreverdb/blob/docs/azerdex-welcome-outbox-design-20261013/docs/superpowers/specs/2026-10-13-azerdex-welcome-outbox-design.md) (on branch `docs/azerdex-welcome-outbox-design-20261013`)
**Branch:** `claude/azerdex-welcome-email-v1-mzlc7s` from `main` `ecda356`. **Scope:** isolated repository development, local tests and an unmerged **draft** PR. Nothing is applied, deployed, scheduled, enabled or merged.

## Baseline findings (task 0)

| Item | Finding |
| --- | --- |
| `main` | `ecda356`; migrations 0001–0012 (0010 reserved/unapplied under `private-export/`; 0013 exists only as `database/restore/`). |
| PR chain | #53 → #54 → #55 → #56, all **draft/open**, heads `039d51a`, `b6c1937`, `f7b35e8`, `aa63f97`. #56 adds `0014_zero_touch_enrollment.sql` and edits `database/tests/account/stack.sh`. **Not touched, not rebased, not merged.** |
| Migration ID | `0014` reserved (#56); no `0015` anywhere on any chain branch → **`0015`**. 0015 references no 0012/0014 object and 0014 none of 0015's, so merge order is irrelevant. |
| Test harness | `database/tests/account/` (real GoTrue v2.197.0 + PostgreSQL 16, PostgREST emulated). Re-used unchanged; the welcome suites add their own `stack.sh` wrapper (SMTP sink, higher rate limits). |
| Existing UX | `/account/api/confirm` → `/account?welcome=1` shows "Your email address is confirmed. Welcome to ForeverDB." — states only the verified fact, never "email sent". **No web change is needed or made.** |
| CTA gate | Read-only Vercel check (2026-10-13): project `wow-foreverdb` has `ssoProtection: enabled (all deployments)`, `azerdex.com` is **not** among its domains, `live: false`. **Release blocker B-1** (see acceptance record). |
| Resend | Template + CID attachment in one send is **unproven** (no provider access here; docs show attachments only with `html`/`text` examples). Implemented both modes; default = rendered HTML (proven path). **Owner gate G-4.** |

## Tasks

| # | Task | Evidence (TDD: tests written with/before code) | Status |
| --- | --- | --- | --- |
| 1 | Real-GoTrue provenance probe: which `auth.users` changes occur for signup / recovery / OTP / email change / invite / admin confirm | `database/tests/welcome/probe_gotrue_confirmation.mjs` → `docs/azerdex-welcome-email/gotrue-confirmation-probe.md`. **Finding: bare `email_confirmed_at` transition is unsafe** (recovery confirms unconfirmed signups). Distinguishing rule found and pinned. | done |
| 2 | Migration `0015`: private config/candidates/outbox/failures tables, RLS forced, no grants, FK `ON DELETE CASCADE`, hashed recipient | `10_privileges.test.mjs` (9) | done |
| 3 | Triggers on `auth.users` (signup candidate; confirm provenance → one event), no I/O, swallow + record failures, bounded reconciler | `20_gotrue_provenance.test.mjs` (20, real GoTrue) | done |
| 4 | Worker RPCs `azerdex_welcome_claim/_finish/_stats` (service_role only), leases, skip-locked, retry/unknown-outcome/idempotency-window, re-verification at dispatch, operator procedures, prune | `30_worker_rpc.test.mjs` (26) | done |
| 5 | Edge Function worker: config/flags, logo validation, payload (rendered HTML + text, or template), Resend taxonomy, run loop with circuit breaker, authenticated entry | `tests/welcome-worker/worker.test.mjs` (25) | done |
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
3. Account SQL suite unchanged and green with 0015 applied (regression).
4. Web `lint`, `typecheck`, `vitest` unchanged (no web file is modified).
5. Independent reviews resolved.

## Explicit non-goals / forbidden in this task

Merging #53–#56; applying any migration to the live project; enabling auth or Companion gates; Vercel DNS/auth changes; deploying Edge Functions or Cron; real customer emails; test mails to third parties; hosted staging (owner-run gate).
