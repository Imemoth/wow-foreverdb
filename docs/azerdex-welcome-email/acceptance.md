# Acceptance record — AzerDex welcome e-mail V1

Date of runs: 2026-10-13. Environment: Linux, PostgreSQL 16.15 (disposable cluster, `track_commit_timestamp=on`), **real GoTrue v2.197.0** (built from the pinned tag, commit `4eee58f`), in-process SMTP sink, Resend **mocked**, Node 22.22, Go 1.24.7. No Supabase project, Resend account or Vercel setting was contacted for writing.

## Evidence levels

| Level | State |
| --- | --- |
| Implemented | **Yes** |
| CI-verified | **Pending** — workflow `AzerDex welcome outbox SQL + real GoTrue + worker` must be green on the final head (see the PR checks; not claimed here) |
| Local integration verified | **Yes** (results below) |
| Hosted staging verified | **No** (owner gate) |
| Production approved | **No** |

## Executed tests (author, local)

| Command | Result |
| --- | --- |
| `node --test tests/welcome-worker/worker.test.mjs` | **25 / 25 pass** |
| `database/tests/welcome/stack.sh up` then `node --test --test-concurrency=1 database/tests/welcome/*.test.mjs` | **67 / 67 pass** — privileges 9, real-GoTrue provenance 20, worker RPCs 26, worker↔DB end-to-end 8, rollback/kill-switch/reinstall 4 |
| `node database/tests/welcome/mutation_check.mjs` | 20 mutants: **17 killed, 3 survivors, all documented equivalents/defence-in-depth** (`confirmation_token` just-cleared check, `SKIP LOCKED` under READ COMMITTED, claim-time attempts cap duplicated by `finish`); "original restored" |
| Existing Account SQL suite with 0015 additionally applied (`database/tests/account/*.test.mjs`) | **218 / 219** — the single failure is the account suite's hard-coded "exactly nine new functions" count in `01_privileges.test.mjs`, which now also sees 0015's 12 functions; every pre-existing function was verified byte-identical (also asserted by RB-4). The account workflow does not apply 0015, so it is unaffected; the shared test file was deliberately not edited (it is also edited by #56's chain). *This run preceded the review-driven hardening; the changes since touch only 0015 objects.* |
| `web`: `npm run lint`, `npm run typecheck`, `npx vitest run` | clean, clean, **332 / 332** (no web file changed; baseline on `main`) |

Not executed: GitHub Actions run, Windows/Companion tests (untouched), hosted Supabase, real Resend (any mode), `Deno.serve`/static-file bundling in a deployed Edge Function, browser/E2E, Gmail/Outlook rendering. **These are not marked PASS.**

## Requirement → test map

| Requirement | Tests |
| --- | --- |
| First genuine verification → one event | PV-1 |
| Repeat confirmation / login / refresh → no more | PV-2, E2E-1 |
| Recovery never welcomes (unconfirmed signup, confirmed account, recovery-before-signup-link) | PV-3, PV-4, PV-5, E2E-8 |
| E-mail change, anonymous, invite, pre-activation, switch OFF, metadata | PV-6, PV-7, PV-8, PV-9, PV-10, PV-11, PV-12, PV-19, PV-20 |
| Trigger failure does not block verification/registration; reconcile; bounded | PV-14, PV-15, PV-16 |
| Anonymous/authenticated/service-role table access, RPC enumeration, spoofed role, no recipient parameter | PR-1 … PR-9 |
| Concurrent workers cannot send one event twice | WK-3, E2E-2 |
| Unauthorized worker invocation | WT-18 (and WT-19/20/21) |
| Unverified / deleted / e-mail-changed / banned accounts → nothing sent | WK-15, WK-16, E2E-6 |
| Resend 429 / 5xx / timeout (headers and body) / malformed / 2xx variants / auth | WT-8, WT-9, WT-9b, WT-12, WT-14b, E2E-3, E2E-4 |
| Unknown outcomes never loop | WK-8, WK-9, WK-10, WK-11, WK-25, E2E-4, E2E-5 |
| Logs/responses free of secrets and personal data | WT-17, WT-19, WK-14, WK-20 |
| Missing/invalid CID attachment detected before sending | WT-4 |
| Feature flags prevent sending | WT-1, WT-2, WK-1, E2E-7 |
| GDPR deletion / data minimisation | PV-18, WK-16, WK-21, WK-22 |
| Kill switch, rollback, reinstall, no pre-existing function changed | RB-1 … RB-4 |

## Release blockers and owner gates (all OPEN)

| ID | Item |
| --- | --- |
| **B-1** | CTA destination: read-only Vercel check 2026-10-13 — project `wow-foreverdb` has `ssoProtection` enabled for all deployments; `azerdex.com` is not among its domains; `live: false`. Do not enable sending until `https://azerdex.com/` is publicly reachable and useful. |
| G-1 | Supply the 128×128 PNG emblem (`supabase/functions/azerdex-welcome-worker/azerdex-logo.png`, ≤ 16 KB). |
| G-2 | Re-run the provenance tripwire against the **hosted** Auth version on staging (rule reads GoTrue internals; fails closed if they differ). |
| G-3 | Hosted staging acceptance on an isolated non-production project. |
| G-4 | Prove Resend **template + CID attachment in one send** (until then default `html` mode). |
| G-5 | Resend domain open/click tracking OFF; domain verified (SPF/DKIM/DMARC). |
| G-6 | Two explicit approvals: infrastructure rollout; first real recipient. |
| G-7 | Verify the Edge Function bundles `azerdex-logo.png` (`static_files`) — staging smoke test. |

## Owner-run acceptance steps (minimum safe path)

* **A-1** add the emblem PNG. **A-2** create an isolated staging Supabase project; apply 0012-equivalent baseline as needed and `0015` (switches OFF); deploy the function; set secrets ([runbook §2–4](runbook.md)).
* **A-3** with an **owner-controlled recipient**: register → confirm → exactly one welcome; repeat link, login, password reset, e-mail change → no second mail; recovery on an unconfirmed signup → none.
* **A-4** inspect the message in Gmail desktop/iPhone and Outlook: emblem inline (CID), dark palette, text part, CTA works, Reply-To `support@azerdex.com`; optionally flip `AZERDEX_WELCOME_MODE=template` and repeat.
* **A-5** failure drills: wrong `RESEND_API_KEY` (expect `provider_auth_failed`, nobody parked), kill switch, worker secret rotation, unauthenticated invocation → 401.
* **A-6** record redacted evidence here, then request the production approvals.
