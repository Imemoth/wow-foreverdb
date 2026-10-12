# Account System V1 — acceptance and owner actions

> **Current status (2026-10-12):** Owner-authorized, Vercel-SSO-protected single-project **Preview pilot ACTIVE**, with registration, confirmation, logout, fresh password login and initial empty private-data pages verified by owner screenshots; see §4a. PR #53 is draft/unmerged and public Production OFF. The original isolated-staging plan below remains as historical acceptance criteria; cross-account, password recovery, refresh/expiry, A24 and public go-live gates are **PENDING**.


## 1. Evidence ledger rules

Each capability carries exactly one state; it only moves forward when the named evidence exists.

| State | Meaning | Required evidence |
| --- | --- | --- |
| IMPLEMENTED | code merged-ready in a PR | diff, unit tests locally |
| CI VERIFIED | GitHub Actions green on the PR's final head | run URL, check list |
| STAGING VERIFIED | executed against the isolated real Supabase Auth + Postgres (CI stack or the owner's staging project) | test log / run URL; for staging, the owner's confirmation |
| WINDOWS VERIFIED | executed on a real Windows Companion build | owner's acceptance table (same style as the F-3 runtime acceptance) |
| PRODUCTION APPROVED | owner approved activation | written approval; approved dry-run and rollback plan |
| BLOCKED / PENDING | not done | what is missing |

Passing mocks never advances a capability beyond IMPLEMENTED.

## 2. Per-PR acceptance gates

| PR | Gate to call it review-ready |
| --- | --- |
| A | account config/contract/static-boundary tests pass; full web suite passes on Node 24; mutation checks demonstrated; independent architecture and security review recorded; CI green on the final head |
| B | PR A gates + Playwright against real GoTrue with captured mail: sign-up, verify, login, logout, recovery, CSRF, redirect, enumeration, no-store, bundle scan; **no** installation or Guildbook access |
| C | forward-only `0012` + rollback; SQL suite (negative matrix, concurrency with parallel sessions, row-hash preservation, ACL assertions, `prosrc` hash of existing functions); runs in CI against ephemeral PostgreSQL and against real GoTrue; recovery runbook rehearsed |
| D | `dotnet test` regression suite on Windows CI (concurrent start, refresh rotation, failed refresh, sign-out, session switching, sync after claim, restart persistence, corrupt session file); new alpha build `0.9.0-alpha` per `docs/VERSIONING.md` (csproj, installer, CHANGELOG, ROADMAP) |
| E (as delivered) | integrated real GoTrue + real PostgREST + SQL suite in CI (`Account end-to-end (GoTrue + PostgREST)`), website linking with fresh password, private Guildbook, two-account isolation, replay/race/preservation, independent reviews; **STAGING VERIFIED and WINDOWS VERIFIED stay owner-pending** ([report](integration-and-acceptance-report.md), [staging runbook](staging-runbook.md), [Windows checklist](windows-acceptance-checklist.md)) |
| E (original gate) | cross-component run (including the Companion's anonymous sign-in and refresh under the staging Auth settings): web registration → email → Companion login; anonymous installation → claim → ownership; repeated sync with preserved history; two accounts + one anonymous identity denied everywhere; restart/expiry/logout/race/replay; evidence from CI and the owner's Windows machine |

Final Account System V1 acceptance requires real Windows and web evidence including two-account isolation and preserved historical data. No PR is merged automatically.

## 3. Owner action checklist

Nothing below was done by this work. Items marked **approval** change real settings, create resources or touch billing and need an explicit owner decision.

| # | Action | When | Approval |
| --- | --- | --- | --- |
| 1 | Review and merge PR A (specification + foundation) | now | review |
| 2 | Create an **isolated staging Supabase project** (never the production `wow-forever` project) and provide only its URL and publishable key to the Vercel *Preview* environment as `ACCOUNT_AUTH_MODE=staging`, `ACCOUNT_AUTH_URL`, `ACCOUNT_AUTH_PROJECT_REF`, `ACCOUNT_AUTH_PUBLISHABLE_KEY` and a random `ACCOUNT_CSRF_SECRET` of at least 32 characters (never to Production) | before PR E staging acceptance | **approval** (new resource, possible cost) |
| 3 | Staging Auth settings: confirm email **on**, custom SMTP with SPF/DKIM/DMARC, email templates using `token_hash` links to `/account/auth/confirm`, redirect URLs limited to the preview host pattern, leaked-password protection on, **Supabase CAPTCHA off** (it is project-wide and the Companion cannot satisfy it; the website uses its own Turnstile check, keys need approval), single-session-per-user / session time-box / inactivity timeout **off**, review Auth rate limits and anonymous sign-in limits, refresh-token rotation on | before PR B staging run | **approval** |
| 3a | Email templates for the staging Auth project link to `{{ .SiteURL }}/account/auth/confirm?token_hash={{ .TokenHash }}&type=email` (confirmation) and `…&type=recovery`; Site URL and redirect allow list = the exact preview callback; Upstash and Turnstile keys in the Vercel *Preview* environment (hosted account routes refuse to run without them) | before PR B staging run | **approval** |
| 3c | Add the CI check `Account end-to-end (GoTrue + PostgREST)` (GitHub Actions app, integration id 15368) to ruleset `24853899` once it reports consistently; verify the readback shows ten unique checks. (The password-reset session decision was taken: reset revokes every session, [security.md §6.1](security.md); record the hosted Auth behaviour on staging.) | after PR E | **approval** |
| 3b | Add the CI check `Account web auth (real GoTrue)` to the GitHub ruleset's required checks (and to the `Web release gate` aggregate) after PR B merges | after PR B | **approval** |
| 4 | Provide a Windows machine session for Companion acceptance (PR D/E): run W1a, W1b and W2..W10 of [companion.md §13](companion.md) in the environment each row names (W1a with the gate closed, AutoSync OFF and no production network writes; the others with `FOREVERDB_ACCOUNT_MODE=staging` against the staging project); record the result per row with separate evidence statuses | PR D/E | — |
| 5 | Keep Vercel Authentication on the demonstration; keep Production Branch = `release`; do not merge account PRs into `release` | always | — |
| 5a | Meet the **direct Auth abuse criteria** L-1..L-8, M-1..M-8, the runbook and the staging drill AT-1..AT-7 in §5 (threat A24, OPEN until evidenced; website Turnstile does not count) | staging, then before any production plan | **approval** |
| 6 | Before any production consideration: review the migration dry-run, rollback and recovery runbook; production leaked-password protection, SMTP, rate limits and CAPTCHA; decide quotas/tiering separately | later milestone | **approval** |
| 7 | Flipping `PRODUCTION_ACCOUNT_AUTH_APPROVED` and setting `FOREVERDB_DEPLOYMENT=production` | **not in V1** | **approval** + reviewed code change |

## 4. Explicit non-actions (verified, current)

**Historical PR E baseline:** when this acceptance report was originally written, 0012 had only run in disposable CI and the ledger ended at 0011. **Later owner-run update (2026-10-12):** 0012 `account_ownership_claims` is now applied to existing private Supabase, ledger version `20261012124839`; data fingerprints and owner counts verified unchanged, new account tables empty. The custom dump was archive-read checked but not restored to a disposable database. Email SMTP has been configured separately, and a test invite was delivered (spam placement); the test user was removed. That was the pre-pilot state; the later protected Preview pilot is now active (see §4a), while Vercel public Production/release account activation remains OFF. This does not complete the remaining acceptance gates.

## 4a. Owner protected Preview pilot – observed runtime acceptance (2026-10-12)

This is a **single-user, SSO-protected Vercel Preview pilot on the existing private Supabase project**; it does not advance the formal multi-user STAGING VERIFIED or public PRODUCTION APPROVED gates.

| Owner-run observation | Status | Basis and remaining scope |
| --- | --- | --- |
| Register with Cloudflare Turnstile, email confirmation | **PASS (protected pilot)** | Owner screenshots: `/account/register` form, generic `Check your email` response, Gmail **Inbox** arrival, confirmation interstitial, explicit confirm action, account profile. Resend delivery recorded. |
| Registered user / confirmed email / Auth session | **PASS (read-only DB verification)** | One registered confirmed Auth user and an Auth session observed; existing eight anonymous users unaffected. |
| Sign out then password sign-in, own profile restored | **PASS (owner browser)** | Screenshots show `You have been signed out`, then re-login and profile with `Email confirmed`. This does **not** establish refresh-token rotation or session expiry behavior. |
| Own installations and private Guildbook while unlinked | **PASS for initial empty state only** | Both pages render the correct `No installation is linked` message; DB link count 0, historical installation rows 7, guilds 2, members 46. Not evidence of cross-account isolation. |
| Logged-out direct private Guildbook access | **PASS (owner reported, 2026-10-12)** | After clicking Sign out, owner opened the protected private Guildbook URL directly and confirmed the page denied private access / required sign-in. This is a **single-account logged-out** boundary test, not a cross-account ownership test. |
| F5 browser session persistence | **PASS (owner reported, 2026-10-12)** | Owner explicitly confirmed reloading the signed-in Account page with F5 preserved access and the same profile. **This does NOT verify token refresh, expiry or rotation.** |
| Automatic refresh / session expiration | **PENDING** | Requires observed token expiry/rotation (not just F5) and revoked/expired-token denial. |
| Password recovery (email + new password + sign-in) | **PASS (owner browser, 2026-10-12)** | Owner screenshots show Turnstile, generic recovery request response, reset email in Gmail **Inbox**, explicit confirmation interstitial, new-password form, redirect to login with successful reset notice, rejected original password, and successful login with changed password. This establishes password replacement but is not by itself a multi-session revocation test. |
| All-session revocation after reset | **PENDING multi-client verification** | UI reports other account sessions were signed out, and backend CI covers this route, but the owner has not demonstrated an independently active second registered browser/Companion session being rejected after reset; avoid labelling hosted all-session invalidation PASS. |
| Ownership claim / transfer and two-account Guildbook isolation | **PENDING** | No claim code used; existing anonymous installation owners not touched. |
| Public production readiness and direct-GoTrue abuse A24 | **BLOCKED / PENDING** | No public promotion, PR #53 remains draft/unmerged; direct Auth project-wide abuse protections and recovery rehearsal still open. |

**Read-only Supabase after owner password-reset test (2026-10-12):** 1 registered and confirmed test account; `last_sign_in_at` populated; 1 recorded Auth session at inspection time; 8 anonymous Auth identities, 7 installations, 2 guilds, 46 member rows, and **0 account links**. Account/Companion ownership has not been transferred. This snapshot is not a historical session revocation proof.

**UX note:** The success banner currently says sessions were signed out \"including the Companion.\" This applies to Companion **registered sessions of the reset account**, not the unrelated anonymous Companion technical Auth identity; copy should explicitly distinguish them to prevent concern about anonymous sync. No change to account permissions or anonymous session is required.

**Deferred UI roadmap:** Show current account's `last_sign_in_at` in profile with Europe/Budapest timezone, then separately design a bounded, privacy-protected `Recent sign-ins` history with retention and account ownership. See [ROADMAP](../ROADMAP.md); no new table/ACL introduced here.

## 5. Direct Auth abuse: enforceable acceptance criteria (threat A24)

Model and rationale: [security.md §3.1](security.md) (six layers). **The website's Turnstile does not satisfy any criterion below**: it only covers requests that go through the website, while the Companion's public Supabase URL and publishable key let anyone call GoTrue directly. These criteria are owner-run gates; neither PR B nor PR C can close them, and none may be reported as passed without the named evidence. Threshold values are the **proposed initial ceilings**; the owner may set stricter values but a looser value needs a written justification in the evidence record. All counts are per source IP unless stated.

### 5.1 Auth limits (layer 2) and mail quotas (layer 5)

| ID | Criterion | Pass condition | Evidence |
| --- | --- | --- | --- |
| L-1 | Anonymous sign-ins | recorded limit ≤ 30 per hour per IP, with a written note of the expected Companion users behind one NAT | settings export/screenshot with date |
| L-2 | Password sign-in and email sign-up | recorded limit ≤ 30 per 5 minutes per IP | same |
| L-3 | Token refresh | recorded limit ≤ 150 per 5 minutes per IP (must not break a Companion refresh cycle) | same |
| L-4 | OTP / token verification | recorded limit ≤ 30 per 5 minutes per IP | same |
| L-5 | Email sends | custom SMTP in use (not the built-in sender); project email-send limit recorded; provider **hard daily cap** set at or below the owner's budgeted number | settings + provider console |
| L-6 | Sender authentication | SPF, DKIM and DMARC pass for the sending domain; a test confirmation and a test recovery email land in the inbox (not spam) | header evidence |
| L-8 | **IP attribution for server-side calls** | recorded evidence of how Auth derives the client IP for requests the website makes server-side (from shared Vercel egress addresses): either calls are attributed to the real client IPs, or the website's own per-IP throttle (layer 1) is strictly stricter than the Auth per-IP limits so one attacker cannot exhaust a shared Auth bucket through the website and lock real users out | AT-7 result + written note |
| L-7 | Account hygiene | confirm-email on; leaked-password protection on; password policy recorded; refresh-token rotation on; **CAPTCHA off, single-session-per-user off, session time-box off, inactivity timeout off/long** | settings export |

### 5.2 Monitoring and alerting (layer 6)

Read-only checks run **at least hourly** by a mechanism the owner chooses (scheduled job, external monitor) and **alert a named responder**; no check may use a service-role credential in the website. Thresholds below are proposals sized to today's population (8 anonymous users in total on production at the time of the audit), to be raised deliberately as real usage grows.

| ID | Signal (source) | WARN | CRITICAL |
| --- | --- | --- | --- |
| M-1 | anonymous users created per hour (`auth.users`, `is_anonymous`) | > 25 | > 100 |
| M-2 | permanent users created per hour | > 10 | > 40 |
| M-3 | unconfirmed email accounts older than 24 h (total) | > 50 | > 200 |
| M-4 | failed password sign-ins per hour (Auth audit log) | > 200 | > 1000 |
| M-5 | confirmation/recovery emails sent vs the daily cap | > 70 % | > 90 % |
| M-6 | provider bounce rate / complaint rate | bounce > 2 % | bounce > 5 % or complaints > 0.1 % |
| M-7 | claim redemptions rejected per hour (`private.account_audit`, once PR C exists) | > 20 | > 100 |
| M-8 | alert delivery test | a deliberately lowered threshold produces an alert at the named responder | — |

The owner records: the named responder and backup, the response targets (proposal: WARN reviewed next business day, CRITICAL within 2 hours), and where the alert goes.

### 5.3 Incident response runbook (must exist and be rehearsed on staging)

1. **Contain:** lower the affected per-IP limit, temporarily disable email sign-up, or pause the SMTP sender; do not disable anonymous sign-in without a Companion decision.
2. **Assess:** read-only counts of created users by hour, source, and confirmation state; identify the affected endpoint.
3. **Clean up:** delete abusive unconfirmed users in a reviewed, bounded query (never touching users that own installations: join `public.installations.owner_user_id`).
4. **Recover:** restore limits and sender after the burst ends; write a short incident note.
5. **Review:** adjust thresholds; if the publishable key itself is abused, plan a key rotation and a Companion update (a Companion release is required because the key is shipped in the app).

### 5.4 Staging abuse drill (owner-approved; bounded; **never against production or the live demonstration**)

Run only against the owner's isolated staging Auth project, from a single IP, with small bounded volumes, using throwaway addresses on a mail sandbox.

| ID | Drill | Expected |
| --- | --- | --- |
| AT-1 | 40 anonymous sign-ups in 60 s | HTTP 429 once the L-1 limit is reached; later calls recover after the window |
| AT-2 | 40 wrong-password sign-ins against one throwaway account in 60 s | HTTP 429 per L-2; the account is not locked out for other IPs unexpectedly |
| AT-3 | repeated sign-up and recovery requests to one address | the mail limit blocks further sends; no provider cap breach |
| AT-4 | the Companion's anonymous sign-in and token refresh **under the final settings** | succeeds (this is the check that proves CAPTCHA and session-coupling settings are really off) |
| AT-5 | M-8 alert delivery | alert reaches the named responder |
| AT-7 | from source A, exhaust the website's sign-up/sign-in throttle; from a second source B, sign in through the website | B still succeeds (no shared bucket); if B is refused, L-8 is not met and PR B must lower its own per-IP limits below Auth's |
| AT-6 | the website's Turnstile cannot be bypassed on `/account/api/*`, and a direct GoTrue call is stopped only by L-1..L-5 | documents, with evidence, exactly what layer 1 covers and what it does not |

### 5.5 Gates

- **Staging gate (before PR E can be called STAGING VERIFIED):** L-1..L-8 evidenced, AT-1..AT-7 recorded, M-1..M-8 configured on staging.
- **Production gate (before any production plan):** L-1..L-8 and M-1..M-8 evidenced on the **production** configuration by read-only export (no abuse drill is run against production without a separate explicit approval), the runbook rehearsed, the responders named, and the owner's written approval. Until then threat A24 is **OPEN** and production activation of accounts is BLOCKED.
