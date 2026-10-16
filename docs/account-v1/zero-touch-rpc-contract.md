# Zero-touch enrollment — RPC and file contract (migration 0014)

Normative companion of [ADR-017](adr-017-zero-touch-enrollment.md). All functions are `POST /rest/v1/rpc/<name>` with the caller's Supabase
access token (`Authorization: Bearer`) and the publishable key (`apikey`). Business failures are **HTTP 200 results** (`{ok:false,error}`);
HTTP 401 = no live session (PT401), 403 = wrong identity kind (PT403: a registered caller on a device function, an anonymous caller on an
account function), 429 = budget exhausted (PT429), 400 = bad snapshot identity (PT400), 413 = payload bounds (PT413).

## Account functions (caller: registered, email-confirmed, live web session; website BFF only)

| Function | Input | Output |
| --- | --- | --- |
| `fdb_account_enrollment_ticket_issue` | `{p_label?: string≤60}` | `{ok:true, ticket_id:uuid, ticket:"fdba1_<43 base64url>", expires_at:timestamptz}` or `{ok:false, error:"ticket_limit"}` |
| `fdb_account_enrollment_tickets` | `{}` | array (≤20, newest first) of `{ticket_id, label|null, status:"pending"\|"consumed"\|"revoked"\|"expired", created_at, expires_at, consumed_at|null, device_id|null}` |
| `fdb_account_enrollment_ticket_revoke` | `{p_ticket_id:uuid}` | `{ok:true}` or `{ok:false, error:"not_available"}` |
| `fdb_account_devices` | `{}` | array (≤50) of `{device_id, installation_id, label|null, status:"active"\|"revoked"\|"pending_approval", created_at, last_seen_at|null, revoked_at|null, revoked_reason|null}` |
| `fdb_account_device_revoke` | `{p_device_id:uuid}` | `{ok:true}` (idempotent) or `{ok:false, error:"not_available"}` |

The raw `ticket` is returned **once**, only by `..._issue`. It must never be logged, put in a URL, cached or kept in the page.

## Device functions (caller: the installation's own ANONYMOUS Auth identity with a live session)

| Function | Input | Output |
| --- | --- | --- |
| `fdb_device_enroll` | `{p_ticket, p_installation_id (16–128, [A-Za-z0-9][A-Za-z0-9._:-]*), p_label?}` | `{ok:true, device_id, device_secret:"fdbd1_<32hex>_<43 base64url>", installation_id}` or `{ok:false, error}` with `error` ∈ `invalid_ticket`, `ticket_expired`, `ticket_consumed`, `ticket_revoked`, `invalid_installation`, `installation_conflict`, `installation_bound`, `identity_in_use`, `device_limit`, `account_limit`, `account_unavailable` |
| `fdb_device_status` | `{p_device_secret}` | `{state:"active"\|"revoked"\|"ownership_conflict"\|"account_unavailable"\|"unknown", installation_id\|null, needs_rotation:boolean, reason\|null}` |
| `fdb_device_ingest` | `{p_device_secret, p_snapshot}` (the same snapshot object `ingest_foreverdb_snapshot_auth` takes) | `{ok:true, status?:..., ...}` (the ingest implementation's own fields are merged) or `{ok:false, error}` with `error` ∈ `device_unauthorized`, `wrong_installation`, `device_credential_stale`, `device_revoked`, `account_unavailable`, `ownership_conflict` |
| `fdb_device_rotate_credential` | `{p_device_secret}` | `{ok:true, device_secret}` or `{ok:false, error}` (same error set as ingest, minus `wrong_installation`) |

Rotation: the new secret is valid **alongside** the current one until its first successful use; persist it before using it.
`needs_rotation` becomes true 30 days after the current credential was issued.

## Activation file (`foreverdb-activation.fdbact`)

UTF-8 JSON, ≤ 1 KiB, produced by the website's authenticated `POST` download, `Content-Disposition: attachment`, `Cache-Control: private, no-store`:

```json
{ "format": "foreverdb-activation", "v": 1, "ticket": "fdba1_…", "expiresAt": "2026-10-20T12:00:00.000Z", "createdAt": "2026-10-13T12:00:00.000Z" }
```

It contains no e-mail, no account id, no token. `expiresAt` is a hint for the UI; the server decides. The Companion deletes the file after a
terminal answer (success, consumed, revoked, expired); it keeps it on network failure.

## Companion states

`Anonymous` (no activation, legacy path unchanged) · `PendingActivation` (file found, not redeemed yet, e.g. offline) · `Registered` (active
device) · `ActivationExpired` · `ActivationRejected` (invalid, consumed or revoked ticket) · `DeviceRevoked` · `OwnershipConflict`
(installation conflict/bound/stale ownership) · `AccountUnavailable` · `CredentialDamaged` (local device credential unreadable).
