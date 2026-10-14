# Acceptance record — AzerDex welcome e-mail V1

Runs: 2026-10-13/14. Environment: Linux, PostgreSQL 16.15 (disposable cluster, `track_commit_timestamp=on`), **real GoTrue v2.197.0** (pinned tag, commit `4eee58f`), in-process SMTP sink, **Resend mocked**, Node 22.22, Go 1.24.7, **Deno 2.9.6**. No Supabase project, Resend account or Vercel setting was written to.

## Evidence levels

| Level | State |
| --- | --- |
| Implemented | **Yes** |
| CI-verified | Recorded per head in the PR (checks of the final head); not asserted in this file, which is part of that head |
| Local integration verified | **Yes** (below) |
| Hosted staging verified | **No** (owner gate) |
| Production approved | **No** |

## Executed tests (author, local, final code)

| Command | Result |
| --- | --- |
| `DENO_BIN=… FDB_REQUIRE_DENO=1 node --test tests/welcome-worker/*.test.mjs` | **32 / 32 pass** — worker 25, emblem/bundle regression (`asset-and-deno.test.mjs`) 7 |
| `database/tests/welcome/stack.sh up` + `node --test --test-concurrency=1 database/tests/welcome/*.test.mjs` | **67 / 67 pass** — privileges 9, real-GoTrue provenance 20, worker RPCs 26, worker↔DB 8, rollback/kill-switch/reinstall 4 |
| `node database/tests/welcome/mutation_check.mjs` | 20 mutants: **17 killed, 3 survivors, all documented equivalents / defence-in-depth**; original restored |
| Existing Account suite on a fresh stack with 0012 **and 0015** applied (`node --test --test-concurrency=1 database/tests/account/*.test.mjs`) | **219 / 219 pass** (`01_privileges.test.mjs` excludes 0015's 12 functions **by exact signature**; negative check: adding one stray function makes that assertion fail, removing it passes) |
| `web`: `npm run lint`, `npm run typecheck`, `npx vitest run` | clean, clean, **332 / 332** (no web file changed) |

*History:* an earlier run (before the account-test isolation) was 218/219; the single failure was that suite's hard-coded "exactly nine new functions" count seeing 0015's functions. It was resolved by the exact-signature exclusion, **not** by loosening the count. The assertion is unchanged for every other function.

**Not executed — not PASS:** hosted Supabase/Auth; real Resend (any mode); **Supabase's own function bundler/deploy** (only a local Deno run of a staged bundle containing the import graph + declared `static_files` was done); Windows/Companion (untouched); browser E2E; e-mail client rendering; direct anonymous request to `https://azerdex.com/`.

## Requirement → test map

| Requirement | Tests |
| --- | --- |
| First genuine verification → one event | PV-1 |
| Repeat confirmation / login / refresh → none | PV-2, E2E-1 |
| Recovery never welcomes | PV-3, PV-4, PV-5, E2E-8 |
| E-mail change, anonymous, invite, pre-activation, switch OFF, metadata | PV-6 … PV-12, PV-19, PV-20 |
| Trigger failure never blocks registration/verification; reconcile; bounded | PV-14, PV-15, PV-16 |
| anon / authenticated / anonymous-JWT / service_role table access, RPC enumeration, spoofed role, no recipient parameter | PR-1 … PR-9 |
| Concurrent workers never send one event twice | WK-3, E2E-2 |
| Unauthorized worker invocation | WT-18, WT-19, WT-20, WT-21, AS-5 (real Deno) |
| Unverified / deleted / e-mail-changed / banned → nothing sent | WK-15, WK-16, E2E-6 |
| Resend 429 / 5xx / timeout (headers and body) / malformed / 2xx variants / auth | WT-8, WT-9, WT-9b, WT-12, WT-14b, E2E-3, E2E-4 |
| Unknown outcomes never loop | WK-8 … WK-11, WK-25, E2E-4, E2E-5 |
| No secrets / personal data in logs and responses | WT-17, WT-19, WK-14, WK-20, AS-5 |
| Missing/invalid CID attachment detected before sending | WT-4, AS-1, AS-1b, AS-6 |
| **G-1** emblem committed, valid, pinned | AS-1, AS-1b (chunk CRCs, no metadata chunks), AS-2 (sha256 pin) |
| **G-7 (local part)** bundle layout: declared `static_files`, entry finds emblem; without it fails closed | AS-3 (line-anchored config check), AS-5, AS-6 |
| Feature flags prevent sending | WT-1, WT-2, WK-1, E2E-7 |
| GDPR deletion / data minimisation | PV-18, WK-16, WK-21, WK-22 |
| Kill switch, rollback, reinstall, no pre-existing function changed | RB-1 … RB-4, Account suite 219/219 |

## Gate status

| ID | Item | Status |
| --- | --- | --- |
| **G-1** | 128×128 emblem in the Edge Function | **PASS (repo)** — `azerdex-logo.png`, 6,819 B, from the owner's `AzerDex-Icon-128.png`, hash-pinned, structurally verified |
| **G-7** | Deployed bundle contains the emblem | **Partial** — local Deno staged-bundle regression PASS; **hosted deploy check OPEN** (authorized invocation must answer `ok`/`disabled`, never `logo_invalid`) |
| **G-5** | Resend domain verified, sending enabled, open **and** click tracking OFF | **PASS — owner-attested 2026-10-14** (not independently verifiable from the repository; re-check in the dashboard before first send) |
| **B-1** | CTA `https://azerdex.com/` usable by an anonymous visitor | **OPEN** — see below |
| **G-2** | Provenance tripwire on the **hosted** Auth version | **OPEN** (no evidence; do not mark PASS) |
| **G-3** | Isolated hosted staging acceptance | **OPEN** |
| **G-4** | Resend **template + CID** attachment in one real send | **OPEN** (default stays rendered HTML + CID; template mode opt-in) |
| **G-6** | Two explicit approvals: infrastructure rollout; first real recipient | **OPEN** |

### B-1 — rechecked 2026-10-14 (read-only Vercel API), corrected

* **Domain configuration: OK.** `azerdex.com` *is* assigned to project `wow-foreverdb`, verified, DNS correct (`misconfigured: false`, A records at Vercel); `wow-foreverdb.vercel.app` redirects (307) to it. *(An earlier version of this record said the domain was not among the project's domains; that was wrong — the first read returned a truncated project object. Corrected.)*
* **Deployment availability: OK.** The apex alias points to a `READY` production-target deployment (commit `6b49a3f`, whose own message calls it a protected synthetic-data preview).
* **Deployment protection: ON.** `ssoProtection: enabled, deploymentType: all` (password protection off, no trusted IPs). Vercel Authentication on all deployments means an anonymous visitor is expected to be challenged, not shown the site.
* **Not verified:** an actual anonymous request to `https://azerdex.com/` (the sandbox cannot reach it; the Vercel fetch tools use the owner's authentication and would be misleading). **Owner step:** from a logged-out browser/network, `curl -sI https://azerdex.com/` must return `200` (not `401`/a Vercel login redirect) and show useful content. Protection was **not** changed (needs owner approval). Note: a third-party protection-bypass *request* ("requested", not granted) exists on the `wow-foreverdb.vercel.app` alias — worth reviewing in the Vercel dashboard.
* Remaining blocker is therefore *SSO protection / anonymous reachability (and the page being a useful public landing page)*, not domain assignment.

## Owner-run acceptance steps (minimum safe path)

* **A-2** isolated staging Supabase project; `0015` (switches OFF); deploy the function; secrets ([runbook §2–4](runbook.md)); confirm an authorized invocation answers `ok`/`disabled` (G-7 hosted, G-2 via the provenance matrix on that Auth version).
* **A-3** with an **owner-controlled recipient**: register → confirm → exactly one welcome; repeat link, login, password reset, e-mail change → none; recovery on an unconfirmed signup → none.
* **A-4** inspect in Gmail desktop/iPhone and Outlook: emblem inline (CID), dark palette, text part, CTA works, Reply-To `support@azerdex.com`; optionally `AZERDEX_WELCOME_MODE=template` and repeat (G-4).
* **A-5** failure drills: wrong `RESEND_API_KEY` (expect `provider_auth_failed`, nobody parked), kill switch, secret rotation, unauthenticated invocation → 401.
* **A-6** record redacted evidence here; request production approvals (G-6) only after B-1.
