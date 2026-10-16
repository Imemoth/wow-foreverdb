# Browser Pairing V1 — threat model

## Assets and trust assumptions

Protected assets are installation ownership, historical private data, registered-account identity, anonymous and registered Auth
sessions, device credentials, polling secrets, device-registry state and revocation decisions. Installation IDs, pairing locators and
computer labels are identifiers, not authenticators, but still receive minimization and no-store handling.

The Windows process and its user-scoped DPAPI vault are trusted for the local user's session. Browser content, query strings, all HTTP
input, labels, installation IDs, JWTs, cookies and database rows observed before locking are untrusted. The Next.js host has a
publishable key, not a service-role credential. PostgreSQL SECURITY DEFINER functions are privileged and must validate every caller.

## Threats and controls

| Threat | Control and verification |
| --- | --- |
| Guess a pending request | UUIDv4 locator, five-minute TTL, preview budgets and generic misses; locator alone cannot poll/redeem. |
| Locator copied from history/log/referrer | Immediate clean redirect, no-referrer, no-store, no app analytics/logging; replay selects only the same row and still needs registered login plus explicit approval. |
| Pairing locator replay after decision | Terminal state is immutable; approve uses `pending` row lock; no ownership/account data is disclosed. |
| Session fixation via planted cookie | HMAC-signed HttpOnly cookie with fresh nonce/expiry; unsigned or sibling-domain cookie fails. Link navigation can select a request but cannot mutate it. Body locator must match cookie. |
| Login CSRF / browser account switching | Existing login CSRF; approval CSRF bound to current web session; current verified account is shown; stale token fails after switch; account UID comes only from server session. |
| Stale page targets another tab's request | Pairing ID in body must match signed cookie; replacing cookie invalidates the stale page action. |
| Silent ownership transfer | Approval has no ownership side effect. Explicit account-named confirmation plus proof-bearing Companion poll is required for redemption. |
| Wrong account takes registered installation | Current registered owner must equal approving account for re-enrollment; otherwise generic conflict and no write. |
| User approves anonymous installation while signed into unintended account | UI prominently names the account and requires explicit confirmation. There is no prior registered account for the server to infer; this is a human decision, recorded as a residual UX risk. |
| Poll secret theft | 256 random bits, DPAPI at rest, sent only in no-store POST body, hash-only DB storage; exact initiating UID/session also required. |
| Anonymous access-token theft | Token alone lacks poll secret and pending device secret; exact session must stay live. Normal Auth revocation invalidates it. |
| Same anonymous UID, different session | Stored session ID equality and locked live-session check reject it. |
| Access-token refresh race | Same logical session ID is accepted; expired token is refreshed before a scheduled retry. A changed session ID cannot rebind the request. |
| Device credential leaks through pairing | Raw credential is generated and DPAPI-stored locally; start sends only SHA-256; browser, SQL response and polling never contain it. |
| Weak client-generated secret | Fixed format, length and CSPRNG implementation tests; deterministic/zero/random-source mutants must fail. Official Companion is the only supported starter. |
| Lost start response | Companion persists values first and retries the same locator/verifiers; database returns the same row only for an exact binding. |
| Lost redemption response | Credential already exists locally; repeated poll is read-only and device status confirms the same credential. |
| Concurrent approvals | Installation lock plus pairing `FOR UPDATE`; one account wins. Losing response does not reveal winner. |
| Concurrent redemption/replay | Atomic state predicate, unique pairing/device indexes and shared installation lock; exactly one device/link/audit success. |
| Approval after expiry | Every mutation compares database clock under lock and writes expired before returning. Client clocks are informational only. |
| Early polling / enumeration | `next_poll_at`, increasing interval, per-principal/per-pair/global budgets, generic not-available failures. |
| Cross-installation substitution | Installation, initiating UID/session, proposed device ID and both verifiers are immutable start bindings; poll accepts no installation/device override. |
| Existing anonymous owner hijack | Start requires the installation owner to be the initiating anonymous UID. Redemption rechecks under the same lock used by ingest and claim transfer. |
| Existing registered owner hijack | Pairing can only re-enroll for the same registered account and allowed predecessor device identity; another account cannot change ownership. |
| Revoked-device bypass | Existing device authorization checks revocation on every call. Re-enrollment is a new explicit pairing approved by the same owner, with one live-device uniqueness. |
| Service-role or RLS bypass | No service-role credential in web/Companion; private tables FORCE RLS/no policies/no grants; fixed SECURITY DEFINER RPCs with empty search path. |
| CSRF / cross-origin browser mutation | Exact Origin and `Sec-Fetch-Site`, JSON-only, signed double-submit token bound to web session, SameSite cookies, no CORS. |
| Native endpoint abused from browser | Device endpoints reject unexpected Origin, ignore Account cookies and require bearer token; database requires anonymous caller. |
| Secret leakage in telemetry/errors | Structured fixed-code logging only; redaction tests scan `ToString`, exceptions, bundle, routes and test artifacts. No body/header logging. |
| Feature accidentally exposed | DB singleton defaults false; Companion/web source approvals false; migration application and enable operation separate; release flag script checks all. |
| Rollback destroys ownership/history | Kill switch first; rollback removes callable surface but retains nonempty private tables and never rewrites ownership/data. |

## Residual risks

1. A person who receives a live locator and intentionally approves it can choose their account for an anonymously owned installation.
   The system cannot infer another intended registered account without reintroducing a code or pre-binding step. The short lifetime,
   account-named confirmation and Companion proof bound the risk.
2. Malware running as the same Windows user may be able to call DPAPI and act as the Companion. Browser pairing does not claim to
   provide hardware attestation or protection from a fully compromised user session.
3. A public locator can cause a denial-of-service if its holder denies the request. It cannot transfer ownership without the Companion's
   redemption proof. The user can start a fresh request.
4. Infrastructure may record the initial locator URL. It is deliberately nonsecret, single-purpose and short-lived; raw credentials
   never use that channel.

These risks require review but do not create a second ownership authority or reusable browser credential.
