# Companion account linking MVP

Status: implemented for local/staging and acceptance builds. Production account approval, AutoSync and every public activation flag remain off. No new migration or hosted infrastructure is required.

## Chosen flow

1. The Companion continues anonymously with its existing installation ID and DPAPI-protected anonymous Supabase session.
2. The user signs in with an existing confirmed ForeverDB account. The existing `AccountSessionManager` sends the password only to Supabase Auth over TLS, verifies the returned user with `GET /auth/v1/user`, stores the registered session with DPAPI, and preserves the anonymous owner session in the legacy-owner slot.
3. On **Connect this installation**, `AccountLinkService` checks the registered session and asks the existing anonymous owner to start a one-time 0012 claim. The database verifies the live anonymous session and current installation owner; knowing an installation ID is insufficient.
4. The signed-in account redeems the server-generated claim through `fdb_account_claim_redeem`. Migration 0012 performs the single-use ownership transfer under the installation lock and preserves all installation, observation and Guildbook rows.
5. The same registered session issues a 0014 enrollment ticket. A separate anonymous device session redeems it for the same installation. The resulting device secret is stored by the existing `DeviceCredentialStore` under Windows DPAPI.
6. Manual sync uses `fdb_device_ingest` and the revocable device credential. `DeviceAutoSyncApproved` remains `false`.

The claim code and enrollment ticket live only in process memory during the exchange. Access tokens, refresh tokens, claim codes, enrollment tickets and device secrets are never put in a browser URL or application log. The existing website claim-code route and `.fdbact` activation-file route remain recovery fallbacks.

## Why this route

| Option | Decision | Reason |
| --- | --- | --- |
| Direct Companion password login | chosen for the MVP | Already implemented, verified against GoTrue, uses the existing DPAPI session manager, and needs no callback listener, URI handler or new server. The user enters credentials directly into the native Companion and they go only to Supabase Auth. |
| System-browser OAuth/OIDC with PKCE | later, when a browser or social provider is required | A sound option, but it needs an OAuth provider configuration plus a loopback/custom-URI callback lifecycle and Windows registration. It does not simplify the password-account release path. No token may be returned in a URL; an authorization code with PKCE would be required. |
| Existing website claim code and `.fdbact` | retained as fallback | Secure and already deployed, but requires manual browser/file steps. It remains useful for recovery and does not compete with the direct path. |
| PR #62 browser pairing / trusted ingress / HMAC attestation | abandoned for this MVP | It adds a new public ingress, attestation keys and another protocol although migrations 0012 and 0014 already prove both the human account and the installation owner. PR #62 stays Draft and unmerged. |

## Authorization and failure rules

- `fdb_account_claim_start` receives only the anonymous owner JWT; `fdb_account_claim_redeem` and ticket issue receive only the registered account JWT; device enrollment receives only the separate anonymous device JWT.
- Every RPC keeps the existing database live-session guard, identity-kind check, ownership predicate and database rate limits. The Companion exposes a closed method set and fixed PostgREST request shape; it has no generic RPC proxy and no service-role credential.
- A revoked registered session fails before claim creation. A missing or wrong anonymous owner credential cannot start a claim. A different account cannot take an installation by ID.
- A lost ownership-transfer reply is reconciled once through link status and is never redeemed automatically again. If ownership transfers but device enrollment cannot finish, the UI reports that split state; retrying Connect issues a new one-time ticket without moving ownership again.
- A damaged existing device credential is preserved and never silently replaced. The user can recover through the existing activation-file flow.
- Sign-out continues to revoke only the human Companion session. Registered device revocation remains independent and effective on the next device call.

## Reused implementation

- `AccountSessionManager`, `GoTrueClient`, `SessionVault`, cross-process session gate and Windows DPAPI storage.
- Migration 0012 claim state machine, link status, ownership lock, audit and rate limits.
- Migration 0014 ticket issue, device enrollment, device registry, rotation, revocation and device ingest.
- `ClaimService`, `OwnershipRpcClient`, `DeviceEnrollmentService`, `DeviceSyncService` and ownership-aware `SyncService` routing.
- Existing web account, claim-code redemption, Devices page and `.fdbact` recovery.

No PR #62 migration, pairing endpoint, raw-header ingress, HMAC attestation, browser polling state or second ownership model is used.

## Acceptance evidence required before activation

- Companion suite on Windows with real DPAPI and multi-process tests, including `AccountLinkingMvpTests`.
- Disposable PostgreSQL + real GoTrue enrollment suite, including the claim-to-device vertical slice in `database/tests/enrollment/09_gotrue.test.mjs`.
- Existing 0012/0014 SQL concurrency, replay, ownership-preservation, logout and revocation suites.
- Release WPF build and unpublished Windows test artifact.
- One scoped security review of the final diff and exact-head CI.

Production activation, hosted Supabase migration, deployment, installer publication and AutoSync require separate owner approval.
