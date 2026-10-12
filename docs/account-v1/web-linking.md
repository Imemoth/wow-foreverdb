# Account System V1 — PR E: website linking, installation list and private Guildbook (as built)

Status: **IMPLEMENTED; CI VERIFIED against real GoTrue + real PostgREST + PostgreSQL when the `Account end-to-end (GoTrue + PostgREST)` check passes on the final head** (see [integration-and-acceptance-report.md](integration-and-acceptance-report.md)). **STAGING VERIFIED: no. WINDOWS VERIFIED: no. PRODUCTION APPROVED: no** (`PRODUCTION_ACCOUNT_AUTH_APPROVED = false`, accounts disabled by default).

Nothing here changes a shared contract (`ACCOUNT_RPCS`, `AUTH_ENDPOINTS`, `config.ts`), a SQL migration or the Auth security model: the website only gained the closed database client and the reviewed reauthentication step the PR B hand-off (finding R-M1) made mandatory.

## 1. Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/account/link` | GET | form only (no side effect): server-confirmed account e-mail, explanation, code input, fresh-password field, explicit confirmation. Any query string is dropped by a redirect (a code is never accepted from or kept in a URL) |
| `/account/api/link` | POST | redemption (below) |
| `/account/installations` | GET | installations owned by the signed-in account (server-rendered from `fdb_account_installations`) |
| `/account/api/installations` | GET | the same list as JSON (narrow endpoint for the one RPC; nothing is read from the request) |
| `/account/guildbook` | GET | private Guildbook browser (client component, in-memory state only) |
| `/account/api/guildbook/guilds`, `/account/api/guildbook/members` | POST | JSON bodies (CSRF-protected, so ids never appear in URLs or request logs); read-only |
| `/account` | GET | overview now links to the three pages (the "not available yet" placeholder is gone) |

All routes sit under `/account`; there is no `/api/account`, no generic RPC proxy and no route that takes an RPC name. With `ACCOUNT_AUTH_MODE` unset every one of them answers **404** and nothing else runs.

## 2. Redemption: order of checks (pinned by a static test)

`POST /account/api/link` body `{ code, password, confirm: true }` (strict; nothing else is accepted):

1. **Approved wrapper** (`accountApi`): disabled -> 404, unavailable protections -> 503, signed CSRF + exact Origin + Fetch Metadata + JSON, bounded strict body.
2. **Identity** (`authenticate()` -> `resolveSession`): Auth `GET /user` with the stored access token, per request. Anonymous, expired, revoked, deleted, unconfirmed, wrong-user and **recovery-only** sessions are `401 unauthenticated` (recovery cookies are a different `kind`).
3. **Code shape** (`normalizeClaimCode`): a malformed code is `400 invalid_code_format` and nothing is sent anywhere.
4. **Password budgets**, then the **fresh password check** (`reauth.ts`): per verified account (5 per 15 min) **and** the per-address sign-in throttle the login route uses (so both website paths share one pool of guesses). Fail closed (503) if the limiter is unavailable. The edge adds the per-IP budget (`link` is a strict `account_auth` route: 10 per IP, 25 global per 5 min, below Auth's own limit, finding L-8).
5. **Identity re-check** immediately before forwarding (`GET /user` with the original web token): a logout/revocation/deletion during step 4 ends the request.
6. **Redemption budget** (10 per hour per account, after the password was confirmed), then **`fdb_account_claim_redeem`** through the closed PostgREST client with **the original web session's own access token**.

Answers: `200 {ok, installationId, linkedAt, reauthCleanup}`; `422 invalid_claim` (invalid, expired, consumed, revoked, replaced, owner-mismatched: one body); `409 account_limit` (valid code, **not consumed**); `401 reauth_failed` (wrong password; nothing about other accounts); `401 unauthenticated`; `403 forbidden` (not a confirmed registered account); `429` with `Retry-After` (website budgets, Auth rate limit, or the database's `PT429`); `502 outcome_unknown` (see §4); `503` (outage / limiter down). Authentication failures are never disguised as claim failures, and the database error text is never returned.

## 3. Pre-hijack protection and the temporary session (R-M1)

Threat: an attacker registers the victim's e-mail with a password only the attacker knows; the victim confirms the address and lands in a session of that account. A confirmation link, a CSRF token, a recent page load or an on-screen e-mail must **never** authorise moving an installation.

What the website does before every redemption: it shows the exact server-confirmed destination e-mail, requires the account password **again**, and verifies it against the **same** Auth project:

1. `auth.passwordGrant({ email: <the VERIFIED e-mail>, password })` (the e-mail comes from the server-confirmed identity, never from the request; the closed wrapper, `AUTH_BODIES.password_grant`, no redirects, bounded response, only the machine error code is used). A wrong/unknown/unconfirmed answer is one verdict.
2. The grant creates one **additional Auth session**. It is never written to a cookie, never returned to the browser, never used as the redemption identity.
3. The grant's user id must equal the current web user's immutable id (not the e-mail text); `GET /user` with the temporary token must confirm that same id, a confirmed address and a non-anonymous user.
4. The temporary session is ended with `POST /auth/v1/logout?scope=local` (pinned in the allowlist: this session only, never the user's other sessions), retried once; an already-gone session counts as ended. If revocation cannot be confirmed the result says `reauthCleanup: "unconfirmed"` (logged by name, shown to the user, never claimed as revoked); the tokens are dropped and nobody holds them. A mismatch or failed validation also revokes the temporary session.
5. Only then is the original web session re-checked and used for the redemption.

Because the password is the proof, the victim who never knew it cannot link: the link page says so and points at password reset. **Resolved in PR E (owner decision):** a password reset now revokes every session of the account ([security.md §6.1](security.md)), so a pre-registering attacker's earlier session cannot outlive the victim's reset. The former residual read:  a pre-registering attacker who signed in between the victim's confirmation and the victim's password reset keeps that already-issued session (Auth does not revoke other sessions on a password change, finding I-1); after the victim links an installation that lingering session could **read** its Guildbook. It cannot redeem (fresh password) and it cannot be re-created. Closing it needs a global/other-sessions sign-out on password reset, which would also sign the Companion out and changes the pinned Auth model: not done here; see [security.md §6](security.md).

## 4. Unknown outcomes

The redemption is one-time and state-changing. A timeout, a connection failure after the request was sent, a 5xx, an oversized or malformed reply are an **unknown outcome** (`502 outcome_unknown`, `reconcile: /account/installations`): not "failed", never retried automatically (the integration suite counts exactly one forwarded request through a fault-injecting proxy that drops the reply **after** the database committed). The UI says so and offers the installation list; a human retry of the same code gets the ordinary one-time answer. A lost reply of a read is simply unavailable.

## 5. The closed PostgREST client (`lib/account/rpc-client.ts`)

The only module that builds `/rest/v1/...` URLs (static test; the browser bundle scan also forbids `/rest/v1` and the RPC names). Exactly four functions of `ACCOUNT_RPCS` are reachable (`fdb_account_claim_redeem`, `fdb_account_installations`, `fdb_account_guildbook_guilds`, `fdb_account_guildbook_members`): `fdb_account_claim_start` (the Companion's anonymous owner) and `fdb_installation_link_status` are not. Fixed `POST /rest/v1/rpc/<name>` on the validated Auth origin; exactly four request headers (`apikey` = publishable key, `Authorization` = the user's own verified token, `Content-Type`, `Accept`), so no `Prefer`, profile or transaction header can be supplied; strict Zod input and output (an extra column fails closed); `redirect: "manual"`, `cache: "no-store"`, 8 s timeout, 512 KiB body cap; no service credential, no database driver, never the public loot adapter; nothing logged.

## 6. Installation list and private Guildbook

The list is whatever `fdb_account_installations` says the caller's verified session owns (max 50). The Guildbook uses only `fdb_account_guildbook_guilds` / `fdb_account_guildbook_members`; **installation ids and guild keys are filters, never authorization** (the database re-derives the caller from the session and returns an empty set for anything not owned, indistinguishable from "does not exist"). The page size is fixed at 50 by the server (the strict body has no `limit`/`offset`; `page` is bounded), the contract has no member GUID or internal column, and everything is rendered as text. Browser state is in memory only; any 401 and any back/forward-cache restore drops it and sends the person to sign in (revocation or sign-out invalidates the private UI at once). The installation id travels in the URL **fragment** when navigating from the list (never sent to the server).

## 7. Tests

| Layer | File | What |
| --- | --- | --- |
| Unit | `web/tests/unit/account-link-lib.test.ts` | closed client (registry subset, headers, every HTTP outcome, unknown outcomes, bounds), temporary-session lifecycle (same UID, mismatch, failed revocation, re-check), budgets |
| Static | `web/tests/unit/account-web-static.test.ts` | client closure, link-route check order, no code in URLs/storage/logs, every private handler authenticates through the approved resolver |
| Integrated | `web/tests/account-e2e/*.spec.ts` (34 tests) | real GoTrue + real PostgREST + PostgreSQL: see the scenario map in [integration-and-acceptance-report.md](integration-and-acceptance-report.md) |
