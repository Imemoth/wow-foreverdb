# ForeverDB Session Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-character in-game ForeverDB session tracker with XP/hour, gold accounting, inactivity-aware active time, persistent 30-session history, and the approved WoW-native compact/detailed UI.

**Architecture:** Keep all accounting, lifecycle, persistence, and rate calculations in a new `SessionTracker.lua`; keep rendering and controls in `SessionUI.lua`. Session state is stored locally under `ForeverDB_Saved.sessions`, excluded from schema-9 export, and exposed to UI through normalized tracker APIs.

**Tech Stack:** Lua 5.4-compatible addon code, World of Warcraft Forever Interface 16001 APIs, SavedVariables, native WoW frames/fonts/textures, GitHub Actions Lua smoke/compile checks.

**Spec:** `docs/superpowers/specs/2026-09-28-session-tracker-design.md`

## Global Constraints

- V1 is addon-only: no Companion, Supabase, or account-wide aggregation changes.
- Export schema remains exactly **9**; session state must not appear in `ForeverDB_Export`.
- Addon version advances from **0.4.1-alpha** to **0.5.0-alpha**; Companion/installer versions do not change.
- Sessions are keyed by `UnitGUID("player")`; never persist a nil/empty GUID key.
- Offline timeout is configurable in whole minutes; default **60 minutes / 3600 seconds**.
- Inactivity timeout is configurable in whole minutes; default **5 minutes / 300 seconds**.
- History retention is exactly **30 completed sessions per character**.
- XP/hour and all gold/hour rates use **active time**, not wall lifetime or tracked time.
- `Gold/hr` in the compact HUD means **earned/hour**; `Net/hr` is separate.
- XP/gold changes during manual pause or offline time must not be backfilled on resume.
- Use integer copper for all money accounting.
- Prefer existing WoW UI assets and guarded compatibility fallbacks; add no unnecessary bundled art.
- Repo-side smoke/compile PASS is not live-client acceptance; runtime E2E remains PENDING until documented Forever-client evidence exists.

## Review Focus

- **Level-up event reordering/duplicates:** a `PLAYER_LEVEL_UP` and XP update arriving in either order must produce one correct XP delta, never double-count. Task 2 adds explicit event-order tests.
- **Timing-gap leakage:** reload, relog, pause, and an idle gap followed by fresh activity must not retroactively enter tracked/active time. Task 1 pins all four cases.
- **Old/malformed optional SavedVariables:** missing or malformed `sessions` data must recover to defaults without touching `sources`, `maps`, or `guilds`. Task 1 adds a preservation test.
- **Forever UI API/template variance:** the HUD/detail window must initialize with standard APIs and degrade safely when optional backdrop helpers are absent. Task 4 adds a mocked fallback initialization test.
- **Rapid/duplicate money notifications:** repeated `PLAYER_MONEY` with unchanged balance records zero; sequential balance changes record each signed delta exactly once. Task 3 adds both tests.

---

## File Structure

### Create

- `addon/ForeverDB/SessionTracker.lua` — session lifecycle, persistence, XP/gold accounting, timing, history, settings, normalized snapshots.
- `addon/ForeverDB/SessionUI.lua` — compact HUD, detailed window, formatting, drag/lock/show/hide state, reset confirmation, session slash-subcommand handler.
- `tests/session_tracker_smoke.lua` — simulated WoW API tests for lifecycle/accounting/persistence.
- `tests/session_ui_smoke.lua` — mocked-frame tests for UI initialization and non-visual behavior.
- `docs/0.5-session-tracker-acceptance.md` — repo verification plus live Forever acceptance ledger.

### Modify

- `addon/ForeverDB/Core.lua` — version, initialization hooks, login/logout hooks, `/fdb session ...` routing/help.
- `addon/ForeverDB/ForeverDB.toc` — version and load order for tracker/UI modules.
- `.github/workflows/collector-smoke.yml` — run session tracker/UI smoke tests and compile them.
- `CHANGELOG.md` — add Addon 0.5.0-alpha release entry and current-version update.
- `docs/VERSIONING.md` — current addon version becomes 0.5.0-alpha; schema stays 9.
- `docs/ROADMAP.md` — add Session Tracker milestone with repo-complete vs live-runtime status.

---

### Task 1: Session lifecycle, persistence, and timing engine

**Files:**
- Create: `addon/ForeverDB/SessionTracker.lua`
- Create: `tests/session_tracker_smoke.lua`

**Interfaces:**
- Consumes: `FDB.DB`, `GetServerTime()` (fallback `time()`), `UnitGUID("player")`, `UnitName("player")`, `GetRealmName()`, `UnitLevel("player")`, `UnitXP("player")`, `UnitXPMax("player")`, `GetMoney()`, `C_Timer.NewTicker/After` when available.
- Produces:
  - `FDB:InitializeSessionTracker() -> nil`
  - `FDB:SessionPlayerReady() -> boolean`
  - `FDB:SessionBeforeLogout() -> nil`
  - `FDB:CheckpointSession(now?) -> nil`
  - `FDB:PauseSession() -> boolean`
  - `FDB:ResumeSession() -> boolean`
  - `FDB:ResetSession() -> boolean`
  - `FDB:SetSessionOfflineTimeout(minutes) -> boolean, string?`
  - `FDB:SetSessionInactivityTimeout(minutes) -> boolean, string?`
  - internal current-character state under `FDB.DB.sessions.characters[guid]`.

- [ ] **Step 1: Build the deterministic test harness and write failing lifecycle tests**

In `tests/session_tracker_smoke.lua`, create simulated APIs with mutable `now`, player GUID/name/realm, XP state, money state, frame events, and timer callbacks.

Add tests named:

```lua
test("starts a session for a valid GUID with exact defaults", ...)
test("missing GUID defers initialization and never creates a nil character key", ...)
test("PLAYER_ENTERING_WORLD retries a player GUID that was unavailable at login", ...)
test("offline gap within 60 minutes resumes and re-baselines without counting the gap", ...)
test("offline gap over 60 minutes archives and starts a new session", ...)
test("pause/resume excludes paused time and re-baselines XP/money", ...)
test("five-minute inactivity caps active time", ...)
test("new activity after idle does not backfill the idle gap", ...)
test("configurable offline and inactivity timeouts validate positive integer minutes", ...)
test("malformed optional session state recovers without changing sources maps or guilds", ...)
```

Core assertions must pin defaults to 3600/300/30 and assert that `trackedSeconds` excludes offline/pause while `activeSeconds` stops at the inactivity cutoff.

- [ ] **Step 2: Run the tracker smoke test and verify the new tests fail**

Run:

```bash
lua5.4 tests/session_tracker_smoke.lua
```

Expected: FAIL because `SessionTracker.lua` and its APIs do not exist yet.

- [ ] **Step 3: Implement persistence normalization and session identity in `SessionTracker.lua`**

Implement:

```lua
FDB:InitializeSessionTracker()
FDB:SessionPlayerReady()
```

Requirements:

- lazily normalize `FDB.DB.sessions.settings` and `characters`;
- defaults are offline=3600, inactivity=300, historyLimit=30;
- recover malformed optional session fields by replacing only the malformed session branch/field;
- never mutate unrelated `sources`, `maps`, `guilds`;
- use GUID as key, name/realm as metadata;
- if GUID is unavailable, return false and never create a placeholder key;
- `InitializeSessionTracker()` must also register a lightweight `PLAYER_ENTERING_WORLD` fallback that calls `SessionPlayerReady()` while no character session is initialized, so a GUID that is late at `PLAYER_LOGIN` is retried automatically.

- [ ] **Step 4: Implement checkpoint, inactivity, pause/resume, reset, and offline-resume semantics**

Implement the task interfaces above with these pinned rules:

- every running checkpoint adds elapsed online/unpaused time to `trackedSeconds`;
- active delta is limited by the previous `lastActivityAt + inactivityTimeout`;
- finalize timing before advancing `lastActivityAt` on future activity;
- a fresh session and every manual/offline resume set `lastActivityAt = now`, live XP/money baselines, and `checkpointAt = now`;
- <= configured offline timeout resumes; > timeout archives meaningful current state and creates a fresh one;
- pause finalizes current timing and stops accounting;
- resume re-baselines XP/money and resets timing anchors without backfill;
- reset archives only a meaningful session, then starts a fresh one;
- `SessionBeforeLogout()` finalizes running time and persists `lastSeenAt = now` before normal save preparation;
- a periodic ~30-second checkpoint updates timers and `lastSeenAt` using the existing project compatibility pattern: `C_Timer.NewTicker`, else recursive `C_Timer.After`, else correctness still works through events/logout.

- [ ] **Step 5: Add history retention and empty-session discard to the same lifecycle implementation**

Archive records must at minimum contain session id, start/end timestamps, tracked/active duration, start/end level, XP/gold totals/rates fields (zero until later tasks populate them).

Meaningful-session rule:

```text
tracked >= 60s OR xp.gained > 0 OR gold.earned > 0 OR gold.spent > 0
```

Keep at most 30 records and evict the oldest.

Extend the test file with:

```lua
test("short empty session is discarded", ...)
test("history retains only the latest 30 completed sessions", ...)
test("two character GUIDs keep isolated current/history state", ...)
```

- [ ] **Step 6: Run tracker tests and compile the new module**

Run:

```bash
lua5.4 tests/session_tracker_smoke.lua
luac5.4 -p addon/ForeverDB/SessionTracker.lua
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add addon/ForeverDB/SessionTracker.lua tests/session_tracker_smoke.lua
git commit -m "feat: add session lifecycle engine"
```

---

### Task 2: XP accounting, level-up reconciliation, XP/hour, and ETA

**Files:**
- Modify: `addon/ForeverDB/SessionTracker.lua`
- Modify: `tests/session_tracker_smoke.lua`

**Interfaces:**
- Consumes: Task 1 session state/timing and player XP APIs.
- Produces:
  - session XP event handling for `PLAYER_XP_UPDATE` and `PLAYER_LEVEL_UP`;
  - `FDB:GetSessionSnapshot()` XP fields:
    - `level`
    - `currentXP`
    - `currentXPMax`
    - `xpGained`
    - `xpPerHour`
    - `etaSeconds` or nil
    - `isMaxLevel`.

- [ ] **Step 1: Add failing XP tests**

Add:

```lua
test("normal same-level XP gain increments once and marks activity", ...)
test("XP/hour uses active seconds", ...)
test("level-up XP wrap uses previous max minus previous XP plus new XP", ...)
test("level-up event before XP event does not double-count", ...)
test("XP event before level-up event does not double-count", ...)
test("duplicate XP events with unchanged state add zero", ...)
test("same-level XP decrease re-baselines instead of subtracting gained XP", ...)
test("max-level or unusable XP max returns no ETA", ...)
test("missing XP APIs fail safely and preserve prior totals", ...)
test("paused XP gained is not backfilled after resume", ...)
```

Use the spec example `48,000/50,000 -> level 24 at 1,200/54,000 = 3,200 gained` as an exact assertion.

- [ ] **Step 2: Run the focused smoke suite and verify XP tests fail**

Run:

```bash
lua5.4 tests/session_tracker_smoke.lua
```

Expected: new XP tests FAIL.

- [ ] **Step 3: Implement XP state reconciliation**

Add internal XP reconciliation driven by current `level/xp/xpMax`, not by trusting event order.

Pinned behavior:

- same level + positive delta: add delta;
- same level + zero: no-op;
- same level + negative: replace baseline only;
- exactly one level higher: `(oldMax - oldXP) + newXP`;
- ambiguous/multi-level/impossible state: re-baseline without fabricated gain;
- update activity only after accepting a positive XP gain;
- paused/uninitialized sessions ignore accounting events.

Register XP events once during tracker initialization.

- [ ] **Step 4: Implement XP/hour, ETA, and max-level snapshot fields**

In `FDB:GetSessionSnapshot()`:

```text
xpPerHour = xpGained / effectiveActiveSeconds * 3600
etaSeconds = (currentXPMax - currentXP) / (xpPerHour / 3600)
```

Return nil rate/ETA when active time/rate/current max is not usable; expose `isMaxLevel` when the client indicates no next-level progression.

- [ ] **Step 5: Run tests and compile**

Run:

```bash
lua5.4 tests/session_tracker_smoke.lua
luac5.4 -p addon/ForeverDB/SessionTracker.lua
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add addon/ForeverDB/SessionTracker.lua tests/session_tracker_smoke.lua
git commit -m "feat: track session XP and level progress"
```

---

### Task 3: Gold accounting, rates, normalized snapshot, and export isolation

**Files:**
- Modify: `addon/ForeverDB/SessionTracker.lua`
- Modify: `tests/session_tracker_smoke.lua`

**Interfaces:**
- Consumes: Task 1 timing/lifecycle, Task 2 snapshot, `GetMoney()`, `PLAYER_MONEY`.
- Produces:
  - `FDB:GetSessionSnapshot()` gold/time/status fields:
    - `goldEarned`, `goldSpent`, `netGold`
    - `earnedPerHour`, `spentPerHour`, `netPerHour`
    - `currentMoney`
    - `trackedSeconds`, `activeSeconds`
    - `status = "RUNNING" | "IDLE" | "PAUSED"`
    - `startedAt`
  - `FDB:GetSessionHistory() -> table` read-only normalized records for UI consumption.

- [ ] **Step 1: Add failing money/snapshot tests**

Add:

```lua
test("positive money delta increments earned in integer copper", ...)
test("negative money delta increments spent and net equals earned minus spent", ...)
test("unchanged duplicate money notification records zero", ...)
test("rapid sequential money notifications record each signed delta exactly once", ...)
test("missing first money baseline only establishes baseline", ...)
test("paused money changes are not backfilled after resume", ...)
test("earned spent and net per hour use active time", ...)
test("status precedence is PAUSED then IDLE then RUNNING", ...)
test("history snapshot records close-time XP and gold rates", ...)
```

- [ ] **Step 2: Run tracker tests and verify new cases fail**

Run:

```bash
lua5.4 tests/session_tracker_smoke.lua
```

Expected: new gold/snapshot tests FAIL.

- [ ] **Step 3: Implement `PLAYER_MONEY` accounting**

Use `GetMoney()` integer copper baseline:

- `delta > 0` -> earned;
- `delta < 0` -> spent by absolute value;
- `delta == 0` -> no accounting and no activity;
- missing/invalid baseline -> establish baseline only;
- accepted non-zero delta marks activity only after timing is finalized;
- paused/uninitialized sessions do not account.

- [ ] **Step 4: Complete normalized current/history snapshots**

`GetSessionSnapshot()` must calculate effective current tracked/active time without mutating persisted counters, so UI refreshes do not themselves create accounting side effects.

`GetSessionHistory()` returns normalized retained records and must not expose mutable persistence tables for direct UI writes; return copied/derived row tables.

- [ ] **Step 5: Lock schema-9 export isolation with a regression test**

Load `Database.lua` and `Exporter.lua` in the test fixture and add:

```lua
test("session SavedVariables stay local and schema 9 export has no session records", ...)
```

Assertions:

- `FDB.SCHEMA_VERSION == 9`;
- session state exists under `ForeverDB_Saved.sessions`;
- `ForeverDB_Export` contains its normal H record;
- export contains no session id/character session metadata introduced by this feature.

No `Exporter.lua` change is expected unless this test reveals accidental generic serialization.

- [ ] **Step 6: Run tracker tests and compile**

Run:

```bash
lua5.4 tests/session_tracker_smoke.lua
luac5.4 -p addon/ForeverDB/SessionTracker.lua
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add addon/ForeverDB/SessionTracker.lua tests/session_tracker_smoke.lua
git commit -m "feat: track session gold and rates"
```

---

### Task 4: Compact WoW-native Session HUD

**Files:**
- Create: `addon/ForeverDB/SessionUI.lua`
- Create: `tests/session_ui_smoke.lua`
- Modify: `addon/ForeverDB/SessionTracker.lua`
- Modify: `tests/session_tracker_smoke.lua`

**Interfaces:**
- Consumes: `FDB:GetSessionSnapshot()`, `FDB:SetSessionHUDShown(shown)`, `FDB:SetSessionHUDLocked(locked)`.
- Produces:
  - `FDB:InitializeSessionUI() -> nil`
  - `FDB:RefreshSessionUI() -> nil`
  - `FDB:ToggleSessionHUD() -> boolean`
  - `FDB:SetSessionHUDPosition(point, relativePoint, x, y) -> boolean`
  - compact HUD frame with XP/hr, To level, Gold/hr(earned/hr), Net/hr, Active, status.

- [ ] **Step 1: Add tracker tests for persisted HUD settings**

Add to `tests/session_tracker_smoke.lua`:

```lua
test("HUD shown locked and position settings persist per character", ...)
test("invalid HUD position data normalizes to safe defaults", ...)
```

Pinned defaults:

- shown=true;
- locked=false;
- safe initial anchor such as `TOPLEFT` relative to `UIParent`;
- position values are numeric.

- [ ] **Step 2: Add a mocked UI smoke test that initially fails**

In `tests/session_ui_smoke.lua`, provide minimal mocks for `CreateFrame`, font strings, textures, drag methods, `UIParent`, and optional backdrop helpers.

Add:

```lua
test("HUD initializes without optional BackdropTemplate helpers", ...)
test("HUD renders Gold/hr from earnedPerHour and Net/hr separately", ...)
test("HUD hide does not pause the session", ...)
test("HUD lock disables drag movement while unlock allows it", ...)
test("HUD drag stop persists position through tracker API", ...)
```

- [ ] **Step 3: Run both smoke tests and verify UI cases fail**

Run:

```bash
lua5.4 tests/session_tracker_smoke.lua
lua5.4 tests/session_ui_smoke.lua
```

Expected: UI tests FAIL because `SessionUI.lua` does not exist.

- [ ] **Step 4: Implement HUD persistence APIs in `SessionTracker.lua`**

Implement:

```lua
FDB:SetSessionHUDShown(shown)
FDB:SetSessionHUDLocked(locked)
FDB:SetSessionHUDPosition(point, relativePoint, x, y)
```

These mutate only current-character UI settings, normalize invalid values, and do not touch accounting state.

- [ ] **Step 5: Implement the compact HUD in `SessionUI.lua`**

Visual contract from the approved mockup:

- dark near-black panel;
- restrained gold/bronze border/title treatment;
- no Alliance/Horde icon;
- title `ForeverDB Session`;
- two-column KPI rows:
  - XP/hr + To level;
  - Gold/hr + Net/hr;
  - Active;
- bottom status/character strip;
- green positive net, red negative net, neutral zero;
- purple XP emphasis, gold money emphasis;
- clear RUNNING/IDLE/PAUSED state;
- draggable only while unlocked;
- hide/close affects presentation only, never session state.

Use standard WoW fonts/textures. If backdrop mixins/templates are unavailable, fall back to simple frame textures/borders rather than erroring.

- [ ] **Step 6: Add a lightweight render ticker**

Use a UI-only refresh cadence around 1 second via `C_Timer.NewTicker` with `C_Timer.After` fallback. The ticker calls `GetSessionSnapshot()` and renders; it does not mutate accounting.

- [ ] **Step 7: Run tracker/UI smoke and compile**

Run:

```bash
lua5.4 tests/session_tracker_smoke.lua
lua5.4 tests/session_ui_smoke.lua
luac5.4 -p addon/ForeverDB/SessionTracker.lua
luac5.4 -p addon/ForeverDB/SessionUI.lua
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add addon/ForeverDB/SessionTracker.lua addon/ForeverDB/SessionUI.lua tests/session_tracker_smoke.lua tests/session_ui_smoke.lua
git commit -m "feat: add session HUD"
```

---

### Task 5: Detailed Session window, history UI, reset confirmation, and session commands

**Files:**
- Modify: `addon/ForeverDB/SessionUI.lua`
- Modify: `tests/session_ui_smoke.lua`

**Interfaces:**
- Consumes: tracker snapshot/history and pause/resume/reset/settings/HUD APIs from Tasks 1-4.
- Produces:
  - `FDB:ToggleSessionWindow() -> boolean`
  - `FDB:ShowSessionResetConfirmation() -> nil`
  - `FDB:HandleSessionCommand(rawArgs) -> boolean`
  - detailed window matching the approved information architecture.

- [ ] **Step 1: Add failing command/control tests**

Add:

```lua
test("session command with no args toggles detailed window", ...)
test("pause and resume commands delegate to tracker APIs", ...)
test("reset command opens confirmation and does not reset immediately", ...)
test("confirmed reset delegates exactly once", ...)
test("timeout command accepts positive integer minutes and rejects invalid values", ...)
test("idle command accepts positive integer minutes and rejects invalid values", ...)
test("hud and lock commands toggle persisted HUD state", ...)
```

Assert invalid values leave prior settings unchanged.

- [ ] **Step 2: Add failing detailed-window render tests**

Use mocked frames/font strings/buttons/scroll container and assert the window creates and refreshes labels for:

- KPI row: XP/hr, XP gained, To level, Gold earned, Gold spent, Net gold;
- Session Timing: Session, Active, Status, Started;
- Character: Level, XP current/max, progress, carried gold;
- Rates: Earned/hr, Spent/hr, Net/hr;
- Recent Sessions rows from `GetSessionHistory()`;
- controls: Pause, Resume, Reset, Lock HUD, Hide/Show HUD.

- [ ] **Step 3: Run UI smoke and verify new tests fail**

Run:

```bash
lua5.4 tests/session_ui_smoke.lua
```

Expected: new detail/command tests FAIL.

- [ ] **Step 4: Implement detailed window**

Keep the approved mockup structure, but use faction-neutral ForeverDB styling and standard WoW assets.

History is scrollable and renders retained rows without mutating them. Use these columns where screen width permits:

```text
Date/Time | Duration | Active | Level start->end | XP gained | XP/hr | Earned | Spent | Net
```

If the client width requires a more compact row, preserve the same data through abbreviated headers/tooltips rather than dropping accounting fields.

- [ ] **Step 5: Implement reset confirmation**

Use `StaticPopupDialogs`/`StaticPopup_Show` when available, with a small native confirmation frame fallback if not.

Both the Reset button and `/fdb session reset` must enter this confirmation path. Only confirmation calls `FDB:ResetSession()`.

- [ ] **Step 6: Implement `FDB:HandleSessionCommand(rawArgs)`**

Supported exact subcommands:

```text
""                  -> toggle detailed window
pause
resume
reset
hud
lock
timeout <minutes>
idle <minutes>
```

Unknown/invalid subcommands print concise usage and return false; successful recognized commands return true.

- [ ] **Step 7: Run UI smoke and compile**

Run:

```bash
lua5.4 tests/session_ui_smoke.lua
luac5.4 -p addon/ForeverDB/SessionUI.lua
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add addon/ForeverDB/SessionUI.lua tests/session_ui_smoke.lua
git commit -m "feat: add detailed session window"
```

---

### Task 6: Addon integration, version bump, slash routing, and CI

**Files:**
- Modify: `addon/ForeverDB/Core.lua`
- Modify: `addon/ForeverDB/ForeverDB.toc`
- Modify: `.github/workflows/collector-smoke.yml`
- Modify: `tests/session_ui_smoke.lua` or `tests/session_tracker_smoke.lua` only if integration coverage needs a Core fixture.

**Interfaces:**
- Consumes: `InitializeSessionTracker`, `InitializeSessionUI`, `SessionPlayerReady`, `SessionBeforeLogout`, `HandleSessionCommand`.
- Produces: fully loaded Addon 0.5.0-alpha session feature under `/fdb session ...`.

- [ ] **Step 1: Add failing Core-routing/load-order integration assertions**

Extend a smoke fixture to load `Core.lua` with the new modules and assert:

- `/fdb session` delegates to `HandleSessionCommand("")`;
- `/fdb session timeout 45` delegates raw session args correctly;
- generic help includes `/fdb session`;
- addon load calls tracker/UI initialization;
- player login calls `SessionPlayerReady()`;
- player logout calls `SessionBeforeLogout()` before save preparation.

- [ ] **Step 2: Run integration smoke and verify failures**

Run the affected smoke file.

Expected: FAIL because Core/TOC are not wired yet.

- [ ] **Step 3: Wire Core integration and bump addon version**

In `Core.lua`:

- set `FDB.VERSION = "0.5.0-alpha"`;
- call `InitializeSessionTracker()` and `InitializeSessionUI()` during addon initialization after database initialization;
- on `PLAYER_LOGIN`, call `SessionPlayerReady()`;
- on `PLAYER_LOGOUT`, call `SessionBeforeLogout()` before `PrepareForSave()`;
- route `command == "session"` and `command:match("^session%s+")` to `HandleSessionCommand`;
- add `/fdb session` to help without disturbing existing commands.

In `ForeverDB.toc`:

- set `## Version: 0.5.0-alpha`;
- load `SessionTracker.lua` before `SessionUI.lua`;
- place both after core persistence/export primitives and before unrelated collectors/tooltip UI.

- [ ] **Step 4: Extend GitHub Actions smoke coverage**

Update `.github/workflows/collector-smoke.yml` with separate steps:

```yaml
- name: Run session tracker smoke tests
  run: lua5.4 tests/session_tracker_smoke.lua

- name: Run session UI smoke tests
  run: lua5.4 tests/session_ui_smoke.lua
```

Keep the existing collector smoke test. Extend compile validation to both new test files; addon `find ... '*.lua'` already compiles new addon modules automatically.

- [ ] **Step 5: Run full repo-side Lua verification**

Run:

```bash
lua5.4 tests/collector_smoke.lua
lua5.4 tests/session_tracker_smoke.lua
lua5.4 tests/session_ui_smoke.lua

while IFS= read -r -d '' file; do
  luac5.4 -p "$file"
done < <(find addon/ForeverDB -maxdepth 1 -type f -name '*.lua' -print0 | sort -z)

luac5.4 -p tests/collector_smoke.lua
luac5.4 -p tests/session_tracker_smoke.lua
luac5.4 -p tests/session_ui_smoke.lua
```

Expected: all PASS / no compile output.

- [ ] **Step 6: Commit**

```bash
git add addon/ForeverDB/Core.lua addon/ForeverDB/ForeverDB.toc .github/workflows/collector-smoke.yml tests/session_tracker_smoke.lua tests/session_ui_smoke.lua
git commit -m "feat: integrate session tracker addon"
```

---

### Task 7: Release docs, acceptance ledger, final verification, and review gate

**Files:**
- Create: `docs/0.5-session-tracker-acceptance.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/VERSIONING.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes: completed Addon 0.5.0-alpha implementation and CI results.
- Produces: accurate repo/runtime status without falsely claiming live WoW acceptance.

- [ ] **Step 1: Write the acceptance ledger**

Create `docs/0.5-session-tracker-acceptance.md` with two sections.

**Repo-side verification** records:

- tracker smoke result;
- UI smoke result;
- collector regression result;
- Lua compile result;
- schema remains 9;
- GitHub Actions run link/id once available.

**Live Forever acceptance — PENDING** contains the exact checklist from the spec:

- HUD appears, drag/lock/hide/show/position persistence;
- RUNNING/IDLE/PAUSED;
- detailed window KPIs/history/controls;
- XP gain and level-up wrap;
- positive/negative money deltas;
- reload and short-relog resume;
- >timeout new session;
- inactivity active-time cutoff and resume.

Do not mark live items PASS without real client evidence.

- [ ] **Step 2: Update version/changelog/roadmap docs**

`CHANGELOG.md`:

- Current Addon -> 0.5.0-alpha;
- add Addon 0.5.0-alpha entry describing session tracker, HUD/detail UI, 30-session per-character history, local-only schema-9 preservation.

`docs/VERSIONING.md`:

- Addon current -> 0.5.0-alpha;
- Export schema stays 9;
- Companion/installer stay 0.8.2-alpha.

`docs/ROADMAP.md`:

- Current baseline Addon -> 0.5.0-alpha;
- add `0.5.0-alpha — Session Tracker` milestone;
- repo implementation/checks may be checked after verification;
- live Forever acceptance remains unchecked/PENDING until evidence is recorded;
- link the new acceptance ledger.

- [ ] **Step 3: Run final local verification**

Run:

```bash
lua5.4 tests/collector_smoke.lua
lua5.4 tests/session_tracker_smoke.lua
lua5.4 tests/session_ui_smoke.lua

while IFS= read -r -d '' file; do
  luac5.4 -p "$file"
done < <(find addon/ForeverDB -maxdepth 1 -type f -name '*.lua' -print0 | sort -z)

git diff --check
```

Expected: all smoke tests PASS, compile PASS, `git diff --check` no output.

- [ ] **Step 4: Commit release documentation**

```bash
git add CHANGELOG.md docs/VERSIONING.md docs/ROADMAP.md docs/0.5-session-tracker-acceptance.md
git commit -m "docs: record session tracker alpha"
```

- [ ] **Step 5: Verify GitHub Actions on the implementation branch/PR**

Confirm the updated Collector smoke workflow completes successfully and records green steps for:

- collector smoke;
- session tracker smoke;
- session UI smoke;
- addon/test Lua compile.

Record the run in the acceptance ledger. Do not equate this with live-client acceptance.

- [ ] **Step 6: Request a fresh whole-branch review**

Reviewer focus:

- spec fidelity;
- XP level-up/event-order correctness;
- timing inactivity/offline/pause leakage;
- money exactly-once delta accounting;
- SavedVariables backward compatibility/export schema isolation;
- WoW API compatibility/guarded UI fallbacks;
- Core lifecycle/load ordering;
- tests/docs truthfulness.

Fix any blocking findings, rerun the full verification, and commit fixes separately.

- [ ] **Step 7: Stop at live-client acceptance boundary**

Repo-side implementation may be declared complete only with green local/CI verification and review. Keep runtime acceptance PENDING until the user runs the Forever client checklist and supplies evidence.
