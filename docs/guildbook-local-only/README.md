# Guildbook local-only: integration into the AzerDex release candidate

**Owner policy (final, not reopened):** Guildbook data stays exclusively on the user's computer. No Guildbook cloud upload, download, backup, remote synchronization or cloud RPC access.

Stack: `release` ← PR #141 (RC) ← PR #142 (GDPR) ← **this branch, `fix/guildbook-local-only-rc`**. Reference implementation: PR #112 (merged into `feature/account-independent-collector-credentials`, not into the RC).

| Document | What it is |
| --- | --- |
| this file | scope, reuse list, data-flow before/after, evidence, acceptance status, blockers |
| [db-changes.md](db-changes.md) | database changes: what from #112 was reused / adapted / excluded |
| [server-deployment-runbook.md](server-deployment-runbook.md) | separately reviewed, **not executed** production procedure for migration 0018 |
| [historical-guildbook-data.md](historical-guildbook-data.md) | where historical Guildbook rows can exist, read-only inventory, cleanup plan |
| `../0.9-guildbook-local-only.md` | storage design (DPAPI, namespaces, recovery) |
| `../gdpr/companion-data-flow-audit.md` | GDPR view of the same flows |

## The defect that was fixed
`companion/ForeverDB.Companion/Services/SyncService.cs` serialized the complete parsed snapshot (`p_snapshot = snapshot`). The snapshot carries `Guilds`, so guild names, rosters, member names/GUIDs, professions, ranks and activity entered `ingest_foreverdb_snapshot_auth` (anonymous / registered session) and `fdb_device_ingest` (registered device), and the server persisted them in `installation_guilds*`. Verified in code; every outgoing payload path was audited (below).

## Data flow

```
BEFORE (RC 4ad0f6f / GDPR branch)                         AFTER (this branch)

WoW addon  --SavedVariables-->  Companion                 WoW addon  --SavedVariables-->  Companion
 (observations + Guildbook)      parser                    (observations + Guildbook      parser
                                  |                          + capture provenance)         |
                                  | whole snapshot                                          +--> LocalGuildbookStore (DPAPI, this PC only)
                                  | (incl. guilds)                                          |      per account + per installation
                                  v                                                         |      shown only for a verified registered account
                  ingest_foreverdb_snapshot_auth /                                          |
                  fdb_device_ingest  -->  Supabase                                          +--> PublicObservationSnapshot (explicit DTO)
                                          installation_guilds*                                          |
                                          fdb_account_guildbook_*  <-- website (local only)             v
                                                                                       PublicSnapshotGuard (allowlist, fail-closed)
                                                                                                        |  refused => nothing is sent
                                                                                                        v
                                                                                       same two ingest RPCs, observations only
                                                                                       (server: 0018 projection + revoked guild RPCs,
                                                                                        prepared, NOT applied)
```

## Outgoing Companion payload audit
The Companion posts exactly these RPCs: `ingest_foreverdb_snapshot_auth`, `fdb_device_ingest`, `fdb_device_enroll`, `fdb_device_status`, `fdb_device_rotate_credential`, `fdb_installation_link_status`, `fdb_account_claim_start`, `fdb_account_claim_redeem`, `fdb_account_enrollment_ticket_issue`, plus GoTrue, search/stats/location reads, `map_asset_diagnostics`, and `wago.tools`. Only the two ingests carry a snapshot, both via one serialization point in `SyncService` (anonymous, registered-session, manual, automatic, startup and the post-sign-in resync all go through it; the registered-device path wraps the same JSON). No Companion source references a `fdb_account_guildbook_*` RPC or an `installation_guild*` table (a source-level test enforces it). Two independent layers protect the wire:
1. `PublicObservationSnapshot.From(snapshot)`: a record built field by field with six members; there is no Guildbook member to serialize.
2. `PublicSnapshotGuard`: a structural allowlist for every object at every depth, enforced inside `RpcClient.IngestAsync` and `DeviceRpcClient.IngestAsync` before a request is created. Any key outside the allowlist (including differently-cased variants, `guilds`, `guildbook*`, a future model property) is refused with `InvalidRequest`; nothing is sent.

## Evidence the network payload contains no Guildbook data
`tests/companion-account/PublicPayloadBoundaryTests.cs` + `DeviceIntegrationTests.cs` (run: 632 passed locally on Windows, real DPAPI):
- registered-session upload: the request body contains none of seven synthetic canary values (guild name, member name, GUID, source character, profession, rank, zone), every key passes the guard, observations (`sources`, `maps`) are present, no request path contains `guild`;
- registered-device upload: same, for `fdb_device_ingest`;
- both transports **refuse** a legacy-shaped body with `guilds` and send nothing (server request count unchanged);
- a fully populated public model serializes inside the allowlist; any new property on a public model type would be refused and fail the suite until reviewed;
- **mutation check:** restoring `p_snapshot = snapshot` makes 3 tests fail; also neutralising the guard at both transports makes 4 fail (including the canary-on-the-wire test). Sources were restored afterwards.

## Local behaviour (reused #112 tests, all passing)
Guildbook available locally; A→B→A account switching cannot expose another account's data; stale captures are rejected; restart and startup restore load encrypted data with no network and with AutoSync off; sign-out keeps files and hides the view; corrupt main recovers from backup, failed commit never destroys the valid backup, double corruption fails closed; concurrent saves resolve to the newest capture; a Supabase outage never loses or blocks the local Guildbook (`Handler.Offline`); anonymous installations never store or show a Guildbook.

## #112 reuse list
**Reused unchanged:** `addon/ForeverDB/{Core,Exporter,GuildbookTracker}.lua` (capture provenance + `/fdb guildbook refresh`; local Lua, no network); `LocalGuildbookStore`, `AccountGuildbookSync`, `GuildbookStartupCoordinator`; `ForeverDbSnapshot` provenance fields and `ForeverDbExportParser` provenance parsing; Account `Models.cs`/`AccountSessionManager.cs` (persisted `LastVerifiedAt`, `AccountId`); `GuildbookAccountScopeTests`, `SyntheticFixtureContractTests`; `scripts/guildbook-acceptance/*` and the synthetic workflow; `docs/0.9-guildbook-local-only.md`.
**Adapted:** `SyncService` (explicit DTO named `PublicObservationSnapshot` instead of an anonymous object; independent of #112's collector/device changes); `MainWindow.xaml(.cs)` and `MainWindow.Account.cs` (Guildbook hunks only; the post-sign-in resync restores the local Guildbook first, including in private-pilot environments, and keeps the RC's public-upload behaviour); `AccountMessages` (anonymous mode no longer promises a Guildbook); `CompanionRegressionTests`, `DeviceIntegrationTests`, `DeviceRig` (expectations flipped to local-only); migration 0018 + restore + SQL tests and the web removal (see db-changes.md and the web section of the PR).
**New in this PR (not in #112):** `PublicSnapshotGuard` (transport allowlist), `PublicObservationSnapshot`, `PublicPayloadBoundaryTests`, historical-data inventory/cleanup plan, GDPR notice/test changes.
**Intentionally excluded:** `0016_account_scoped_guildbook.sql` (account-scoped Guildbook **cloud** ingest, contradicts the policy), `0017_account_independent_collectors.sql` and the Companion collector-credential rework (`DeviceCredentialStore`, `DeviceSyncService`, `InstallationSyncCoordinator`, `DeviceContext`, `RpcClient` additions), the account-switching UI ("Switch account", "Return to anonymous"), WoW folder discovery/picker (`WowInstallationLocator`, watcher changes), the AutoSync `force:false` change, and #112's unrelated web changes (zod/CSP bundling, content loader, turnstile, auth-client, rate-limit, env, package files).

## Server side in one paragraph (details: db-changes.md, server-deployment-runbook.md, historical-guildbook-data.md)
Migration 0018 (adapted for the RC; **prepared, not applied anywhere**) puts an observation-only projection in front of the private ingest implementation that both public ingest RPCs already call, so an *old* Companion that still sends `guilds` stores nothing, and it revokes every public function whose name contains `guildbook`. It deletes nothing: historical rows stay, preserved around the legacy body that would otherwise erase them on the next guild-free upload. It fixes three defects of #112's version (stale-snapshot duplicate key, copy-before-lock race with the cleanup, per-ingest temp tables). Disposable-DB tests (clones) cover privileges, legacy paths, restore/reassert, three migration orders and the cleanup script. The account e2e stack now applies 0018 so the browser/API specs run against the retired RPCs.

**Forward-compat warnings (not in the RC):** if the sibling branch's 0016 ever lands *after* 0018 it replaces the 0018 wrapper with a weaker variant (the stale-snapshot bug returns) and copies historical roster rows into a second cloud table (`private.account_guildbook_*`); the inventory reports those tables and the cleanup refuses to run while they are non-empty. Land 0016/0017 only after reading db-changes.md section 4.

**Known limitations / owner decisions:** `fdb_account_installations()` still returns a per-installation guild *count* until the historical cleanup runs (decision D3 in the runbook); re-applying 0012 or `database/restore/0013_*` after 0018 is refused by their own pre-flight (use the reassert script after `database/rollback/0012_kill_switch_restore.sql`); backups, PITR and provider logs keep Guildbook data after a cleanup until their retention expires.

## Acceptance status (what has and has not been run)
| Check | Status |
| --- | --- |
| Companion Windows suite (`tests/companion-account`, real DPAPI) | 632 passed locally (Windows) |
| Other Companion suites (guildbook 23, health 19, map-reveal 48, search-zone 70 assertions) | passed locally |
| `scripts/check-companion-account.py` | passed |
| Synthetic harness self-tests (DPAPI/report, fixture lifecycle, resumable) + A/B fixtures parsed by the production parser | passed locally (synthetic only) |
| Migration 0018, SQL tests, migration-order tests | **CI only** (need Docker + real GoTrue); not run locally |
| Interactive Windows/GUI acceptance on the RC Companion build | **NOT RUN** (the 2026-10-26 record is for the #112 baseline) |
| Real WoW Forever release-client capture | **NOT RUN** (planned separately; synthetic fixtures do not substitute) |
| Production application of 0018 / historical cleanup | **NOT DONE**, needs separate owner authorization |

## Outstanding release blockers and required owner approvals
1. Merge order: this PR → #142 → #141, each needing explicit approval; then complete release revalidation.
2. A new Companion build containing this change, plus the interactive Windows acceptance and the real-client capture on that build. No installer was built or published here; the Companion/addon version was not bumped (owner decision).
3. Separate authorization to apply migration 0018 (procedure in server-deployment-runbook.md). Until it is applied, an **old** Companion still uploads guilds.
4. Separate authorization for the historical Guildbook cleanup; the notice currently (correctly) says historical rows have not been deleted.
5. Other GDPR blockers remain as listed in `docs/gdpr/README.md` (erasure runbook rehearsal, retention scheduling authorization, Cloudflare DPA confirmation).
