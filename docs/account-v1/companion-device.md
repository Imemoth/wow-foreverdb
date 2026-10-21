# Companion — zero-touch device enrollment and registered sync (as built)

Windows-Companion half of [ADR-017](adr-017-zero-touch-enrollment.md) against the RPC contract in
[zero-touch-rpc-contract.md](zero-touch-rpc-contract.md). Direct account linking and registered-device sync are part of the normal Companion package; activation-file discovery remains gated off.

## Gating

| Constant (`AccountFeatureGate`) | Value | Meaning |
| --- | --- | --- |
| `ZeroTouchEnrollmentApproved` | `false` (const) | Lets the private pilot gates (`PrivatePilot`, `PrivateClaimPilot`) use the feature. Not flipped here. |
| `DeviceAutoSyncApproved` | `true` (const) | Allows the persisted user AutoSync setting to drive registered-device uploads. It does not change that setting. |

`AccountFeatureGate.ZeroTouchAvailable(gate)` = gate open AND (`Local`/`Staging` with the existing isolated-endpoint validation, OR a private
pilot AND `ZeroTouchEnrollmentApproved`). In the default production mode `AccountRuntime.Device` is `null`: no activation-file scan, no
network, no directory, no UI. `PrivateProjectPilotApproved` / `PrivateProjectClaimPilotApproved` are untouched and no other approval exists.

## Components (`companion/ForeverDB.Companion.Account/`)

| File | Role |
| --- | --- |
| `DeviceModels.cs` | `DeviceState` (the nine contract states), `DeviceDetail` (picks the wording), `DeviceStatus`, `DeviceContract` (ticket/secret/installation patterns, 1 KiB limit), `DeviceCredential`. |
| `ActivationFile.cs` | `ActivationFileParser` (strict), `FileActivationSource` (injectable `IActivationSource`; discovery, removal). |
| `DeviceCredentialStore.cs` | DPAPI-protected `{deviceId, deviceSecret, installationId, enrolledAt[, redeemedTicketHash]}`, atomic durable write, `.bak` recovery, quarantine. |
| `DeviceRpcClient.cs` | The four device RPCs, closed name set, strict reply validation, errors mapped to enums, no body/secret ever returned as text. |
| `DeviceContext.cs` | `DeviceSessionProvider` (the device's OWN anonymous Auth session), `DeviceContext` (directory, machine-wide gate, store, RPC client, observable `DeviceStatus`, status probe). |
| `DeviceEnrollmentService.cs` | `LoadLocalState()` (local only) and `InitializeAsync()` (discover, redeem, persist, delete file). |
| `DeviceSyncService.cs` | `CheckStatusAsync()`, `SyncNowAsync()`, `SyncAutomaticAsync()` and `Handles(installationId)`. Manual and automatic calls share the same credential, ownership and failure path. |
| `AccountMessages.cs`, `Redaction.cs` | Wording for every state/outcome; `fdba1_` / `fdbd1_` patterns added to the scrubber. |

UI: `MainWindow.Account.cs` / `MainWindow.xaml` add a "Registered device" panel (state + message, a Retry button while pending);
`SyncService` routes an installation the device owns to `DeviceSyncService`, serializes automatic events and skips an already accepted snapshot. `installer/ForeverDB.iss` copies
`{src}\foreverdb-activation*.fdbact` into `{localappdata}\ForeverDB\activation` (`external skipifsourcedoesntexist uninsneveruninstall`).

## Storage layout (per gate directory; the production directory is never used with the gate closed)

```
<account dir>/               legacy slots: session.dat(.bak/.kind), legacy-owner.dat, pending-revoke.dat   (never touched by this code)
<account dir>/device/
    session.dat, session.kind        the device's own anonymous Auth session (DPAPI, CredentialSlot)
    device-credential.dat(.bak)      DPAPI blob of the device credential
    device-credential.kind           non-secret marker {v, installationId}
%LOCALAPPDATA%\ForeverDB\activation\*.fdbact   activation files (deleted after a terminal answer)
```
Nothing here is written to `settings.json` or SavedVariables; no secret is logged (the library has no logging, enforced by tests and the repo check).

## Behaviour

* **Discovery** order: `%LOCALAPPDATA%\ForeverDB\activation\*.fdbact`, the install directory, the Downloads known folder
  (`foreverdb-activation*.fdbact` only). Top directory only, no links, files > 1 KiB ignored, newest first inside a location.
* **Parser decision:** extra top-level fields are tolerated (forward compatible inside v1); `format`, `v`, `ticket`, `expiresAt`, `createdAt`
  must have their documented types when present; a repeated known field is refused; `expiresAt` is only a hint (the server decides).
* **Enrollment** (under the device gate, once per call): an activation-file enrollment discovers the installation id from SavedVariables
  (exactly one required); the signed-in account-linking MVP supplies the already selected installation id and an in-memory one-time ticket.
  The device's anonymous session is created lazily and only here. `fdb_device_enroll`; the credential is written durably
  **before** the file is deleted. Terminal answers (success, `ticket_expired`, `ticket_consumed`, `ticket_revoked`, `invalid_ticket`) delete the
  file; network/429/5xx/404, `installation_conflict|bound`, `identity_in_use`, limits and `account_unavailable` keep it (refused tickets are not
  retried in the same process).
* **Lost reply:** the retry gets `ticket_consumed` -> `ActivationRejected` with "download a NEW activation file"; with a local credential it is
  treated as registered. A new file re-binds the same device identity (server rule, ADR section 5).
* **Never silently replaced:** an unreadable credential, a lost/rejected device session or a stale credential give `CredentialDamaged`, no new
  identity, no network. A fresh activation file is the explicit recovery (the damaged blob stays as `.bak`).
* **Sync:** device token + stored secret -> `fdb_device_ingest`. `device_revoked` stops (no further calls); `ownership_conflict`,
  `account_unavailable`, `device_credential_stale` (retry once later, then damaged), `device_unauthorized` (classified with `fdb_device_status`),
  HTTP 401 (refresh once, retry once), 429/5xx/network (retry later, state unchanged). Never another identity, never the anonymous ingest.
* **AutoSync:** the existing user setting controls watcher/startup sync. The watcher waits for a stable readable SavedVariables file; successful snapshots are deduplicated per installation and simultaneous automatic/manual attempts cannot overlap. A failed attempt is not cached, so the next event can retry.
* **Rotation:** when status says `needs_rotation` the new secret is stored durably before its first use; if it cannot be stored the old (still
  valid) secret is used and rotation is retried later.
* **Anonymous path stays closed** for an installation the device owns (any state) and, while an activation is pending, for every installation.

## Tests (`tests/companion-account/`)

| File | Covers |
| --- | --- |
| `DeviceActivationFileTests` | parser strictness, limits, extra fields, discovery order/patterns/links/removal |
| `DeviceCredentialStoreTests` | durability, `.bak`/temp recovery, damage, quarantine, `Real_DPAPI_device_credential_...` (Windows only) |
| `DeviceEnrollmentTests` | A1/A2/A3, every ticket answer and file rule, interruption, lost reply, concurrency, conflicts, identity safety, legacy bytes untouched |
| `DeviceSyncTests` | every ingest answer, revocation, rotation (persisted-before-use, crash points), stale, 401, automatic device upload |
| `DeviceIntegrationTests` | real `SyncService` + non-empty parser fixture: manual/Auto/Startup, serialization, deduplication, no anonymous fallback |
| `WowSavedVariablesWatcherTests` | in-progress locked SavedVariables writes are not dispatched until complete and readable |
| `DeviceGateTests` | flags, gate matrix, default mode does nothing (no HTTP, no files) |
| `DeviceMessagesTests` | wording for every state/detail, redaction, no logging in the new files |
| `DeviceCrossProcessTests` | three real processes enroll once |
| `Support/FakeDeviceBackend.cs`, `Support/DeviceRig.cs` | in-process model of migration 0014's device RPCs, test rig |

## Known limits

Several installations on one computer cannot be activated (one device identity = one installation). A re-activation ignores a file while the
server reports the device active. The device secret recovered from `.bak` after main-file damage may be a superseded one (server reuse
detection could then revoke the device after 120 s); the recovery is a new activation file.
