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
| A8 | Stolen or revoked session still accepted | server-confirmed user on every private page/API; DB re-checks `auth.sessions` for the JWT's session | SQL + Playwright (PR B, C) |
| A9 | Unverified or anonymous caller reads account data or claims | `fdb_registered_caller()`; anon JWT denied; unconfirmed email denied | SQL matrix (PR C) |
| A10 | Takeover with a leaked installation ID | IDs are never proof; redemption by code only; `claim_start` requires being the owner | SQL (PR C) |
| A11 | Code guessing, replay, expiry bypass | 128-bit code, hash at rest, single use, 10 min, attempts per claim, 10 redeems per 5 min per account, one failure shape | SQL (PR C) |
| A12 | Concurrent claims produce two owners | shared advisory lock with ingest, `for update`, partial unique index, PK on link | concurrent SQL test (PR C) |
| A13 | Former owner keeps writing | existing ingest owner check rejects it | SQL (PR C) + Companion (PR D) |
| A14 | Cross-account read of Guildbook or installation metadata | ownership re-derived from `auth.uid()` inside every function, empty set for non-owned, bounded paging, no GUIDs, no direct table grants | two-account + anonymous matrix (PR C, E) |
| A15 | Companion silently becomes a new anonymous owner | no anonymous fallback for registered sessions; kind marker; `ReauthRequired` | .NET tests (PR D) |
| A16 | Torn/corrupt session file downgrades identity | atomic write (temp + replace), marker, `ReauthRequired` | .NET tests (PR D) |
| A17 | Credentials in `settings.json`, logs or diagnostics | none stored there; log redaction tests | .NET tests (PR D) |
| A18 | Sync under the wrong account after switching | single session gate, per-account local caches, in-flight response discard, status check before ingest | .NET tests (PR D) |
| A19 | Account code promoted to the production alias | validator refuses accounts on Vercel's production target; `release` is the only production branch and is not changed | unit (PR A) + release gates |
| A20 | Account data in public caches, sitemap, logs | `private, no-store`, noindex everywhere, excluded from sitemap, no PII logging | Playwright header checks (PR B) |
| A21 | Mass sign-up or anonymous sign-up abuse | Auth rate limits, website-side Turnstile before Auth, SMTP limits, anonymous sign-in limits (below) | staging (owner) |
| A22 | An Auth setting silently breaks the Companion (project-wide CAPTCHA, single-session-per-user, session time-box, short inactivity timeout) | documented as forbidden for a project the Companion uses; staging acceptance runs the Companion's anonymous sign-in and refresh under the exact settings | staging (owner) + Win (PR E) |
| A23 | Claim feature exhausted by cheap accounts | per-uid budgets are the control; per-installation budget charged only after the owner check; global ceilings are alarms; denial is limited to claiming | SQL (PR C) |

## 3. Authentication abuse prevention (review)

These are Supabase project settings; none is changed by this work. Values below are statements to **verify on the staging project and then on production before activation** (Supabase changes documented defaults over time):

- **Email verification stays on.** "Confirm email" must be enabled; the specification and tests assume unverified users never obtain a session.
- **Do not use the default mail sender for public registration.** The built-in SMTP is intended for testing with very low limits and restricted recipients. Staging and any future production need an owner-chosen custom SMTP provider (SPF/DKIM/DMARC) and a deliverability test.
- **Auth rate limits:** review the per-IP limits for sign-up/sign-in, token refresh, OTP verification, email sends and anonymous sign-ins; confirm they suit the Companion population (anonymous sign-ups come from user machines, many behind shared NAT) and a public website.
- **CAPTCHA:** Supabase's CAPTCHA protection is **project-wide** (sign-up, anonymous sign-in, password sign-in, recovery) and the Companion cannot supply a token, so enabling it on a project the Companion uses would break anonymous and registered Companion sign-in. Decision for V1: **do not enable Supabase CAPTCHA** on a Companion-facing project; instead the website verifies Turnstile server-side (existing challenge code) before it calls Auth for sign-up and recovery, and relies on Auth per-IP limits, custom SMTP and email verification. Real Turnstile keys need owner approval.
- **Leaked-password protection:** the project advisor currently reports it **disabled** on the production project; enable it in staging and plan it for production (owner).
- **Password policy:** minimum length and requirements set in Auth; the website also enforces length and rejects obviously weak input locally for early feedback.
- **Refresh-token rotation and reuse interval:** keep rotation enabled; the default reuse interval tolerates concurrent refreshes.
- **Settings that couple sessions:** *single session per user*, session time-box and inactivity timeout must stay **off/long** so website and Companion sessions remain independent (requirement of the product).
- **Redirect URLs and Site URL:** restricted to the exact callback URL(s) of the isolated environment (wildcards only for the owner's own preview host pattern in staging).
- **Anonymous sign-ins stay enabled** (the Companion needs them) but remain distinct from registered users in every check.

## 4. Residual risks (accepted for V1, with mitigation)

| Risk | Mitigation / owner decision |
| --- | --- |
| Account zone shares a process with the public site | static boundary, path-scoped cookie, no shared modules; option C (separate origin) remains available |
| A leaked live code can be redeemed by any verified account within 10 minutes | single use, 10-minute life, owner sees the claim result; the previous owner is told via `transferred`; recovery runbook |
| One registered UID shares the per-UID ingest budget across installations | documented; quotas deliberately unchanged in V1 |
| Access JWT validity window (default 1 h) | DB session check makes revoked sessions ineffective for account RPCs; existing public RPCs only need a valid JWT (unchanged) |
| `auth.sessions` is a Supabase-internal table | pre-flight check in the migration, CI and staging suites run against real GoTrue; documented as the one version dependency |
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
