# Acceptance record — AzerDex welcome e-mail V1

Last updated 2026-10-16 (post-G-4, after `main` absorbed the account chain #53–#56). Environment of the local runs: Linux, PostgreSQL 16.15 (disposable cluster,
`track_commit_timestamp=on`), **real GoTrue v2.197.0** (pinned tag, commit `4eee58f`), in-process SMTP sink, **Resend mocked**, Node 22.22, Go 1.24.7, **Deno 2.9.6**.
No Supabase project, Resend account or Vercel setting was written to. Read-only checks of the live Supabase and Vercel accounts are listed explicitly where used.

## Evidence levels (never conflated)

| Level | State |
| --- | --- |
| Implemented | **Yes** |
| CI-verified | Recorded per head in the PR (checks of the exact head); not asserted in this file, which is part of that head |
| Local integration verified | **Yes** (below) |
| **Provider integration verified** (direct Resend API, owner-run) | **Yes for template + CID in Gmail desktop (G-4)**; *not* for the deployed Edge Function path, Gmail mobile or Outlook |
| Hosted staging verified | **No** — no staging project exists; creation needs the owner's approval ([staging-plan.md](staging-plan.md)) |
| Production approved | **No** |

## Repository state (2026-10-16)

`main` (`07879d0`) now contains the whole account chain #53–#56 (all pilot flags OFF), including migration `0014`. This branch merged `main` (no conflicts, no rebase).
`0015` still applies cleanly **in both orders** relative to `0014` (see tests). Production ledger (read-only check): `0014` recorded as `20261013112920 zero_touch_enrollment`; `0015` not applied.

## Executed tests (author, local, final code)

| Command | Result |
| --- | --- |
| `DENO_BIN=… FDB_REQUIRE_DENO=1 node --test tests/welcome-worker/*.test.mjs` | **44 / 44 pass** (`# tests 44 # pass 44 # fail 0 # skipped 0`) — worker 26 (incl. recipient validation and PNG structure checks), template-mode regression (TM-1…TM-11) 11, emblem/Deno bundle (AS-1…AS-6 incl. integrity) 7; real Deno 2.9.6 |
| `database/tests/welcome/stack.sh up` (= 0012 → **0014** → 0015, the order of a real project) + `node --test --test-concurrency=1 database/tests/welcome/*.test.mjs` | **67 / 67 pass** — privileges 9, real-GoTrue provenance 20, worker RPCs 26, worker↔DB 8, rollback/kill-switch/reinstall 4 |
| `database/ops/0015_staging_verification.sql` on that database | `OK` (privileges, forced RLS, 12 functions, 2 triggers) |
| Account suite on a fresh stack with 0012 **+ 0015** (`node --test --test-concurrency=1 database/tests/account/*.test.mjs`) | **219 / 219 pass** |
| Then `stack.sh apply14` (**0014 applied AFTER 0015**) + enrollment suite **without** `04_concurrency.test.mjs` | **88 / 88 pass** |
| `node database/tests/welcome/mutation_check.mjs` (migration text, 20 mutants) | `MUTATION CHECK OK` (exit 0: every mutant killed except the 2 documented equivalents; the last itemised run on this same migration text was 18 killed / 2 survivors) |
| Worker mutants (manual, template payload / breaker / idempotency key): drop `content_id`; html+template together; drop `CTA_URL`; no permanent-streak breaker; mode in idempotency key | **5 / 5 killed** (originals restored) |
| `scripts/azerdex-welcome-hosted-provenance.mjs` against the local real-GoTrue stack (`STATS_MODE=pg`, `ANON_KEY` set) | exit 0: S1–S5 and S7 pass, S6 informational; **7 synthetic users created and 7 deleted, outbox restored**. Guard negatives (production ref, look-alike hosts, `http`, ports, wrong ref format, non-loopback PGHOST) all refused. Validates the harness only — **not hosted evidence** |
| `web`: `npm run lint`, `npm run typecheck`, `npx vitest run` | lint clean, typecheck clean, **19 files / 397 tests pass** (includes the merged account/enrollment unit tests; no web file changed by this PR) |

**Known flake in the existing enrollment suite (not caused by 0015; observed LOCALLY):** `database/tests/enrollment/04_concurrency.test.mjs` → "ticket revocation racing redemption (30 rounds)" failed intermittently with `device_limit` instead of `enrolled`/`ticket_revoked` (the 30 rounds share one account; once enough rounds enrol the account hits its device limit, so the outcome depends on how many races are won). Observed on **fresh** local stacks: 2 of 3 runs failed WITHOUT 0015 and 1 of 3 WITH it (and it passed in the full runs above), i.e. it does not depend on 0015. It runs unfiltered in `main`'s own CI and passed there for #56, so its failure rate is evidently environment/load dependent: this is **not** a claim about CI on `main`. It is excluded from this PR's compatibility step only (documented in the workflow); a separate fix task was queued. Everything else in the enrollment suite passes.

**Not executed — not PASS:** hosted Supabase/Auth; the deployed Edge Function (any path); Supabase's own bundler; real Resend from the worker; Gmail mobile / Outlook rendering; direct *anonymous* HTTPS request to `https://azerdex.com/`;
Windows/Companion beyond CI; Web E2E locally (CI runs it).

## Requirement → test map

| Requirement | Tests |
| --- | --- |
| First genuine verification → one event; repeats/login/refresh → none | PV-1, PV-2, E2E-1 |
| Recovery never welcomes | PV-3, PV-4, PV-5, E2E-8 |
| E-mail change, anonymous, invite, pre-activation, switch OFF, metadata | PV-6 … PV-12, PV-19, PV-20 |
| Trigger failure never blocks registration/verification; reconcile; bounded | PV-14, PV-15, PV-16 |
| anon / authenticated / anonymous-JWT / service_role table access, RPC enumeration, spoofed role, no recipient parameter | PR-1 … PR-9 |
| Concurrent workers never send one event twice | WK-3, E2E-2 |
| Unauthorized worker invocation | WT-18 … WT-21, AS-5 (real Deno) |
| Unverified / deleted / e-mail-changed / banned → nothing sent | WK-15, WK-16, E2E-6 |
| Resend 429 / 5xx / timeout (headers and body) / malformed / 2xx variants / auth, in html **and template** mode | WT-8, WT-9, WT-9b, WT-12, WT-14b, TM-7, E2E-3, E2E-4 |
| **Template payload = the proven request shape** (exact keys, CID attachment byte-identical, only `CTA_URL`, no html/text) | TM-1, TM-2, TM-3 |
| Mode switch cannot mint a second idempotency key; reused key + different payload → 409 handled | TM-4, TM-5 |
| Template-wide misconfiguration parks ≤ 3 users per run | TM-6 |
| Real Resend id shape (UUID) accepted by worker and DB constraint | TM-11 |
| Mode selection fail-safe; fail-closed flags in template mode | TM-8, TM-9, TM-10 |
| Unknown outcomes never loop | WK-8 … WK-11, WK-25, E2E-4, E2E-5 |
| No secrets / personal data in logs and responses | WT-17, WT-19, WK-14, WK-20, AS-5 |
| Missing/corrupt CID attachment detected before sending | WT-4 (incl. CRC/IEND/trailing), AS-1, AS-1b, AS-6 |
| G-1 emblem committed, valid, pinned, embedded (no file read) | AS-1, AS-1b, AS-2, AS-3, AS-5 |
| Feature flags prevent sending | WT-1, WT-2, WK-1, E2E-7 |
| GDPR deletion / data minimisation | PV-18, WK-16, WK-21, WK-22 |
| Kill switch, rollback, reinstall, no pre-existing function changed; 0014/0015 in both orders | RB-1 … RB-4, Account 219/219, enrollment 88/88 |

## Gate status

| ID | Item | Status |
| --- | --- | --- |
| **G-1** | Emblem in the Edge Function | **PASS (repo)** — committed, hash-pinned, structurally verified, **embedded** in the import graph |
| **G-4** | Resend published template + CID attachment in one real send | **PASS — real provider test, Gmail desktop** (owner-run 2026-10-16, email id `01a143e5-595b-791a-a12a-421f3e444c19`, HTTP 200, `delivered`; owner-reported, **not re-verifiable from this environment**; details and limits in [resend-integration.md](resend-integration.md)). Open sub-checks: **R-1** Gmail mobile, **R-2** Outlook, **R-3** dark/light conversion; `Reply-To` and `Idempotency-Key` alongside a template to be confirmed on the first staging send |
| **G-5** | Resend domain verified, sending on, open **and** click tracking OFF | **PASS — owner-attested** (not independently verifiable; re-check in the dashboard before first send) |
| **G-7** | Deployed bundle contains the emblem | **Local PASS** (graph-only bundle, no file-read permission, corrupted emblem fails closed) and the design no longer depends on static files; **hosted check OPEN** |
| **B-1** | CTA `https://azerdex.com/` usable by an anonymous visitor | **OPEN** — see below |
| **G-2** | Provenance on the **hosted** Auth version | **OPEN** — harness ready and hardened (strict host guard, cleanup of its synthetic users, dispatch re-check), needs a staging project |
| **G-3** | Isolated hosted staging integration | **OPEN** — plan and costs in [staging-plan.md](staging-plan.md); needs one owner approval |
| **G-6** | Two explicit approvals (infrastructure rollout; first real recipient) | **OPEN** |
| Deployed worker send path (template mode) | | **OPEN** — direct provider success does **not** imply this path; verified only by mocked tests so far |

### B-1 — read-only audit, 2026-10-16

* **Domain configuration: OK.** `azerdex.com` is assigned to project `wow-foreverdb`, verified, DNS correct (`misconfigured: false`); `wow-foreverdb.vercel.app` redirects (307) to it.
* **Deployment: READY but old.** The apex alias points at a `production`-target deployment from commit `6b49a3f` (2026-10-11, unchanged since 2026-10-12), whose own commit message calls it *a protected synthetic-data preview*. The newer `main` builds (including the merged account stack) are **preview-target** deployments; the project's production-target list holds only two deployments.
* **Protection: ON for all deployments.** `ssoProtection: enabled, deploymentType: "all"` (password protection off, no trusted IPs). In Vercel's terms "all" includes **custom production domains**, so an anonymous visitor is expected to be challenged. (The default "standard" scope, `prod_deployment_urls_and_all_previews`, would leave only custom production domains public.)
* **Anonymous reachability: NOT proven.** This sandbox's gateway answers 403 to `CONNECT azerdex.com` (a gateway policy denial, **not** the site's response), and the Vercel fetch tools use the owner's authentication and would be misleading. **Owner step:** from a logged-out browser/network, `curl -sI https://azerdex.com/` must show `200` (not `401` / a Vercel login redirect).
* **Content/brand mismatch:** the production alias serves the *ForeverDB*-branded synthetic-data site (`robots: noindex` for non-release builds), not an AzerDex landing page. A "Welcome to AzerDex … Explore AzerDex" e-mail would land there. Even with protection relaxed, the CTA is only *useful* if the owner is happy for that site to be the public AzerDex landing page.
* **Smallest safe options (no change made; production changes need owner approval; protection is never disabled globally):** (a) if the current production alias content is acceptable publicly: change the project's Vercel Authentication scope from `all` to standard, which publishes only the custom production domain while previews and production deployment URLs stay protected; (b) otherwise a **separate minimal public AzerDex landing project** assigned to `azerdex.com`, leaving `wow-foreverdb` fully protected; (c) point the CTA to an already-public page. Option (b) isolates private previews, authenticated account routes and unreleased functionality best.
* **Pending third-party protection-bypass request** (alias `wow-foreverdb.vercel.app`, access `requested`, scope user, from an external Vercel user; identity omitted here): still `requested`, unchanged since 2026-10-13. **Not approved or denied** by this work; the owner should review it in the Vercel dashboard.

## Owner-run acceptance steps (minimum safe path)

1. **Approve one free staging project** (`azerdex-welcome-staging`, org `Hearth & Byte`, eu-west-1, $0) — [staging-plan.md §3](staging-plan.md).
2. Staging setup and checks ([staging-plan.md §4–5](staging-plan.md)): migrations incl. 0014 → 0015 (switches OFF), `0015_staging_verification.sql`, REST authorization probes, deploy the function, G-2 harness (`exit 0`, S1–S5 and S7 pass with `ANON_KEY`, cleanup restored; S6 informational), hosted G-7: an authorized invocation with the flag on and dispatch OFF answers `state: ok` (`disabled` proves nothing about the emblem).
3. **A-3/A-4 with an owner-controlled recipient only** (needs your explicit approval and your own `AZERDEX_WELCOME_ENABLED=true`): register → confirm → exactly one welcome; repeat link, login, password reset, e-mail change → none; confirm `Reply-To: support@azerdex.com`; Gmail mobile and Outlook (R-1…R-3); recommended `AZERDEX_WELCOME_MODE=template`.
4. **A-5 drills:** wrong `RESEND_API_KEY` (expect `provider_auth_failed`, nobody parked), template renamed/unpublished (expect ≤ 3 parked, then recover with `operator_requeue`), kill switch, secret rotation, unauthenticated invocation → 401.
5. **B-1:** decide the landing-page option and verify anonymous `200`.
6. Record redacted evidence here; then request the production approvals (G-6) and set production `AZERDEX_WELCOME_MODE=template` only after step 3 passed in that mode.
