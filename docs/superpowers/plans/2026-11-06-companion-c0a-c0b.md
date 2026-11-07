# Companion C0a/C0b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Companion installation discovery Forever-aware and add safe explicit account switching while preserving local Guildbook isolation and manual sync.

**Architecture:** Put deterministic, bounded WoW installation discovery and validation in a UI-free service, then connect it to the existing Settings flow with the native Windows folder picker. Reuse the Account System V1 session manager, generation invalidation, ownership router, device credential model, and local Guildbook store; extend only the missing action and safety checks.

**Tech Stack:** .NET 8, WPF, C#, xUnit and existing Companion account/Guildbook test projects.

**Spec:** User-provided C0a/C0b implementation brief and follow-up P0 safety / Windows acceptance brief. The follow-up explicitly sets Companion `0.9.1-alpha`, overriding the prior version constraint; baseline and integration notes are in `docs/companion/current-state-audit-2026-11-06.md` and `docs/companion/quest-staging-v1.md`.

## Global Constraints

- Companion `0.9.1-alpha` is the reviewed safety-fix build, addon `0.7.1-alpha`, export schema `9`, and WoW Forever Interface `16001`.
- Never silently choose `_classic_beta_`; prefer valid explicit selection, then detected `_forever_`.
- Discovery is local only and never initiates an upload.
- Preserve account credentials, anonymous identity, install IDs, SavedVariables, and existing settings.
- Registered-device AutoSync remains disabled; manual Sync Now remains available.
- Guildbook remains local-only; preserve `PublicObservationSnapshot.From(snapshot)` and `PublicSnapshotGuard`.
- Do not add Schema 10, a quest journal transport, cloud Guildbook path, database migration, or production deployment.
- Keep PR #176 Draft and stop at owner-operated Windows acceptance.

## Review Focus

- A saved but unavailable custom root must not be replaced by discovery; test load/restart persistence.
- A legacy beta directory must not become a selected upload source; test mixed beta/Forever discovery.
- A real client without SavedVariables is still valid; test its distinct initialization status.
- Account identity changes during ownership resolution or ingest must invalidate old work; test stale cancellation.
- A registered-device installation owned by another account or unknown due to an unavailable ownership API must fail closed; test both outcomes.

---

### Task 1: UI-free WoW Forever installation discovery

**Files:**
- Create: `companion/ForeverDB.Companion/Services/WowInstallationLocator.cs`
- Modify: `companion/ForeverDB.Companion/Services/SettingsService.cs`
- Modify: `tests/companion-account/Companion.Account.Tests.csproj`
- Create: `tests/companion-account/WowInstallationLocatorTests.cs`

**Interfaces:**
- Produce `WowInstallationLocator.Discover(IEnumerable<string>? roots = null) -> IReadOnlyList<WowInstallation>` for bounded, known-parent flavor discovery.
- Produce `WowInstallationLocator.Validate(string path) -> WowInstallationValidation` with valid root, flavor, install state, SavedVariables availability, and a user-readable local error.
- Preserve explicit paths in settings even when validation reports unavailable; discovery fills an empty path only with one unambiguous `_forever_` candidate.

- [ ] Test `_forever_` discovery, beta exclusion from default selection, multiple flavors, missing SavedVariables, invalid paths, and custom-path persistence/restart.
- [ ] Run the linked service tests and observe failure before implementation.
- [ ] Implement bounded known-directory discovery and path validation without network or recursive drive scans.
- [ ] Re-run locator and settings tests.

### Task 2: Settings picker and validation UI

**Files:**
- Modify: `companion/ForeverDB.Companion/MainWindow.xaml`
- Modify: `companion/ForeverDB.Companion/MainWindow.xaml.cs`
- Modify: `companion/ForeverDB.Companion/Services/SettingsService.cs`

**Interfaces:**
- Add a native folder selection action for WoW root; cancelling preserves the current selection.
- Show detected candidates, current root validity, and SavedVariables state; only commit a changed path after Save.

- [ ] Add UI-level source/markup contract checks for Browse, detected candidates, status, and Save/Cancel semantics.
- [ ] Wire the Windows native folder dialog; no filesystem path is copied to remote logs.
- [ ] Confirm Cancel leaves settings untouched and Save validates before rebuilding watchers/services.

### Task 3: Account switching and registered-device ownership guard

**Files:**
- Modify: `companion/ForeverDB.Companion.Account/DeviceSyncService.cs`
- Modify: `companion/ForeverDB.Companion.Account/InstallationSyncCoordinator.cs` only if a missing invariant is found
- Modify: `companion/ForeverDB.Companion/MainWindow.xaml`
- Modify: `companion/ForeverDB.Companion/MainWindow.Account.cs`
- Modify: `tests/companion-account/DeviceSyncTests.cs`
- Modify: `tests/companion-account/OwnershipRoutingTests.cs`
- Modify: `tests/companion-account/GuildbookAccountScopeTests.cs`

**Interfaces:**
- Add explicit Switch Account and Return to Anonymous actions through existing `AccountSessionManager` APIs; never replace or delete another credential implicitly.
- Before registered-device upload, require authoritative current installation ownership, matching identity/session generation, and a current installation-target authorization.
- Reuse the existing generation-scoped cancellation and pending server-revocation flow.

- [ ] Add regression cases for Account A → B → A, sign-out with pending revocation, anonymous identity preservation, device ownership mismatch, ownership API outage, and stale in-flight sync after switching.
- [ ] Extend Guildbook tests for cross-account isolation, verified offline restoration, and installation switching.
- [ ] Implement only guards/actions absent from release; keep `DeviceAutoSyncApproved == false` and manual Sync Now.
- [ ] Run account, Guildbook, and public-payload boundary suites.

### Task 4: Documentation and final verification

**Files:**
- Modify: `companion/README.md`
- Modify: `docs/companion/current-state-audit-2026-11-06.md`
- Modify: `docs/companion/quest-staging-v1.md` only if its implementation-state wording needs reconciliation
- Modify or create: `docs/companion/windows-acceptance-checklist.md`
- Modify: Companion changelog if present

- [ ] Document C0a/C0b implementation status, explicit AutoSync opt-in/migration rule, and future anonymous quest-data boundary.
- [ ] Write W1-W6 owner Windows acceptance steps and leave all unrun GUI scenarios pending.
- [ ] Run .NET solution/project build, account, Guildbook, map/search and local-only policy checks available in this environment; report Windows-only and CI-only gaps distinctly.
- [ ] Verify Schema 9 parser and public payload boundary remain intact; verify no private fields or Guildbook RPC were added.
- [ ] Verify Draft PR #176 branch/head and push only tested implementation commits; do not merge or release.
