# ForeverDB Browser Pairing V1 — design specification

**Status:** Stage A approved architecture; specification for a Draft PR. No implementation in this document is deployed or enabled.
**Target release:** 2026-10-30, subject to every security and acceptance gate.
**Branch:** `feature/browser-pairing-v1`
**Migration reservation:** `0016`; PR #58 already owns `0015_azerdex_welcome_outbox.sql`.
**Decision:** [ADR-019](../../account-v1/adr-019-browser-pairing.md).

## 1. Outcome

ForeverDB will add an RFC 8628-inspired, one-click browser approval flow for connecting the Windows Companion to a registered web
account. A user starts in the Companion, the Companion opens the system browser, the user signs in if needed and explicitly approves
the named computer, and the Companion observes the approval and completes device registration. No activation-file download, copied
code, API key, per-user installer or Companion account password is part of the normal flow.

The flow extends the Account V1 ownership model. It preserves the installation ID and all historical rows, uses the existing anonymous
installation identity as the initiating principal, registers the resulting device in `private.devices`, and continues to authorize
ingest through `fdb_device_ingest`. The `.fdbact` path remains available as a fallback until Browser Pairing V1 is accepted. Automatic
sync remains off.

## 2. Scope and exclusions

Stage B–E will implement:

- five-minute pairing sessions with explicit browser approval or denial;
- exact initiating Companion session binding, rate-limited polling and cancellation;
- atomic, single-use ownership transfer and device registration;
- the Account website approval screen and account-login continuation;
- Companion waiting, approved, connected, expired, denied, revoked and retry states;
- compatibility with anonymous installations, existing registered installations and `.fdbact` enrollment;
- disposable-environment SQL, web and Companion tests, release documentation and a universal-installer acceptance checklist.

This work will not deploy a migration, change live Supabase data, enable a production flag, enable AutoSync, alter DNS, publish an
installer, merge a PR or activate a public route. It introduces no service-role credential in the web application or Companion.

## 3. Reuse from Account V1

| Existing component | Reuse |
| --- | --- |
| Anonymous Supabase identity and DPAPI session vault | Authenticates the initiating Companion. No registered-user token is shared with it. |
| `public.installations.owner_user_id` | Remains the sole ownership authority. No second ownership mapping is introduced. |
| Migration 0012 live-session guards and installation advisory lock | Protect every ownership-sensitive state transition. |
| `private.account_installations` and account audit | Records an anonymous-to-registered transfer, extended to identify a pairing instead of a claim code. |
| Migration 0014 `private.devices` and device credential checks | Stores the connected device and continues to authorize status, rotation and ingest. |
| `DeviceCredentialStore` and Windows DPAPI | Stores the active device credential; a new pending record is promoted after connection. |
| Next.js Account BFF, signed session cookie, CSRF and Origin checks | Authenticates browser users and protects approve/deny. |
| Existing rate-budget helper and Account API rate limiting | Adds budgets for start, preview, approve, deny, poll and cancel. |
| Account feature gates and release scripts | Gains separate Browser Pairing gates which ship OFF. |

## 4. Architecture

### 4.1 Trust boundaries

There are two independent authenticated actors:

1. **Companion installation:** an anonymous Supabase Auth user with an exact live GoTrue session. It starts, polls and cancels. Its
   bearer token is accepted only by three fixed device-pair API handlers and fixed PostgREST RPCs.
2. **Browser user:** a confirmed registered Supabase Auth user represented by the existing server-side Account session cookie. The user
   previews, approves or denies. The browser never receives the Companion's access token, polling secret or device credential.

The web BFF holds only the Supabase publishable key and the caller's own token. It is not a privileged proxy. Each route maps to one
allow-listed RPC with strict request and response schemas.

### 4.2 Locally generated proofs and idempotent start

Before calling start, the Companion uses `RandomNumberGenerator` to create and DPAPI-protect one pending record containing:

- a random UUIDv4 pairing locator (122 unpredictable bits);
- a 256-bit polling secret;
- a random UUID device ID and 256-bit device credential in the established `fdbd1_<device-id>_<secret>` format;
- the installation ID, creation time and expiry bound.

Start sends the locator, SHA-256 polling-secret verifier, device ID and SHA-256 device-credential verifier. It never sends the raw
device credential. Repeating start with the same locator and identical verifier/binding is idempotent; a changed value is rejected.
This makes a lost start response recoverable without creating another live request or requiring the server to retain a raw secret.

### 4.3 Browser handoff

The Companion opens:

`GET /account/device-pair?request=<pairing-uuid>`

The UUID is a public, short-lived selector, not an authenticator for polling or redemption. The GET validates it, writes it into a
short-lived HMAC-signed HttpOnly cookie with a fresh browser nonce, and immediately redirects to the clean
`/account/device-pair` URL. Pairing intake responses use `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, no analytics
payload and no application logging of the query. The locator can appear in infrastructure access logs, so it carries no reusable
credential and expires after at most five minutes.

If no web session exists, the page sends the user through the existing login flow with the fixed allow-listed return path
`/account/device-pair`. The signed pairing cookie, rather than a free-form `next` query, preserves the request.

### 4.4 Approval and redemption

The browser page retrieves a sanitized preview: computer label, abbreviated installation ID, request time, expiry and state. It shows
the current account address and requires a distinct **Approve** click. Approve stores the current registered UID from the verified
server session; an account identifier is never accepted from the browser.

Approval changes only `PENDING -> APPROVED`. It does not move ownership and does not create a device. The next valid Companion poll
performs the redemption transaction. Under the shared installation advisory lock it revalidates the initiating anonymous principal,
pairing secret, expiry, selected account, installation owner, device constraints and account standing; then it changes ownership when
needed, records the Account V1 link, inserts the device using the precommitted credential hash, and changes
`APPROVED -> CONNECTED` in one transaction.

Because the credential already exists in the DPAPI pending record, a lost successful poll response is harmless: a later poll returns
`CONNECTED`, and device status with that same credential independently confirms the registration. The Companion then atomically
promotes the pending record into the existing active device-credential format.

## 5. Anonymous session binding and refresh

At start, the database records both `initiator_uid = auth.uid()` and the JWT's UUID `session_id`. The user must be anonymous, active and
not banned or deleted; the exact `auth.sessions` row must be unexpired and have an unrevoked refresh token.

Every start retry, poll and cancel requires both values to match and repeats the live-session check under a row lock. A different
session belonging to the same anonymous UID is rejected. A registered token is rejected. Possessing only the polling secret is
insufficient.

Normal Supabase access-token refresh is supported because GoTrue refresh rotation preserves the logical `session_id`. When a poll gets
an expired-token 401, the Companion uses the existing `AccountSessionManager` refresh path and retries no earlier than the server's
poll schedule. It does not start a new pairing. If refresh fails, the refresh token is revoked, or GoTrue returns a different session
ID, the request cannot be rebound; the UI reports that the pairing session is no longer valid and requires a new explicit Connect
Account action. Sign-out, user deletion, banning or conversion of the anonymous identity also invalidates the pairing.

## 6. Browser authorization and replay rules

- A locator replay can select only the same five-minute row. It cannot poll or redeem because those operations also require the raw
  polling secret and exact anonymous session.
- Approve and deny require a currently live, confirmed registered Account session, same-origin JSON, session-bound CSRF token, matching
  signed pairing cookie and body locator, and a database row lock.
- The pairing cookie is freshly HMAC-signed and contains locator, browser nonce and expiry. A sibling domain or client-supplied cookie
  cannot fix a valid value. Following a link may select a request but never mutates it.
- If another tab replaces the pairing cookie, the body/cookie mismatch rejects the stale page. If the browser account changes, the old
  session-bound CSRF token fails. The page must reload, show the new account address and obtain a new CSRF token before approval.
- The approving account comes only from the verified server session. Concurrent approvals by two accounts have one winner. The loser
  receives a generic terminal-state response which does not reveal the winning account.
- An already registered installation can be paired only to its current account and only through the controlled re-enrollment rules.
  Another account receives a generic ownership-conflict response.
- For an anonymously owned installation there is no pre-existing registered account to compare. The account visibly named on the
  confirmation screen becomes the owner only after the user explicitly approves and the initiating Companion redeems.
- Terminal locators display only terminal status and cannot approve again. Cookies are cleared after approve/deny and on expiry.

## 7. State model and atomic invariants

`UNPAIRED` is a Companion-derived state. Database rows use `PENDING`, `APPROVED`, `CONNECTED`, `EXPIRED`, `DENIED` and `REVOKED`.
The normative state machine and lock order are in [browser-pairing-state-machine.md](../../account-v1/browser-pairing-state-machine.md).

The transaction invariants are:

1. At most one non-terminal pairing exists for an installation and initiating Auth UID.
2. Exactly one registered account can change a pending pairing to approved.
3. Ownership transfer, Account V1 link insertion, device insertion and `CONNECTED` transition commit together or not at all.
4. Exactly one device is associated with a pairing, and existing unique live-device constraints remain enforced.
5. A successful repeated poll is read-only and returns the same connected device ID; it never creates another device or audit event.
6. Denied, expired, canceled or revoked requests cannot transfer ownership or create a device.
7. An installation owned by another registered account never changes owner.
8. Historical installation data and installation ID never change.

## 8. Feature gates and compatibility

The migration creates a private singleton config row with `enabled = false`; every pairing RPC fails closed while it is false. The web
and Companion add separately reviewed source constants, both false on the branch's release configuration. Local/disposable test stacks
may enable the database gate explicitly; staging/pilot/production requires a separate owner-approved operation and reviewed source
change. Environment variables alone cannot activate production pairing.

Migration 0014 tickets and `.fdbact` enrollment remain functional. Existing device rows keep their ticket provenance. Migration 0016
adds pairing provenance without rewriting them. Existing registered device credentials, revocation and manual ingest remain compatible.
AutoSync stays off independently of every pairing flag.

## 9. Delivery documents

- [ADR-019](../../account-v1/adr-019-browser-pairing.md)
- [API contract](../../account-v1/browser-pairing-api-contract.md)
- [Database state machine](../../account-v1/browser-pairing-state-machine.md)
- [Threat model](../../account-v1/browser-pairing-threat-model.md)
- [Migration and rollback plan](../../account-v1/browser-pairing-migration-and-rollback.md)
- [Test matrix and acceptance criteria](../../account-v1/browser-pairing-test-and-acceptance.md)

## 10. Release decision

The feature is production-ready only after migration review, disposable full-stack tests, exact-head Windows CI, independent security
and architecture approval, owner Windows 10/11 acceptance with two computers, non-empty manual ingest verification, universal-installer
verification and an explicit production go/no-go. Missing the 2026-10-30 target does not waive a gate. The release-safe fallback is the
existing universal Companion plus anonymous operation and owner-accepted `.fdbact` enrollment.
