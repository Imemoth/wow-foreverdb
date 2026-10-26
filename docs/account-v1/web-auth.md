# Account System V1 — PR B: web authentication (as built)

Status: **IMPLEMENTED; CI VERIFIED against real GoTrue** (evidence: the `Account web auth (real GoTrue)` job, see §7). Production activation stays **BLOCKED** (code constant, owner approval). Installation linking, claim codes and the Guildbook are **not** part of this PR (PR C backend, later UI).

This page describes what was built and what was *observed* about the real Auth server. The normative design is [architecture.md](architecture.md), [security.md](security.md) and [pr-obligations.md](pr-obligations.md); nothing here changes a shared contract (`contracts.ts`, `config.ts`) or a PR A decision.

## 1. Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/account` | GET | profile (server-confirmed user); redirects to sign-in when not signed in |
| `/account/login`, `/register`, `/forgot-password` | GET | forms (client components; JavaScript required) |
| `/account/auth/confirm` | GET | **interstitial** for e-mail links: renders a button, **no side effect** |
| `/account/reset-password` | GET | new-password form, only with a live recovery session |
| `/account/api/csrf` | GET | mints the CSRF token + its `SameSite=Strict` twin cookie |
| `/account/api/register`, `/resend`, `/forgot-password` | POST | generic answers; Turnstile + per-address throttle |
| `/account/api/login` | POST | password sign-in; sets the session cookie |
| `/account/api/confirm` | POST | the **only** place a one-time e-mail token is consumed |
| `/account/api/reset-password` | POST | new password inside the recovery session, then ends it |
| `/account/api/logout` | POST | `scope=local` logout, clears the cookie |
| `/account/api/me` | GET | minimal profile JSON (server-confirmed) |
| `/account/api/session/refresh` | GET | server components cannot set cookies: refresh/clear then redirect to an **allowlisted** page |

Everything is under `/account` and `/account/api/*`; there is no `/api/account` (static test). With `ACCOUNT_AUTH_MODE` unset (the default) every one of these answers **404** and nothing else runs.

## 2. Architecture

```
browser ──(same origin, JSON + signed CSRF)──▶ /account/api/*  ──▶ accountApi() wrapper ──▶ auth-client.ts ──▶ Supabase Auth (GoTrue)
   │                                              │  disabled→404, unavailable→503            only publishable key
   └─ HttpOnly sealed cookie (Path=/account)      │  Origin + Fetch-Metadata + JSON + signed token
                                                  │  strict body (zod), then handler
```

* **One Auth wrapper** (`lib/account/auth-client.ts`): one function per operation, `isAllowedAuthRequest(method, pathAndQuery, {callbackUrl})` on every call, bodies parsed with the strict `AUTH_BODIES`, `redirect: "manual"`, bounded and schema-checked responses, **only** the machine `error_code` ever leaves it (never Auth's text), no logging. Only the publishable key and the user's own access token are sent. A static test forbids Auth paths or `fetch` of Auth anywhere else.
* **Session cookie** `__Secure-fdb_acct` (https) / `fdb_acct` (local http): the Auth session **sealed** (AES-256-GCM, key derived from `ACCOUNT_CSRF_SECRET` by HKDF, AAD = cookie name), `HttpOnly; Secure; SameSite=Lax; Path=/account`, `Max-Age` 14 days sliding (renewed at each refresh), **absolute cap 30 days** (`sc` in the payload never slides), recovery sessions 15 minutes. Chunked (`.1` … `.5`) only if it ever outgrows one cookie. The browser can read neither tokens nor payload.
* **Identity is never read from the cookie.** `resolveSession()` asks Auth (`GET /user`: signature **and** the session row still exists) with the stored access token on every private page and API. A user is accepted only if: the answer's id equals the stored uid, `is_anonymous` is not true, an e-mail exists and is **confirmed**. `getSession()` is never used (static test).
* **Refresh** happens only where cookies can be set (route handlers; a page redirects through `/account/api/session/refresh`). A refresh answering for a different user ends the session; a definitive Auth refusal (4xx) ends it and clears the cookie; transient failures (network, 5xx, 429) never log anyone out. A just-refreshed session cannot loop through the redirect.
* **Logout** calls `POST /auth/v1/logout?scope=local` (pinned in the allowlist), then clears the cookie and **every chunk on `/account` and on `/`**. A new sign-in in the same browser best-effort revokes the session it replaces.
* **CSRF**: `Origin` equal to `SITE_URL` (or no `Origin` and `Sec-Fetch-Site: same-origin`), `Sec-Fetch-Site` same-origin when sent, `Content-Type: application/json`, header token == `SameSite=Strict` cookie token, token = `v1.nonce.exp.HMAC(binding, nonce, exp)` with the binding the web session id (`anon` before sign-in). Login and registration are covered (login CSRF). The edge repeats the origin check **before counting** so a hostile page cannot burn a victim's budget.
* **Confirmation / recovery**: e-mail links open `/account/auth/confirm?token_hash=…&type=…` (no side effect; scanner GETs do nothing), the page strips the token from the address bar at once (`history.replaceState`), Account HTML uses `Referrer-Policy: strict-origin` in both header and meta (origin only, never the path/query/token), and the button POSTs to `/account/api/confirm`. An **honest** recovery link (`type=recovery`) yields a **recovery session** that opens nothing except the new-password form; after the password changes that session is revoked and the user signs in afresh. Limitation (verified, test `rectype`): Auth treats `type` loosely, so a recovery token presented as `type=email` yields a normal session; the website cannot tell a token's purpose, and the holder of a recovery link could reset the password anyway, so no power is added. Confirmation also **never replaces a live session** (409 `already_signed_in`): a phished link cannot swap a signed-in victim into another account.
* **Edge (`proxy.ts`)**: `/account/api/*` is API traffic with its own strict, fail-closed budgets (`account_auth`: 10 per IP / 5 min, 25 global; `account_light`: 60 per IP / min); `/account/**` never receives or issues the anonymous `__Host-fdb_sid` cookie and always carries `Cache-Control: private, no-store`, `X-Robots-Tag: noindex, nofollow` (also in production). Account HTML uses `Referrer-Policy: strict-origin` so native same-origin form POSTs carry the real Origin without exposing a path/query; Account API/file responses remain `no-referrer` and carry the API CSP. `proxy.ts` imports no account module (static test).
* **Abuse prevention**: per-IP (edge) and per-address (HMAC of the normalised e-mail, derived key, store never sees an address): register 5/h, resend 3/h, recover 3/h, login 10/15 min. Exhausted budgets answer exactly like a normal success (mail routes) or like any failed login (`429 too_many_attempts`, identical for existing and non-existing addresses). Turnstile is verified **server-side before** Auth is contacted on register, resend and recovery; an unreachable verifier answers 503 (fail closed). On a **hosted** deployment the account routes answer 503 unless the distributed rate limiter (`RATE_LIMIT_BACKEND=upstash`) **and** Turnstile (`TURNSTILE_SECRET_KEY` + site key) are configured.
* **Turnstile does not protect Auth.** The Companion ships the project URL and publishable key; anyone can call GoTrue directly. Threat **A24 remains OPEN** and is closed only by the owner-run criteria L-1..L-8 / M-1..M-8 / AT-1..AT-7 in [acceptance-and-owner-actions.md §5](acceptance-and-owner-actions.md). Nothing in this PR is described as resolving it.
* **Separation**: no database driver, no `lib/data`, no `security/identity` import in the zone; the public adapters never import account code; `Auth` configuration is read only through `serverEnv().accountAuth`.

## 3. What was verified against the real GoTrue (supabase/auth v2.197.0)

These are facts the implementation depends on. Each one is exercised by `web/tests/account/*.spec.ts` in CI.

| Observation | Consequence in the code |
| --- | --- |
| Sign-in of an **unconfirmed** user answers `email_not_confirmed`, an unknown user `invalid_credentials` | an enumeration oracle if forwarded; the website returns one 401 for wrong password, unknown and unconfirmed |
| Sign-up of an existing unconfirmed address inside the send gap answers **429 `over_email_send_rate_limit`** | masked: that code, and every other verdict about the address, answers like a fresh sign-up |
| A body-less `POST /signup` creates an **anonymous** user | impossible from the website (`AUTH_BODIES.signup` requires e-mail + password); anonymous identities are rejected as web sessions |
| Confirmation works with `POST /verify {type:"email", token_hash}`; replay → 403 `otp_expired` | explicit POST only; replay answers a generic `invalid_or_expired` |
| Recovery `verify` returns a full session; `PUT /user` needs no re-authentication in a recovery session; `type=email` also accepts a recovery token (indistinguishable `amr`) | honest links get an isolated recovery session (own kind, 15 min, reset form only); the type cannot be enforced (see §2 limitation) |
| Changing the password inside a **recovery** session ended the account's other sessions in v2.197.0 (re-observed in PR E; an earlier note here said it did not), and the hosted version is unverified | the website no longer relies on it: since PR E a successful reset runs its own verified global logout ([security.md §6.1](security.md)) |
| Parallel refreshes with the **same** refresh token all receive the **same** successor token | concurrent serverless requests converge; test 10b |
| Replaying the parent of the active token is allowed until the child is used; a copy two rotations behind, beyond the 10 s window, is refused (`refresh_token_already_used`) | the stale copy never authenticates and its cookie is cleared; test 10c records what happens to the live session (v2.197.0: not terminated) |
| After `logout?scope=local` the session's access token fails `GET /user` with 403 `session_not_found`; other sessions of the same user (and anonymous ones) keep working | server-confirmed identity gives immediate revocation; session independence test 7 |
| Access tokens contain `session_id` and `is_anonymous` | used for the CSRF binding; PR C's live-session guards rely on the same claim |
| Refresh tokens are short opaque strings (12 characters) | `AUTH_BODIES.refresh_grant` (min 10) accepts them |
| A foreign `redirect_to` is silently ignored for the link when the template uses `{{ .SiteURL }}` | the website only ever sends its own callback; the e-mail template must build the link from the Site URL (owner setting) |
| `/auth/v1/*` is a gateway prefix (GoTrue itself serves `/`) | the CI stack puts a small gateway shim in front, see `web/tests/auth-stack/README.md` |

## 4. Acceptance mapping (20 required checks)

| # | Check | Test (all against real GoTrue + captured mail unless noted) |
| --- | --- | --- |
| 1 | Registration | `flows` 1-2 |
| 2 | E-mail confirmation | `flows` 1-2, `ui` registration |
| 3 | Unverified-user restrictions | `flows` 3; unit `acceptableUser` cases |
| 4 | Valid login | `flows` 4, 4b |
| 5 | Invalid login | `flows` 5 |
| 6 | Logout / current-session revocation | `flows` 6, `ui` expiry |
| 7 | Separate-session independence | `flows` 7 |
| 8-9 | Recovery, reset | `flows` 8-9, `ui` recovery |
| 10 | Token rotation, expiry, concurrent refresh | `sessions` 10a-10d, `ui` transparent refresh |
| 11 | CSRF rejection | `security` §11 (matrix incl. login CSRF, signed/unsigned/expired/foreign-bound tokens) |
| 12 | Open-redirect rejection | `security` §12, `flows` 4 |
| 13 | Generic enumeration-safe responses | `flows` 1, 3, 5, 8, resend; `security` §13 |
| 14 | Turnstile rejection / bypass | `security` §13 (live Siteverify in CI; fail-closed 503 asserted where Cloudflare is unreachable) |
| 15 | Cookie flags and path scoping | `security` §14 (http and https-on-the-wire), `ui` (no account cookie on public requests) |
| 16 | Public caching / noindex | `security` §15 |
| 17 | No credential leakage to bundles | `security` §16, `check:bundle-secrets` with account canaries |
| 18 | Public loot search regression | `security` §17 + the existing web E2E suites |
| 19 | Disabled / fail-closed modes | `security` §18 (Vercel production target: disabled, refused, hosted-without-protections) |
| 20 | Browser bundle of the isomorphic contracts, multibyte passwords, no `Buffer` | `ui` "browser bundle" (real Chromium, production Next bundle), `account-contracts` esbuild test (PR A) |

Plus: unit (`account-web-lib`, 41 tests: crypto, cookies/chunking/deletion, every `resolveSession` branch, CSRF tables, the Auth wrapper, throttles, edge rules) and static (`account-web-static`, 12 tests, mutation-checked) tests; WCAG 2.2 AA axe checks on every account page and state; keyboard and 375 px layout checks.

## 5. Findings and decisions

Independent review (fresh reviewer, static, no prior conclusions supplied): **no Critical, no High**; 4 Medium, 8 Low/Info. Outcomes:

| ID | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| R-M1 | Medium | The e-mail link is not bound to the requesting browser: (a) a phished link could sign a victim into the attacker's account and (b) an attacker who registers the victim's address with a known password (pre-hijack) gets a victim who confirms into that account | (a) **fixed**: confirm refuses to replace a live session (409), tested. (b) **open by design for V1**: closing it needs PKCE or an intent cookie, which breaks "confirm on another device"; harmless today (profile only) but **a binding obligation before the linking UI exists**: the claim flow must show the account e-mail and require password re-entry. **Closed for linking in PR E** ([web-linking.md §3](web-linking.md)); the lingering-session residual is tracked in [security.md §6](security.md) |
| R-M2 | Medium | Shared Auth bucket (L-8): per-IP 10 does not stop several IPs; the global 300 did not bound Auth's ≤ 30 / 5 min | **fixed**: global ceiling lowered to 25 / 5 min (below Auth's recorded limit). Accepted trade-off: a distributed flood (about 3 IPs) can hold the ceiling and block website sign-in/sign-up (not the Companion). Real attribution evidence (AT-7) is still the owner's gate |
| R-M3 | Medium | Per-address budgets are a targeted lockout (login 10 / 15 min, recovery 3 / h silently dropped, register 5 / h); plus-address variants have separate keys | **accepted, documented (W-1)**: needs repeated attacker traffic through the edge limits; recovery still cannot be spent without a Turnstile solution when Turnstile is configured. Revisit with (address, IP) buckets or address canonicalisation if abused |
| R-M4 | Medium | Enumeration through timing and the 5xx shape on mail routes | **fixed in part**: mail routes now take a fixed minimum 700 ms, and an Auth 5xx (possibly address-specific, e.g. SMTP failure) is answered like success and logged; only an unreachable Auth is reported (503). Not fixed: GoTrue's own login timing (bcrypt only for existing users) is internal to Auth |
| R-L1 | Low | Hosted protections were keyed to Vercel only | **fixed**: required on every non-local deployment, plus https |
| R-L2 | Low | The recovery-session isolation claim was false for dishonest links | **corrected** (verified with real GoTrue; characterisation test); no added power |
| R-L3 | Low | `token_hash` is in the query string (platform request logs, history before `replaceState`) | accepted: Auth's standard link shape; app logs are clean; a fragment-based template is an owner option |
| R-L4 | Low | Logout hid a failed server-side revocation | **fixed**: the UI warns when `revoked` is false |
| R-L5 | Low | Any Auth 4xx ended a session (a rotated key would sign everyone out) | **fixed**: only refusals naming a dead credential (`refresh_token_*`, `session_not_found`, `bad_jwt`, user gone/banned) end a session; others are transient (unit-tested) |
| R-L6 | Low | Turnstile checks only `success` (no hostname/action pin, no remoteip) | accepted for V1 (documented); bot protection only |
| R-L7 | Low | `GET /session/refresh` side effects | **tightened**: only `same-origin`/`none` Fetch-Metadata is processed |
| I-1 | Info -> High (re-rated by the PR E review) | A password reset must revoke other sessions (pre-registered/stolen sessions) | **RESOLVED in PR E by owner decision**: `logoutAllAfterRecovery` ([security.md §6.1](security.md)) |
| W-2 | Medium | Shared egress (L-8) | see R-M2 |
| W-3 | Medium | Direct GoTrue abuse (A24) | **OPEN** by design; owner-run L/M/AT criteria; website Turnstile is website-only |
| W-4..6 | Low | one `GET /user` per private view; forms need JavaScript; a stale cookie copy is refused at its next refresh | accepted |
| I-2, I-3 | Info | no header link while accounts are off; the local memory limiter is per process (hosted refuses to run without Upstash) | accepted |

## 6. Owner actions (nothing below was done by this PR)

1. Review and merge; **add `Account web auth (real GoTrue)` to the ruleset's required checks** (it is not yet part of the pinned six / the `Web release gate` aggregate: that file was left unchanged to avoid colliding with PR C).
2. For the future staging project: the Auth e-mail templates must link to `{{ .SiteURL }}/account/auth/confirm?token_hash={{ .TokenHash }}&type=email` (confirmation) and `…&type=recovery`; Site URL = the preview origin; redirect allow list = that exact callback only; plus every setting in [acceptance §3 (items 2-3)](acceptance-and-owner-actions.md); Upstash and Turnstile keys for the preview environment (hosted accounts refuse to run without them).
3. L-1..L-8, M-1..M-8, AT-1..AT-7 (A24) remain owner-run.
4. `PRODUCTION_ACCOUNT_AUTH_APPROVED` stays `false`; `FOREVERDB_DEPLOYMENT=production`, Vercel Production Branch (`release`), migration `0010` and the production Supabase project were not touched.

## 7. Evidence

CI job `Account web auth (real GoTrue)` (`.github/workflows/account-web-auth.yml`): builds GoTrue from the pinned `supabase/auth` tag, starts PostgreSQL 16 and Mailpit, runs the production build with account configuration and canary secrets, the bundle scan, and the whole `playwright.account.config.ts` suite. If the stack cannot start the job fails: acceptance would be **BLOCKED**, never "passed on mocks". The stack deviates from `supabase start` (Docker, Kong, PostgREST) deliberately and visibly: the website talks to GoTrue only; the gateway shim in `web/tests/auth-stack/stack-server.mjs` forwards untouched.
