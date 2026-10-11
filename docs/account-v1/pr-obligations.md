# Account System V1 — obligations for PR B and PR C (binding)

These are acceptance conditions, not suggestions. A PR that does not meet them is not review-ready. They consolidate the specification, the independent reviews of PR A, and the owner's remediation request.

## PR C — ownership and Guildbook backend (migration `0012`)

### C1. Identity guards (finding: revoked anonymous bearer)

1. Implement `private.fdb_caller()`, `private.fdb_anonymous_caller()` and `private.fdb_registered_caller()` exactly as specified in [ownership-claim-protocol.md §4.1](ownership-claim-protocol.md): live `auth.sessions` row for the JWT's `session_id` and the same user, `not_after`, not deleted, not banned. Claim initiation using only `auth.uid()` and `is_anonymous` is **forbidden**.
2. Every public account function (`ACCOUNT_RPC_GUARDS` in `contracts.ts`) calls its guard as its **first statement** and takes the UID only from the guard's return value.
3. `lintAccountMigration()` must pass on **every** migration that mentions an account function (it runs inside `npm test`, the test already exists and becomes live when the file appears; it lints the concatenation of all such files, so the file name does not matter). It is a **tripwire, not proof**: LS-1..LS-9 against real sessions are the proof.
4. `claim_start` stores `initiator_session_id`; `claim_redeem` requires **that exact session** to still exist unexpired for `initiator_uid` (not merely any session of that user) and the initiator to be neither deleted nor banned.
6. Guards are `VOLATILE`; after the advisory lock `claim_start`/`claim_redeem` re-verify liveness with `FOR SHARE` on the session row(s) (pre-flight proves the migration role can; otherwise the documented fallback).
5. Preserve existing budgets, the advisory lock shared with ingest, and the single failure shape.

### C2. Mandatory negative integration tests (SQL, ephemeral PostgreSQL with real `auth`-schema emulation of `users` and `sessions`, plus real GoTrue in CI for LS-9)

| ID | Scenario | Setup | Required result |
| --- | --- | --- | --- |
| **LS-1** | **Revoked-but-unexpired anonymous JWT cannot start a claim, even though its UID still equals `installations.owner_user_id`** | anonymous user and session; installation owned by that UID; delete the `auth.sessions` row (sign-out) while the JWT claims (`sub`, `role`, `session_id`, future `exp`) are unchanged; call `fdb_account_claim_start` | `PT401`; **no** `installation_claims` row, **no** audit row, no budget side effect that leaks existence; ownership unchanged |
| LS-2 | JWT without a `session_id` claim | valid user, claims omit `session_id` | `PT401` for every account function |
| LS-3 | `session_id` belonging to another user | user A's claims with user B's live session id | `PT401` |
| LS-4 | Expired session | `auth.sessions.not_after` in the past | `PT401` |
| LS-5 | Deleted or banned user with a still-present session row | `deleted_at` set, or `banned_until` in the future | `PT401` |
| LS-6 | Revoked registered token cannot redeem | registered user, valid pending claim, session row deleted | `PT401`; the claim stays `pending`; ownership unchanged |
| LS-7 | Issuing session revoked after issuing a claim | start succeeds; delete **only the issuing session** while a second, older session of the same user still exists (and separately delete/ban the user); registered user redeems | `{ok:false,error:'invalid_claim'}`; claim not consumed; ownership unchanged (an unrelated live session must not keep the claim alive) |
| LS-8 | The same session checks for **every** function in `ACCOUNT_RPC_GUARDS` | parameterised over the registry: LS-1..LS-5 for each function with an appropriate caller | `PT401` for each; the parameterisation must derive from the registry so a new function cannot be forgotten |
| **LS-9** | End to end against **real GoTrue** (CI Supabase local stack): an anonymous access token from `/auth/v1/signup` **contains `session_id`**; after `POST /auth/v1/logout` for that session the same unexpired token is refused by `fdb_account_claim_start` | real stack, not emulation | `session_id` present; refused with `PT401` after sign-out; proves the Supabase-version assumptions (`auth.sessions` row removal, claim presence) |
| LS-10 | Conformance tripwire | `lintAccountMigration` on every migration that mentions an account function | no violations (not proof; LS-1..LS-9 are) |
| LS-11 | Concurrent revocation | a sign-out transaction and `claim_start` race on the same session row | either the sign-out waits and the claim completes before it, or the claim fails; never a claim issued from a session that committed its revocation first |

Plus the existing mandatory checks 7–15 and 19 in [security.md §5](security.md), unchanged.

### C3. Other PR C conditions carried from the reviews

Claim and ownership rules in [ownership-claim-protocol.md](ownership-claim-protocol.md) (hashed per-installation budget key, per-installation budget charged only after the owner check, `account_limit` without consuming the code, `lock_timeout`, consumed claims never pruned, `transferred` derived from `previous_owner_uid`, ownership read from `installations.owner_user_id`, initiator-still-anonymous recheck, pgcrypto pre-flight, explicit revokes after each `create function`); rollback and incident-recovery runbook rehearsed; existing function bodies byte-identical (`prosrc` hash); the row-hash preservation test.

## PR B — Web Auth

1. All Auth traffic through one wrapper that enforces `isAllowedAuthRequest(method, pathAndQuery, {callbackUrl})` and the strict `AUTH_BODIES`; logout always `scope=local`; no email change; no body-less sign-up.
2. Server-confirmed user (`getUser()`) for every private page and API; `getClaims()` only for low-risk rendering; no `getSession()` data for authorization.
3. Cookie `__Secure-fdb_acct`, `Path=/account`, HttpOnly, SameSite=Lax; signed CSRF token (`ACCOUNT_CSRF_SECRET`); Origin and `Sec-Fetch-Site` checks; GET interstitial for confirmation and recovery; `Referrer-Policy: no-referrer` and `history.replaceState` on `/account`; no query strings in logs.
4. Routes only under `/account` and `/account/api/*` (static test forbids `src/app/api/account`); proxy edge rules for POST `/account/api/*`; `/account/**` excluded from anonymous-cookie issuance; `private, no-store` and noindex everywhere.
5. Website-side Turnstile is verified server-side before sign-up and recovery. **It is bot protection for website routes only** and is documented as such everywhere; it is not presented as protection for GoTrue (threat A24).
6. A CI job running the Supabase local stack (real GoTrue, PostgREST, Postgres, Mailpit): sign-up, confirmation through captured mail, login, logout (and that the **Companion-style session survives a web logout**), recovery, CSRF, redirect, enumeration, bundle scan, header checks. No installation or Guildbook access in this PR.
7. A browser-bundle test that imports `contracts.ts` into a client component and builds it with the production bundler.
8. No Auth setting that couples sessions or breaks the Companion (CAPTCHA project-wide, single session per user, time-box, short inactivity timeout) is assumed in tests; the CI stack runs with those settings **off** to match the product requirement.

## Both PRs

- The Auth-to-website IP attribution question (L-8 / AT-7: do server-side calls from the website share one Auth rate-limit bucket?) must be answered with evidence before PR B is called STAGING VERIFIED; PR B's own per-IP throttle must be stricter than the Auth per-IP limits so an attacker cannot exhaust a shared bucket through the website.
- The abuse-prevention acceptance criteria in [acceptance-and-owner-actions.md §5](acceptance-and-owner-actions.md) are **not** satisfied by either PR's code; they are owner-run staging and pre-production gates. Neither PR may describe the direct-Auth abuse risk (A24) as resolved.
- Node.js 24.x, lint, typecheck, full unit suite, canary build and bundle scan, Playwright, publisher/pipeline and the release gate all green on the final head; independent security review of the final diff; no merge without the owner's decision.
