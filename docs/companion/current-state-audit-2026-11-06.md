# ForeverDB Companion — release baseline audit and integration order
_Date: 2026-11-06. Source: inspected `release` code at `26a7820be6851805c7445359583a236c5a5ba389`, plus CLOSED, UNMERGED PRs #81/#82/#83. No Windows client or staging write was performed in this audit._

## Product decision

The Companion is a Windows .NET 8 WPF client, currently **0.9.1-alpha**. It maintains a locally cached Guildbook, while sending **only explicitly public source/item/map observation data** to the authorized API. Guildbook **must remain LOCAL-ONLY**, with no Guildbook RPC, cloud sync, server storage or public page. Local data refresh from WoW SavedVariables, encrypted DPAPI persistence and verified-account isolation are allowed and should not be confused with online sync. Quest/account session histories are also private and outside the existing public Schema 9 payload.

The accepted addon Quest Tracker is **0.7.1-alpha / Interface 16001 / Schema 9**, merged in #173. It stores rich per-character quest records locally. Those records are **not yet transported** by the Companion. This distinction is intentional and cannot be bypassed by serializing the raw SavedVariables.

## Inspected state: code present on release vs demonstrated behavior

| Subsystem | On release | Evidence and acceptance gap |
| --- | --- | --- |
| Windows shell | WPF, custom tabs, single-instance/tray, optional Windows startup/minimize | `MainWindow.xaml`, `MainWindow.xaml.cs`, `StartupService.cs`; new build/release-client GUI confirmation pending |
| Database status/sync | Manual `Sync now`, status and error fields, watcher, startup/auto triggers, anonymous ownership sync | `SyncService.cs`, `WowSavedVariablesWatcher.cs`; **nonempty staging Sync Now and idempotent read-back not yet accepted** |
| Account | Supabase GoTrue, verified registered/anonymous sessions, DPAPI protected credentials, ownership-aware coordinator, manual registered-device upload | `ForeverDB.Companion.Account`; cross-account live acceptance and staging checks pending |
| Registered device AutoSync | **Disabled** via `AccountFeatureGate.DeviceAutoSyncApproved=false` even if UI AutoSync setting is true | CLOSED PR #81 implements a proposal; requires fresh port, explicit opt-in and ownership policy review |
| WoW folder selection | Manual path text box; `SettingsService.DetectWowRoot()` searches **only `_classic_beta_`**; loaded empty path can be silently filled | Existing release is **not Forever-safe by default**. CLOSED PR #82 proposes Browse/detection but its candidate list also lacks `_forever_` |
| Secure account switching | Registered sign-in/sign-out and legacy-anonymous identity handling exist; explicit Switch Account/Return Anonymous UI and device current-account authorization are **not** in release | CLOSED PR #83; port the security guard before re-enabling registered AutoSync |
| Item/source search | Source and item lookup, detail navigation, zone browser, loot/skinning/mining/herbalism/fishing/GameObject/disenchant types | `MainWindow.xaml`, `SearchService.cs`, `SearchModels.cs`; preserve behavior and tests |
| Maps | client CASC + exact-build CDN fallback, map cache, map metadata, zone selection, markers/clusters/heatmap | `NativeCascMapReader`, `WowClientMapAssetProvider`, `MapPreviewControl`, `MapPrewarm`; validate against installed `_forever_` client |
| Guildbook | WPF Guildbook tab, filters, local encrypted `LocalGuildbookStore`, local restore and capture freshness | `AccountGuildbookSync.cs`, `GuildbookStartupCoordinator.cs`. **No network Guildbook sync**. Existing tab is only accessible to verified registered account; offline restore may work with prior verified proof |
| Addon 0.7.1 questloot | `ForeverDbExportParser` and public projection support `questDrops` and optional `questIds` in Schema 9 `I` records | Item quest flag exists, **real item -> quest ID can remain unknown** when CSV empty |
| Full Quest Database | No `Q` or `R` record parser/transport, no quest list/quest detail UI, no canonical quest ingest/read model | Separate privacy-reviewed, versioned anonymous addon -> Companion -> staging -> publisher contract required |
| Build and testing | `companion-build.yml` creates Windows win-x64 artifact; installer workflow, account tests, Guildbook local-only guards and specialized test projects | CI/synthetic results must not be represented as actual Windows + live Forever/client + staging end-to-end acceptance |

### Risk findings

1. **P0: wrong WoW client discovery.** The only automatic paths in release point to `_classic_beta_`. The app must prefer user-confirmed `_forever_` and never silently change an explicitly saved root. Reject accidental beta-target uploads and report the selected root before sync.
2. **P0: no unintended production upload during staging.** `CompanionSettings` defaults to the production endpoint and `AutoSync=true`. Account environment gates support isolated staging, but a generic `Sync now` must not be used for staging validation until the effective destination, installation owner and test isolation are proven. Disable automatic network upload while setting up the test.
3. **P0: registered device + account safety.** Release `SyncRegisteredDeviceAsync` routes device uploads without the new explicit current human-account ownership check from #83. Add that fail-closed guard and identity-change cancellation before allowing account switching or device AutoSync.
4. **P1: watcher write completeness/idempotence.** Current watcher uses a 1.5s debounce but lacks the bounded stable-file check proposed in #81. Add robust complete-write validation, per-installation locking and snapshot idempotence tests. The old #81 implementation must NOT be copied blindly.
5. **P1: opt-in semantics.** Release setting `AutoSync=true` is a default, while device AutoSync is currently blocked. Enabling `DeviceAutoSyncApproved` alone would unexpectedly start registered uploads for users with that default; obtain explicit user consent for a new capability, preserve existing saved preferences safely, never enable installation-wide automatic uploads by side effect.
6. **P1: Guildbook boundary.** Preserve DPAPI CurrentUser / account + installation scoping, local-first processing, capture freshness checks and `PublicSnapshotGuard` at transport. No Guildbook payload, RPC or backend migration. Recheck private roster exclusion on all new upload paths. Do not accidentally feed Guildbook member counts as remote public statistics.
7. **P1: docs drift.** `docs/SYNC.md` and `docs/ROADMAP.md` contain obsolete version/state snapshots. Update only after the implementation and verified acceptance; source code and current CI take precedence over outdated prose.

## Integration sequence — new, reviewable changes on fresh release

### C0a — Forever client support and selection
- Port/modernize #82's Windows folder chooser, bounded discovery and validation. Include `_forever_` explicitly; handle other flavors without **automatically** treating a beta client as the owner-selected Forever client.
- Preserve saved valid paths and installation IDs; make non-network local parse/verification work without any Supabase access.
- Tests: fresh setup, custom location, multiple installs, `_forever_` vs beta, missing WTF, invalid/unwritable paths, manual picker cancellation.

### C0b — account switching and ownership safety
- Port/modernize #83's Sign out / Switch account / Return to anonymous flows with pending local revocation semantics; prevent any registered-device secret from being used while an unrelated human account is signed in.
- Identity-generation scoped caches, in-flight cancellation, owner proof, cross-account negative tests and Guildbook cross-account isolation.
- Keep Guildbook locally readable only under the intended verified-account policy, including the documented offline proof path.

### C0c — current Schema 9 manual staging integration
- Proceed with the exact isolated **staging-only** nonempty Sync Now, idempotent replay, read-back and public-payload gate specified in `docs/companion/quest-staging-v1.md`, issue #175.
- No production uploads, account transfer, schema migration or auto upload. Use redacted/synthetic fixtures in CI; never commit raw SavedVariables.

### C0d — user-controlled registered AutoSync, *after* C0b/C0c
- Review and port #81's stable-write/dedupe and serial device sync, but require explicit per-installation opt-in and clear off/status indicators. Keep manual Sync Now operable when AutoSync is off.
- Test restart, rapid writes, simultaneous updates, stale snapshot, account switch, revoked/incorrect device owner, network outage, Guildbook local capture even when cloud upload blocked.

### C1 — future anonymous quest observations (separate design/implementation approval)
- Only after C0 staging succeeds, define a versioned extension contract with build/locale/questID/objectives/rewards, observed giver/receiver/NPC and source-item evidence, provenance/conflict/retention/idempotency rules.
- **Never upload `questJournal` or full player history**. Only verified, anonymous canonical candidate data, no inferred selected choice or NPC spawn coordinate.
- Separate addon exporter, Companion parser and allowlist, isolated ingest, publisher/read models and AzerDex Quest DB UI PRs with independent owner approvals.

## Release gates

- Companion `0.9.1-alpha` is the review build for C0b safety fixes; addon `0.7.1-alpha` and Schema 9 remain unchanged.
- Reuse windows `.NET 8` build, account/owner/GoTrue integration, Guildbook local-only guard, map/search regression and installer acceptance.
- Require real Windows UI and selected Forever client acceptance, with an explicit staging endpoint shown before any upload.
- Preserve branch protection and prepare each implementation PR on current `release`, never on historical #81/#82/#83 commits.

References: #173 (merged addon), #175 (Companion staging), #176 (Draft implementation and C0 tracking), old CLOSED unmerged #81/#82/#83.

## C0a/C0b implementation status on Draft PR #176

The implementation extends the release baseline above; that table remains a record of the pre-change `release` branch.

| Area | Implemented in #176 | Remaining evidence |
| --- | --- | --- |
| Installation discovery | Bounded known-location scan includes `_forever_` and other known flavors; a unique Forever client may prefill Settings. A detected or changed path stays unconfirmed until Save. | W1-W3 owner-reported complete on preceding build |
| Installation validation | Local validation distinguishes a real client from `WTF/Account/.../SavedVariables/ForeverDB.lua`; a client without initialized SavedVariables stays valid. `_classic_beta_` cannot be saved as the Forever data source. | Validate against actual Forever and beta installs on Windows |
| Account actions | Sign out, Switch account, and Return to preserved anonymous identity are explicit. Pending server revocation remains visible and retryable. | W4 on isolated staging accounts |
| Device ownership | Manual registered-device upload requires a verified current account and a fresh server ownership result for the target installation. Session generation changes cancel the upload; no fallback credential is tried. | W4/W6 on Windows and C0c staging validation |
| AutoSync | `AccountFeatureGate.DeviceAutoSyncApproved` remains `false`; registered-device automatic triggers send nothing. | W6 Windows acceptance; C0d opt-in design |
| Private data | Schema 9 projection and `PublicSnapshotGuard` remain the transport boundary; Guildbook remains encrypted/local-only. | W5 on Windows; automated local-only CI |

### Registered-device AutoSync migration rule for C0d

The existing `CompanionSettings.AutoSync` preference is not consent for registered-device automatic upload. C0d must introduce a separate per-installation opt-in, default it to off for every upgrade and new installation, show the selected installation and current owner before consent, and invalidate the opt-in when ownership or account identity changes. Manual Sync Now remains available when that opt-in is off. `DeviceAutoSyncApproved` stays false until a separately reviewed C0d and owner acceptance.

Companion is **0.9.1-alpha**; addon `0.7.1-alpha`, interface `16001`, and Schema 9 are unchanged. W4-W6 Windows owner acceptance and C0c nonempty staging upload/read-back remain pending. See [windows-acceptance-checklist.md](windows-acceptance-checklist.md).
