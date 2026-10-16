# Zero-touch enrollment owner pilot — closure record (2026-10-16)

Status vocabulary: **PASS** = executed, evidence named. **NOT TESTED** = never executed. **BLOCKED** = cannot proceed until a named condition holds.
Owner-reported results are labelled as such; this record adds no PASS that the owner did not report or CI did not produce.

## 1. Owner acceptance (reported 2026-10-16)

| # | Item | Status | Evidence / limit |
| --- | --- | --- | --- |
| P1 | Protected Vercel Preview of PR #59: account HTML `Referrer-Policy: strict-origin` | **PASS** (owner-reported) | no screenshot/log attached to the repo |
| P2 | Activation download `POST` returns 200 with the `.fdbact` attachment (the former 403) | **PASS** (owner-reported) | confirms the origin-`null` root cause is fixed on the fix Preview |
| P3 | One `.fdbact` ticket consumed on the #57 pilot Companion (0.9.0-alpha) | **PASS** (owner-reported) | exactly one ticket; **no further ticket may be consumed** |
| P4 | One registered device visible on the web `/account/devices` | **PASS** (owner-reported) | |
| P5 | Companion account sign-in | **PASS** (owner-reported) | |
| P6 | Registered-device manual **Sync Now** completes, AutoSync OFF, Last Error None | **PASS** (owner-reported), **empty payload only** | the sync reported **0 sources and 0 Guildbook members** |
| P7 | Non-empty data ingest through `fdb_device_ingest` (source stats, Guildbook members) | **NOT TESTED** | do not claim; needs a fixture/profile with data and explicit owner go-ahead |
| P8 | Private Guildbook view of device-uploaded data (`/account/guildbook`) | **NOT TESTED** | nothing was uploaded to show |
| P9 | Post-sync preservation check: six anonymous installations, 140 source-stat rows, 46 Guildbook members | **NOT VERIFIED here** | no production access was used for this closure; owner-run read-only check in §4 |
| P10 | Installation panel shows `Not checked yet` after the successful device upload | **DEFECT (UI/state), fixed in code; fix NOT TESTED on Windows** | §2 |
| P11 | Z4–Z10 (second PC, restart/reboot, revoke, expiry, B1 claim→device, conflict, copied-file) | **NOT TESTED** | |
| P12 | Z13 one-download installer integration | **NOT IMPLEMENTED / BLOCKED** for public release | #57 pilot is exempt by decision |
| P13 | Public release: flags off, Production, signed installer | **BLOCKED** | pilot flags are still `true`; see §5 |

## 2. `Not checked yet` — root cause and fix

**Genuine UI/state defect, not an authorization result.** `Not checked yet` is the label for `InstallationOwnership.Unchecked`, the initial
state of every locally discovered installation (`InstallationSyncCoordinator.NoteLocalInstallation`). The Account tab draws its installation
rows exclusively from `InstallationSyncCoordinator` records. Anonymous/claimed uploads update the record on success (`Update(...)` in `SyncAsync`),
but `SyncService.SyncRegisteredDeviceAsync` — the registered-device path that deliberately bypasses the coordinator so the anonymous route can never
be used — only returned a `SyncAttempt` and raised events. The record therefore never left `Unchecked`, regardless of the successful upload. The
same row also offered the account-ownership **Check** button, which is meaningless for a device-owned installation.

Fix (Companion only; no server, no schema, no flag change):

* `InstallationSyncCoordinator.NoteDeviceUploadAccepted(id)` sets the record to `OwnedByRegisteredAccount` ("Owned by your account") with the sync time. It is
  called **only** after `fdb_device_ingest` accepted the snapshot. That RPC re-checks device, credential, account standing and *current* ownership
  under the installation lock, so acceptance is the server's verdict; the client decides nothing.
* `NoteDeviceUploadNotCompleted(id, reason)` is called when the device upload ran and was refused/failed: it returns the row to `Unchecked` with the
  reason, so a stale "owned" display never survives a revoke/ownership change. Automatic triggers (AutoSync OFF) upload nothing and change nothing.
* No authorization path changed: no credential selection, no ownership routing, no RPC, no gate. Display state only.

Tests added (`tests/companion-account/DeviceIntegrationTests.cs`): row is `Unchecked` before any accepted upload and after Auto/Startup triggers; becomes
owned and fires `InstallationChanged` only after an accepted manual sync, with zero anonymous ingests; a revoked device's refused sync clears an earlier
owned state and never shows owned.

**Verification status of the fix: NOT TESTED.** This sandbox has no .NET SDK and no route to download one, so neither the new tests nor the WPF
build were run here. They run in the Windows CI job "Companion account auth (Windows)". The #57 pilot installer (`b3d8870`) predates the fix; seeing
the corrected row on Windows needs a fresh pilot build (no new ticket is needed: the device credential already exists on the test profile).

Known, accepted limitation: signing the *account* in or out resets all rows to `Unchecked` (identity-generation reset, existing behaviour); the next
manual Sync Now restores the owned display. It is conservative (never over-claims).

## 3. Server-side audit of the registered-device manual sync

What the owner-observed result establishes (reading `0014_zero_touch_enrollment.sql`, `fdb_device_ingest`, with an empty payload accepted):

* The device's own anonymous Auth session was accepted as the caller (`fdb_anonymous_caller`, live-session check).
* The device secret mapped to a registered device, its `installationId` equalled the registry entry, and `fdb_device_authorize` found the device
  not revoked, credential current, account available and ownership unchanged.
* The unchanged ingest implementation ran as the owning account with an empty `sources`/`guilds` payload and returned ok; `last_seen_at` was updated.

What it does **not** establish (server-side validation still outstanding, all **NOT TESTED** on the live project):

1. Non-empty ingest: row writes for sources/stat rows and Guildbook members attributed to the account-owned installation, size/row bounds
   (8 MiB / 2500 sources / 100 guilds) under a real payload.
2. The 140 / 46 / six-anonymous preservation after the pilot (no evidence was supplied; the closure did not query production).
3. Credential rotation after 30 days, revoke-then-sync, expired-ticket and ownership-conflict behaviour against the live project.
4. That `/account/devices` shows the `last_seen_at` bump (not reported).

All of these are covered by the 98/98 local SQL enrollment suite and the Windows Account tests, which are not live-project evidence.

## 4. Owner-run read-only checks (copy exactly; SELECT only, no writes)

```sql
select count(*) as installations_total from public.installations;
select id, owner_user_id from public.installations order by id;            -- the six anonymous owners must be unchanged
select count(*) from public.installation_source_stats where installation_id = '2f8df8ba69345d0a14c8d56ac86d4b2e';        -- expect 140
select count(*) from public.installation_guild_members where installation_id = '2f8df8ba69345d0a14c8d56ac86d4b2e';       -- expect 46
```

Table names are from `database/migrations`. The new device installation (not one of the original seven) must be owned by the owner's registered account. Record the
results (not the user ids) in this file when run.