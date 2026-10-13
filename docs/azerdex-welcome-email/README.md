# AzerDex welcome e-mail V1 — secure outbox and worker

One transactional welcome message after a person's **first genuine registration e-mail verification**. Specification:
[design spec](https://github.com/Imemoth/wow-foreverdb/blob/docs/azerdex-welcome-outbox-design-20261013/docs/superpowers/specs/2026-10-13-azerdex-welcome-outbox-design.md) (lives on the design branch, not on this one) · plan:
[`../superpowers/plans/2026-10-13-azerdex-welcome-implementation.md`](../superpowers/plans/2026-10-13-azerdex-welcome-implementation.md).

| Document | Content |
| --- | --- |
| [gotrue-confirmation-probe.md](gotrue-confirmation-probe.md) | Evidence from real GoTrue: why the bare `email_confirmed_at` transition is unsafe and what distinguishes a signup confirmation |
| [resend-integration.md](resend-integration.md) | Payload, CID emblem, template-vs-HTML decision, outcome taxonomy, idempotency |
| [runbook.md](runbook.md) | Secrets, start/stop, monitoring, unknown outcomes, safe retry, recovery, GDPR, rollback |
| [acceptance.md](acceptance.md) | Evidence levels, executed test record, release blockers, owner-run acceptance steps |
| [security-review.md](security-review.md) | Independent security and code-quality review results |

## How the pieces interact

```
 website/GoTrue ──signup──▶ auth.users INSERT ──trigger──▶ private.azerdex_welcome_candidates        (only while intake switch ON, post-activation)
 user clicks signup link ─▶ auth.users UPDATE email_confirmed_at ─trigger (provenance rule)─▶ private.azerdex_welcome_outbox  (1 row / user, PK)
                                                   │ never fails the account flow: errors are caught, recorded, reconciled (≤50 rows, ≤7 days)
 pg_cron + pg_net (secret from Vault) ─▶ Edge Function azerdex-welcome-worker  (constant-time secret check, flag AZERDEX_WELCOME_ENABLED)
        ├─ public.azerdex_welcome_claim()   service_role only: leases ≤10 jobs (FOR UPDATE SKIP LOCKED, 180 s), re-verifies the live account
        ├─ Resend  POST /emails  (Idempotency-Key = azerdex-welcome-v1:<user>:<epoch>, CID emblem attached, 10 s timeout)
        └─ public.azerdex_welcome_finish()  sent | retry (429) | ambiguous (timeout/5xx/malformed) | permanent (4xx)
```

The account is usable the moment GoTrue confirms; nothing waits for the worker or Resend.

## Why a provenance rule (the central security finding)

On real GoTrue v2.197.0 a **password-recovery link used on a still-unconfirmed signup also sets `email_confirmed_at`** (and GoTrue audits it as
`user_signedup`). A trigger that only watched that column would send a "welcome" after a password reset. Migration 0015 therefore queues an event only
when, at the confirming UPDATE of a registered candidate: the row's `confirmation_token` was just cleared, the user's `confirmation_token` one-time
token still exists (recovery clears every token first), and `recovery_sent_at IS NULL`. Details and the full scenario table: the probe document. The rule
reads GoTrue internals, so `20_gotrue_provenance.test.mjs` is a tripwire to re-run on every GoTrue upgrade **and on the hosted Auth version** (gate G-2).

Known, documented edge cases of the rule: *recovery requested before the signup link is used* → no welcome (safe-side false negative);
*operator confirms a signup through the admin API* → looks like a signup confirmation (needs the service role; self-service signups after activation only).

## Evidence states (never conflate)

| State | Meaning | Today |
| --- | --- | --- |
| **Implemented** | code present in this PR | yes |
| **CI-verified** | the `AzerDex welcome outbox …` workflow green on the final head | see PR checks |
| **Local integration verified** | disposable PostgreSQL 16 + real GoTrue v2.197.0 + mocked Resend, run by the author | yes ([acceptance.md](acceptance.md)) |
| **Hosted staging verified** | isolated non-production Supabase + real Resend with an owner-controlled recipient | **no** — owner gate |
| **Production approved** | owner approvals for infrastructure rollout and first real recipient | **no** |

## Safety posture of this PR

All switches ship OFF (`enqueue_enabled`, `dispatch_enabled` default `false`; worker flag `AZERDEX_WELCOME_ENABLED` unset = off). The migration is not applied
anywhere, the function is not deployed, no cron is scheduled, no secret exists. #53–#56 are untouched; no web, Companion, addon or Vercel file changed.
