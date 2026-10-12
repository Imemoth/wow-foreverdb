# Account System V1 — threat model, abuse prevention, negative-test matrix

Scope: the Auth-only web boundary, the installation-claim protocol, account Guildbook reads and the Companion's registered sessions. The public-site model remains in [../web/threat-model.md](../web/threat-model.md).

## 1. Assets

| Asset | Where | Sensitivity |
| --- | --- | --- |
| Password, email address | Supabase Auth (private project) | high |
| Refresh token, access token | web: HttpOnly cookie; Companion: DPAPI file | high (account takeover) |
| Claim code (128-bit, 10 min) | shown once to the owner; hash in `private.installation_claims` | high while live |
| Installation ownership | `installations.owner_user_id`, `private.account_installations` | high (controls write access and Guildbook) |
| Guildbook rosters, professions, presence | private tables | medium (other players' game data) |
| Observations (loot, locations) | private tables | preserved; not user-secret |
| Anonymous rate-limit cookie | `__Host-fdb_sid` | low; unrelated to accounts |

## 2. Threats and mitigations

| ID | Threat | Mitigation | Verified by (PR) |
| --- | --- | --- | --- |
| A1 | Website reaches the private project through a configuration slip | closed `ACCOUNT_AUTH_*` validator; `production` hard-blocked; private ref rejected in the Auth URL and key in all spellings and, by the global guard, in the variables it scans (`FOREVERDB_*`, `PUBLIC_*`, `SITE_URL`, `UPSTASH_*`, `RATE_LIMIT*`, `TURNSTILE_*`, `CHALLENGE_*`, `NEXT_PUBLIC_*`, `TRUSTED_*`, and database/Supabase-named variables); service-role keys and names refused; accounts refused on Vercel's production target | unit matrix (PR A) |
| A2 | Public adapter or rate limiter gains private-database access | static import-boundary tests; no driver in account zone; account zone cannot import `lib/data` | static tests (PR A) |
| A3 | Browser JavaScript steals a token (XSS) | tokens only in HttpOnly cookies scoped to `/account`; nonce CSP unchanged; Auth origin/key never in bundles (bundle scan) | Playwright + bundle scan (PR B) |
| A4 | CSRF, including login CSRF | Origin equality, `Sec-Fetch-Site`, HMAC-signed double-submit token (`ACCOUNT_CSRF_SECRET`), `SameSite=Lax` session, POST-only mutations | Playwright (PR B) |
| A5 | Open redirect via `next`/callback | exact-pathname allowlist, encodings at any depth, query/fragment dropped | unit (PR A) + Playwright (PR B) |
| A6 | Mail scanner consumes the one-time confirmation/recovery token | GET interstitial without side effects, POST to verify | Playwright with captured mail (PR B) |
| A7 | Account enumeration | identical responses for sign-up/login/recovery, per-IP and per-email throttles | Playwright (PR B) |
| A8 | Stolen or revoked session still accepted, **including a revoked-but-unexpired anonymous token starting a claim** | server-confirmed user on every private page/API; **every** account function runs a live-session guard (`auth.sessions` row for the JWT's `session_id`, same user, not expired, user not deleted/banned); a tripwire linter makes the obvious weak implementations fail CI (the SQL tests are the proof) | SQL tests LS-1..LS-9 and LS-11 (PR C), Playwright (PR B), tripwire linter (PR A) |
| A9 | Unverified or anonymous caller reads account data or claims | `private.fdb_registered_caller()` (built on the live-session guard); anon JWT denied; unconfirmed email denied | SQL matrix (PR C) |
| A10 | Takeover with a leaked installation ID | IDs are never proof; redemption by code only; `claim_start` requires being the owner | SQL (PR C) |
| A11 | Code guessing, replay, expiry bypass | 128-bit code, hash at rest, single use, 10 min, attempts per claim, 10 redeems per 5 min per account, one failure shape | SQL (PR C) |
| A12 | Concurrent claims produce two owners | shared advisory lock with ingest, `for update`, partial unique index, PK on link | concurrent SQL test (PR C) |
| A13 | Former owner keeps writing | existing ingest owner check rejects it | SQL (PR C) + Companion (PR D) |
| A14 | Cross-account read of Guildbook or installation metadata | ownership re-derived from `auth.uid()` inside every function, empty set for non-owned, bounded paging, no GUIDs, no direct table grants | two-account + anonymous matrix (PR C, E) |
| A15 | Companion silently becomes a new anonymous owner | no anonymous fallback for registered sessions; kind marker; `ReauthRequired`; classified refresh failures (only a verified GoTrue session-gone reply changes identity state); the only anonymous sign-up is the explicit user action | .NET tests (PR D): `tests/companion-account`, [companion.md §3, §11](companion.md); WINDOWS VERIFIED pending |
| A16 | Torn/corrupt session file downgrades identity | atomic write (temp + replace), marker, `ReauthRequired` | .NET tests (PR D, `tests/companion-account`, [companion.md §11](companion.md)); WINDOWS VERIFIED pending |
| A17 | Credentials in `settings.json`, logs or diagnostics | none stored there; log redaction tests | .NET tests (PR D, `tests/companion-account`, [companion.md §11](companion.md)); WINDOWS VERIFIED pending |
| A18 | Sync under the wrong account after switching | single session gate, per-account local caches, in-flight response discard, status check before ingest | .NET tests (PR D, `tests/companion-account`, [companion.md §11](companion.md)); WINDOWS VERIFIED pending |
| A19 | Account code promoted to the production alias | validator refuses accounts on Vercel's production target; `release` is the only production branch and is not changed | unit (PR A) + release gates |
| A20 | Account data in public caches, sitemap, logs | `private, no-store`, noindex everywhere, excluded from sitemap, no PII logging | Playwright header checks (PR B) |
| A21 | Mass sign-up or anonymous sign-up abuse through the website | website Turnstile + per-IP/per-email throttles (layer 1 only; direct Auth access is A24) | Playwright (PR B) |
| A24 | **Direct Auth API abuse bypassing the website**: the Companion ships the project URL and publishable key and needs anonymous sign-up, so anyone can call GoTrue directly (anonymous sign-ups, password sign-in/stuffing, sign-up and recovery mail) without touching the BFF or its Turnstile check | **OPEN. Not resolved by any V1 code.** Layers 2, 5 and 6 of §3.1 (owner-managed) with enforceable criteria in the acceptance document | owner Auth settings + monitoring + staging drill (before any production plan) |
| A22 | An Auth setting silently breaks the Companion (project-wide CAPTCHA, single-session-per-user, session time-box, short inactivity timeout) | documented as forbidden for a project the Companion uses; staging acceptance runs the Companion's anonymous sign-in and refresh under the exact settings | staging (owner) + Win (PR E) |
| A23 | Claim feature exhausted by cheap accounts | per-uid budgets are the control; per-installation budget charged only after the owner check; global ceilings are alarms; denial is limited to claiming | SQL (PR C) |

## 3. Authentication abuse prevention (review)

Nothing here changes any Supabase setting; production Auth configuration is untouched. The Supabase values below are **criteria to verify on the staging project and again on production before activation** (documented defaults change over time); enforceable thresholds and the staging drill are in [acceptance-and-owner-actions.md §5](acceptance-and-owner-actions.md).

### 3.1 Six distinct layers (they protect different things and none substitutes for another)

| # | Layer | What it protects | What it does **not** protect | Owner of the control |
| --- | --- | --- | --- | --- |
| 1 | **Website-level bot protection**: server-side Turnstile verification in the `/account/api/*` sign-up and recovery handlers, per-IP and per-email throttles through the existing limiter | requests that reach **the website** | anything sent straight to Supabase Auth. The Companion ships the project URL and publishable key (and needs anonymous sign-up), so anyone can call GoTrue directly and never touch the website. **Layer 1 is not a CAPTCHA for Auth.** | code (PR B) |
| 2 | **Supabase Auth project-wide limits** (per source IP; **note:** the website calls Auth server-side from shared egress addresses, so unless Auth attributes those calls to the real client IP, all website users share one bucket: criterion L-8 and drill AT-7 settle this and the website's own per-IP throttle must be stricter than Auth's): per-IP rate limits for sign-up, sign-in, token refresh, OTP verification, email sends and anonymous sign-ins; confirm-email requirement; password policy; leaked-password protection | all Auth endpoints, including direct calls, per source IP | distributed or rotating-IP abuse; shared-NAT false positives (many Companion users behind one IP) | owner (Auth settings) |
| 3 | **Direct anonymous-signup abuse**: creating anonymous users in bulk (each one is a valid `authenticated` JWT that passes the existing API gate and gets its own per-UID budgets) | nothing in code; bounded only by layer 2 | the per-UID budgets are not an abuse control against account creation. The global ceilings in migration `0009` bound the cost, at the price of denial of service for everyone. | owner (limits + monitoring) |
| 4 | **Direct password-auth abuse**: credential stuffing and brute force against `/auth/v1/token?grant_type=password`; mass sign-up | layer 2 limits; email verification; leaked-password protection; the generic error shape | a determined distributed attacker; a strong-password policy does not stop stuffing | owner (limits + monitoring) |
| 5 | **Mail delivery and sign-up quotas**: confirmation and recovery email can be triggered directly, costing money and sender reputation and enabling mail-bombing of third parties | provider quotas, hard daily cap, bounce and complaint monitoring, custom SMTP with SPF/DKIM/DMARC | nothing if the default built-in sender is used: it is for testing, severely rate limited and restricted | owner (SMTP provider) |
| 6 | **Monitoring, alerting and incident response** | detection and containment of 3 to 5 | prevention | owner (named responder) |

**Decision (V1): Supabase project-wide CAPTCHA stays off** on any project the Companion uses, because CAPTCHA protection applies to anonymous sign-in and password sign-in and the Companion cannot supply a token; enabling it would break anonymous and registered Companion sign-in. This is a conscious trade-off: layers 2, 5 and 6 carry the load that CAPTCHA would otherwise share. Revisit only together with a Companion release that can present a CAPTCHA token.

**Threat A24 (direct GoTrue abuse) stays OPEN.** PR B and PR C code cannot resolve it. It is closed only by the owner-run criteria in the acceptance document being evidenced on staging and, before any production plan, on the production configuration.

### 3.2 Settings the product requires

- **Confirm email: on.** Specification and tests assume unverified users never obtain a session.
- **Custom SMTP** with domain authentication; never the built-in sender for public registration.
- **Leaked-password protection: on** (the project advisor currently reports it **disabled** on the production project).
- **Password policy** set in Auth; the website also enforces length locally for early feedback.
- **Refresh-token rotation: on**, default reuse interval kept.
- **Session-coupling settings off/long:** single session per user, session time-box, inactivity timeout. Otherwise a website login or logout would affect the Companion, which the product forbids.
- **Redirect URLs and Site URL** restricted to the exact callback URL(s) of the isolated environment (wildcards only for the owner's own preview host pattern in staging).
- **Anonymous sign-ins stay enabled** (the Companion needs them) and remain distinct from registered users in every check.

## 4. Residual risks (accepted for V1, with mitigation)

| Risk | Mitigation / owner decision |
| --- | --- |
| Account zone shares a process with the public site | static boundary, path-scoped cookie, no shared modules; option C (separate origin) remains available |
| A leaked live code can be redeemed by any verified account within 10 minutes | single use, 10-minute life, owner sees the claim result; the previous owner is told via `transferred`; recovery runbook |
| One registered UID shares the per-UID ingest budget across installations | documented; quotas deliberately unchanged in V1 |
| Access JWT validity window (default 1 h) | DB session check makes revoked sessions ineffective for account RPCs; existing public RPCs only need a valid JWT (unchanged) |
| `auth.sessions` is a Supabase-internal table | pre-flight check in the migration, CI and staging suites run against real GoTrue; documented as the one version dependency |
| Direct Auth API abuse: anonymous sign-up, password-auth and mail (A24) | the six-layer model in §3.1 and the criteria in the acceptance document (per-IP limits, thresholds, mail quotas, monitoring, incident runbook); **OPEN until evidenced**, tracked in the go-live checklist |
| An **active** stolen anonymous bearer can start a permanent claim (V1 adds a persistent takeover capability that ingest alone never had) | a revoked, deleted or banned session cannot (live-session guard, tests LS-1..LS-9 and LS-11); single-use short-lived code; audit and previous-owner record; the legitimate Companion sees `transferred`; owner-approved restore runbook. Residual window = lifetime of an undetected, still-active token |
| Mail delivery/phishing of confirmation emails | custom SMTP with domain authentication; no secrets in email bodies |

## 5. Mandatory-test map (the 20 required checks)

State legend: tier of evidence the check needs to be called passed. **Unit/static** = CI. **SQL** = ephemeral PostgreSQL with Auth emulation in CI (PR C) and real GoTrue in CI/staging (PR E). **E2E** = Playwright against a real isolated Auth stack. **Win** = real Windows Companion (owner).

| # | Check | PR | Tier |
| --- | --- | --- | --- |
| 1 | Web signup and verified login | B, E | E2E (CI real Auth), staging |
| 2 | Unverified email denied for privileged operations | B, C | E2E + SQL |
| 3 | Password recovery and safe callback handling | B | E2E (captured mail) |
| 4 | Registered sessions survive refresh/restart | B, D | E2E; .NET + Win |
| 5 | Registered refresh failure cannot fall back to anonymous | D | .NET unit + Win |
| 6 | Anonymous Companion collection and sync still work | D, E | .NET + Win |
| 7 | Valid claim succeeds exactly once | C, E | SQL; staging |
| 8 | Expired and replayed claims fail | C | SQL |
| 9 | Leaked installation ID without owner proof cannot claim | C | SQL |
| 10 | Two concurrent claims cannot produce dual ownership | C | SQL (parallel sessions) |
| 11 | Anonymous owner loses write access after transfer | C, D | SQL; Win |
| 12 | Existing loot/location/Guildbook rows unchanged | C | SQL (row-hash before/after) |
| 13 | Multiple installations per registered user | C, E | SQL; staging |
| 14 | User A cannot read or transfer User B's installation | C, E | SQL; staging |
| 15 | Anonymous and unverified users cannot read account Guildbook | C | SQL |
| 16 | Logout immediately removes access to private pages/APIs | B | E2E |
| 17 | Public loot search remains anonymous | A, B | static (A), E2E (B) |
| 18 | No tokens, private records or credentials in public pages, caches, bundles | A, B | static + bundle scan + header checks |
| 19 | No regression in ingest quotas, search, F-3 statistics, Companion Guildbook | C, D | SQL (existing suites + `prosrc` hash) ; Win |
| 20 | Preview cannot promote account code or private data to the production alias | A | unit (validator refuses Vercel production target) + release policy |

Checks 1, 3, 4, 16 need a real Auth server; they are never marked passed on mocks. The CI job started in PR B runs the Supabase local stack (GoTrue, PostgREST, Postgres, Mailpit) inside GitHub Actions, which is isolated and disposable.

### Additional negative tests required by the independent reviews

| ID | Check | PR | Tier |
| --- | --- | --- | --- |
| **LS-1** | **Revoked-but-unexpired anonymous JWT cannot start a claim even when its UID still equals `installations.owner_user_id`** | C | SQL |
| LS-2 | JWT without `session_id` is refused by every account function | C | SQL |
| LS-3 | `session_id` of another user is refused | C | SQL |
| LS-4 | Expired session (`not_after` in the past) is refused | C | SQL |
| LS-5 | Deleted or banned user with a still-present session row is refused | C | SQL |
| LS-6 | Revoked registered token cannot redeem; the claim stays pending | C | SQL |
| LS-7 | Initiator revoked after issuing a claim: redeem returns `invalid_claim`, nothing consumed | C | SQL |
| LS-8 | LS-1..LS-5 parameterised over `ACCOUNT_RPC_GUARDS` (no function can be forgotten) | C | SQL |
| LS-9 | Real GoTrue: anonymous token contains `session_id`; after `/auth/v1/logout` the unexpired token is refused | C, E | CI real stack, staging |
| LS-10 | `lintAccountMigration` tripwire passes on every migration that mentions an account function (a canonical-style whitelist tested with every demonstrated bypass in PR A and mutation-checked; **not** an integration test and not a proof) | A, C | unit/CI |
| LS-11 | Concurrent revocation vs `claim_start` (row lock) | C | SQL, parallel sessions |
| PW-1 | Password validation: ASCII, multibyte, boundary lengths, and with no `Buffer` global; contracts bundled for the browser run in a bare context | A | unit (done) |
| AT-1..AT-7 | Auth abuse drill and monitoring criteria ([acceptance §5](acceptance-and-owner-actions.md)) | owner | staging (not code) |
