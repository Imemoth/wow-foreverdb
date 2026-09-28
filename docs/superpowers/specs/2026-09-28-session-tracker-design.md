# ForeverDB Session Tracker — Design

Status: approved conversational design; implementation not started  
Date: 2026-09-28  
Scope: WoW addon only (V1)

## 1. Intent

ForeverDB needs an in-game session tracker that gives useful leveling and farming feedback without requiring the Companion.

V1 must show:

- XP gained and XP/hour;
- estimated time to next level;
- gold earned, gold spent, net gold;
- earned/hour, spent/hour, and net/hour;
- session time and active time;
- a compact movable HUD;
- a detailed ForeverDB Session window;
- recent per-character session history.

The tracker is intended to be useful during ordinary leveling and farming. Its rates must not be destroyed by short breaks, reloads, relogs, or temporary inactivity.

## 2. Scope and non-goals

### In scope

- per-character session state;
- automatic start and resume;
- configurable offline timeout, default 60 minutes;
- configurable inactivity timeout, default 5 minutes;
- manual pause, resume, and reset;
- XP and gold accounting;
- active-time based rates;
- up to 30 completed sessions per character;
- local persistence in SavedVariables;
- compact HUD and detailed in-game window;
- slash commands;
- simulated Lua smoke tests;
- live Forever client acceptance checklist.

### Explicitly out of scope for V1

- Companion parsing or UI;
- Supabase storage;
- account-wide aggregation;
- export-schema changes;
- gold source categorization such as loot/vendor/repair/AH/mail/trade;
- route, farm, or profitability recommendations;
- rolling 10/15-minute rates;
- cross-character combined sessions.

The V1 data model should remain easy to export later, but no session data is added to the schema-9 export contract in this milestone.

## 3. Versioning

The feature changes in-game addon behavior and UX, so implementation should advance the addon from 0.4.1-alpha to the next coherent minor milestone, expected to be 0.5.0-alpha.

The export schema remains 9 because session state is local-only and is not emitted by the exporter. Companion and installer versions do not change for this work.

## 4. Architecture

Use two focused modules.

### 4.1 `SessionTracker.lua`

Owns all session logic and persisted state:

- lifecycle;
- character identity;
- XP accounting;
- gold accounting;
- timers;
- inactivity detection;
- pause/resume/reset;
- history retention;
- settings validation;
- snapshot/getter API for the UI.

The tracker must not depend on `SessionUI.lua`.

### 4.2 `SessionUI.lua`

Owns presentation only:

- compact HUD;
- detailed session window;
- drag/lock/show/hide behavior;
- formatted values;
- history list;
- reset confirmation;
- periodic render refresh.

The UI must not independently calculate XP, gold, time, or rates. It reads a normalized snapshot from the tracker.

### 4.3 `Core.lua`

Core remains the integration point:

- initialize the tracker after the database/player state is ready;
- initialize the UI;
- route `/fdb session ...` commands.

Business logic should not be moved into `Core.lua`.

## 5. Persistence model

Session state is stored as an optional local branch under `ForeverDB_Saved.sessions`.

Conceptual structure:

```lua
ForeverDB_Saved.sessions = {
    settings = {
        offlineTimeout = 3600,
        inactivityTimeout = 300,
        historyLimit = 30,
    },

    characters = {
        ["Player-GUID"] = {
            name = "Vesperix",
            realm = "...",

            ui = {
                hudShown = true,
                hudLocked = false,
                hudPoint = "TOPLEFT",
                hudRelativePoint = "TOPLEFT",
                hudX = 100,
                hudY = -100,
            },

            current = {
                id = "...",
                startedAt = 0,
                lastSeenAt = 0,
                checkpointAt = 0,
                lastActivityAt = 0,
                paused = false,

                trackedSeconds = 0,
                activeSeconds = 0,

                xp = {
                    startLevel = 0,
                    startXP = 0,
                    gained = 0,
                    lastLevel = 0,
                    lastXP = 0,
                    lastXPMax = 0,
                },

                gold = {
                    startCopper = 0,
                    lastCopper = 0,
                    earned = 0,
                    spent = 0,
                },
            },

            history = {
                -- newest or oldest ordering is an implementation detail,
                -- but retention is capped at 30 completed sessions.
            },
        },
    },
}
```

### 5.1 Character key

Primary key: `UnitGUID("player")`.

Character name and realm are metadata only. If the GUID is temporarily unavailable during startup, initialization waits for a later player-ready event rather than creating a nil or name-based record.

### 5.2 Settings scope

Offline timeout, inactivity timeout, and history limit are addon-wide settings. HUD position/visibility/lock state is per character.

### 5.3 Compatibility

The `sessions` branch is not part of the exported observation contract and must not be serialized into the schema-9 export snapshot.

Existing SavedVariables without `sessions` are initialized lazily with defaults. No destructive migration is required.

## 6. Session lifecycle

### 6.1 Automatic start

When a character becomes ready:

1. resolve player GUID;
2. load/create that character's session container;
3. inspect `current.lastSeenAt`;
4. either resume the existing session or archive it and start a new one.

### 6.2 Offline timeout

Default: 60 minutes, configurable with a positive integer number of minutes.

If:

```text
now - lastSeenAt <= offlineTimeout
```

resume the current session.

If:

```text
now - lastSeenAt > offlineTimeout
```

archive the previous session if meaningful, then start a new one.

Offline time never contributes to tracked or active time.

### 6.3 Reload/relog resume

A reload or short relog within the timeout resumes the same logical session.

On resume, XP and money are re-baselined from live APIs before further deltas are accepted. Changes that happened while the addon was not active are not retroactively attributed to the session.

### 6.4 Manual pause/resume

Pause:

- stops tracked time;
- stops active time;
- ignores XP and money deltas for accounting;
- keeps the current session open.

Resume:

- reads fresh XP/level/XP-max/money baselines;
- resets timing checkpoint state to now;
- resumes accounting without backfilling paused changes.

### 6.5 Manual reset

Reset requires confirmation in the detailed UI.

A confirmed reset:

1. finalizes current timers;
2. archives the session if meaningful;
3. starts a fresh session immediately.

Reset does not delete prior history.

### 6.6 Crash/Alt+F4 tolerance

Do not rely exclusively on `PLAYER_LOGOUT`.

While running, update `lastSeenAt` through a lightweight periodic checkpoint, approximately every 30 seconds. The next login uses that persisted timestamp for timeout decisions.

## 7. Time semantics

Three concepts exist, but only two need prominent UI display.

### 7.1 Wall lifetime

Internal concept from `startedAt` to now. It is used for timestamps and resume/timeout reasoning. It may include offline gaps.

### 7.2 Tracked time

`trackedSeconds` counts only time when:

- the character is online;
- the tracker is initialized;
- the session is not manually paused.

The UI label **Session** / **Session time** displays tracked time. Offline time and manual pause are excluded.

### 7.3 Active time

`activeSeconds` is tracked time capped by the inactivity rule.

Default inactivity timeout: 5 minutes, configurable with a positive integer number of minutes.

XP gain or money change counts as activity. If no XP or money activity occurs beyond the timeout, further elapsed time is not added to active time until a new activity event occurs.

Rate calculations use active time, not tracked time or wall lifetime.

### 7.4 Checkpoint calculation

At each timing checkpoint, let:

- `from` = previous checkpoint timestamp;
- `to` = current timestamp;
- `activeUntil` = `lastActivityAt + inactivityTimeout`.

When running and not paused:

```text
trackedDelta = to - from
activeDelta = max(0, min(to, activeUntil) - from)
```

If the active window ended before `from`, `activeDelta` is zero.

On reload/relog/resume, `checkpointAt` is reset to now so offline/paused gaps cannot leak into tracked or active time.

## 8. XP accounting

Use the player's authoritative XP APIs:

- `UnitLevel("player")`;
- `UnitXP("player")`;
- `UnitXPMax("player")`.

Relevant events should include the normal player XP update and level-up paths available in the Forever client. The tracker must be resilient to event ordering and always reconcile against current API values.

### 8.1 Normal XP gain

For the same level:

```text
delta = newXP - previousXP
```

Only a positive, plausible delta is accumulated. A negative same-level delta is treated as a re-baseline condition, not negative XP gained.

### 8.2 Level-up

For a one-level transition:

```text
gain = (previousXPMax - previousXP) + newXP
```

Example:

```text
Level 23: 48,000 / 50,000
Level 24:  1,200 / 54,000

gain = 2,000 + 1,200 = 3,200 XP
```

The implementation must not assume that the level-up event arrives before or after the XP update event. Level, current XP, and XP max are reconciled together.

If a transition cannot be reconciled safely, re-baseline rather than invent XP.

### 8.3 XP/hour

```text
XP/hr = gainedXP / activeSeconds * 3600
```

When active time is zero or insufficient to produce a valid rate, display `--`.

### 8.4 Time to level

```text
remainingXP = currentXPMax - currentXP
ETA = remainingXP / currentXPPerSecond
```

Display `--` when no meaningful positive XP rate exists.

At max level or when the client exposes no usable next-level XP requirement, display a max-level state rather than an ETA.

## 9. Gold accounting

`GetMoney()` is the source of truth. Store all values in integer copper.

For every accepted money update:

```text
delta = currentMoney - previousMoney

delta > 0 -> earned += delta
delta < 0 -> spent += abs(delta)

net = earned - spent
```

V1 deliberately does not infer why money changed.

Examples that therefore count only by sign:

- loot/vendor sale/quest reward/mail/AH payout -> earned;
- repair/vendor purchase/trade payment/AH deposit -> spent.

If no valid previous baseline exists, the first valid `GetMoney()` value establishes the baseline and records no transaction.

### 9.1 Gold rates

```text
earned/hr = earned / activeSeconds * 3600
spent/hr  = spent  / activeSeconds * 3600
net/hr    = net    / activeSeconds * 3600
```

All calculations stay in copper until formatting.

## 10. History

Keep up to 30 completed sessions per character.

A session is meaningful if at least one of the following is true:

- tracked time >= 60 seconds;
- XP gained > 0;
- gold earned > 0;
- gold spent > 0.

A session shorter than 60 seconds with no XP or gold activity is discarded instead of polluting history.

When adding session 31, evict the oldest retained session.

Each archived record should contain enough normalized data to render history without depending on mutable current state, including:

- session id;
- started/ended timestamps;
- tracked duration;
- active duration;
- start level;
- end level;
- XP gained;
- XP/hour at close;
- gold earned;
- gold spent;
- net gold;
- earned/hour;
- spent/hour;
- net/hour.

## 11. Tracker public interface

The UI should consume stable tracker methods rather than raw SavedVariables.

Expected interface shape:

```lua
FDB:GetSessionSnapshot()
FDB:GetSessionHistory()
FDB:PauseSession()
FDB:ResumeSession()
FDB:ResetSession()
FDB:SetSessionOfflineTimeout(minutes)
FDB:SetSessionInactivityTimeout(minutes)
FDB:SetSessionHUDShown(shown)
FDB:SetSessionHUDLocked(locked)
```

Exact internal names may vary during implementation, but the architectural rule is fixed: UI reads normalized state and invokes tracker commands; it does not mutate persisted accounting fields directly.

## 12. Compact HUD

Visual target: the approved first ForeverDB Session mockup — dark WoW-native panel with restrained gold/bronze framing, compact rows, and no faction-specific branding.

Default content:

```text
ForeverDB Session
--------------------------------
XP/hr        28.4k   To level 01:14
Gold/hr      7g 42s  Net/hr   +5g 58s
Active       00:37
--------------------------------
Running/Idle/Paused   Character
```

Behavior:

- movable while unlocked;
- lockable;
- show/hide toggle;
- position persists per character;
- closing/hiding the HUD does not pause the tracker;
- clear RUNNING, IDLE, and PAUSED states;
- values refresh without re-running accounting logic in the UI.

Use existing WoW frame textures, fonts, and icons where practical. Avoid shipping unnecessary new art assets. Branding must be ForeverDB-neutral, not Alliance/Horde specific.

## 13. Detailed Session window

Open/toggle with:

```text
/fdb session
```

The approved layout contains:

### KPI row

- XP/hr;
- XP gained;
- To level;
- Gold earned;
- Gold spent;
- Net gold.

### Session Timing

- Session time (tracked time);
- Active time;
- Status;
- Started timestamp.

### Character

- level;
- current XP / XP max;
- XP progress bar;
- current carried gold.

### Rates

- Earned/hr;
- Spent/hr;
- Net/hr.

### Recent Sessions

Scrollable history from the retained 30 sessions with columns such as:

- date/time;
- duration;
- active;
- start -> end level;
- XP gained;
- XP/hr;
- earned;
- spent;
- net.

### Controls

- Pause;
- Resume;
- Reset;
- Lock HUD;
- Hide/Show HUD.

Positive net values use positive/green emphasis; negative net values use negative/red emphasis. XP and gold values use consistent class-neutral colors.

## 14. Slash commands

Required commands:

```text
/fdb session
/fdb session pause
/fdb session resume
/fdb session reset
/fdb session hud
/fdb session lock
/fdb session timeout <minutes>
/fdb session idle <minutes>
```

Rules:

- timeout and idle accept positive integer minutes;
- invalid values print concise usage and keep the previous setting;
- `hud` toggles visibility;
- `lock` toggles HUD movement lock;
- command actions must call the same tracker/UI APIs used by buttons.

## 15. Error handling and safety

### XP

Handle without corrupting totals:

- missing/temporary invalid XP APIs;
- normal XP updates;
- level-up XP wrap;
- uncertain event ordering;
- same-level XP reset/decrease;
- max level;
- reload during/near level-up;
- paused XP gain.

If a delta is ambiguous, re-baseline rather than fabricate XP.

### Gold

Handle:

- multiple money updates in quick succession;
- missing initial baseline;
- reload/relog;
- pause/resume;
- reset.

The system records deltas only after a valid baseline exists.

### Character identity

Never persist a character under a nil/empty GUID. Defer initialization until identity is valid.

### Corrupt/missing session state

Treat absent or malformed optional fields defensively:

- restore defaults where safe;
- do not erase observation/guild data;
- prefer starting a clean session over propagating impossible accounting state.

## 16. Automated testing

Add a dedicated simulated WoW test harness, expected at:

```text
tests/session_tracker_smoke.lua
```

Required cases:

1. normal XP gain;
2. XP/hour calculation;
3. level-up XP wrap;
4. max-level behavior;
5. gold earned;
6. gold spent;
7. net gold;
8. earned/hour and net/hour;
9. 5-minute inactivity cutoff;
10. configurable inactivity timeout;
11. manual pause;
12. resume re-baseline;
13. reload-style session resume;
14. offline gap within 60 minutes resumes;
15. offline gap over 60 minutes archives and starts new;
16. configurable offline timeout;
17. history retention capped at 30;
18. per-character isolation;
19. short empty-session discard;
20. missing GUID/XP/money APIs fail safely;
21. paused XP/money changes do not backfill on resume;
22. offline time does not enter tracked or active time.

The test should load real addon tracker code under simulated WoW APIs rather than duplicating the production logic in the test.

## 17. CI

Extend the Lua CI coverage so pull requests and main validate:

```text
lua5.4 tests/session_tracker_smoke.lua
luac5.4 -p addon/ForeverDB/SessionTracker.lua
luac5.4 -p addon/ForeverDB/SessionUI.lua
```

Existing collector smoke and addon compile checks remain intact.

Repo-side smoke success is not equivalent to live WoW acceptance.

## 18. Live Forever acceptance

Do not mark the feature runtime-accepted until a real Forever client confirms the following.

### HUD

- appears correctly;
- can be dragged;
- lock prevents dragging;
- hide/show works;
- position survives reload;
- values refresh;
- RUNNING / IDLE / PAUSED transitions are correct.

### Detailed window

- `/fdb session` opens/closes it;
- KPIs match live state;
- XP progress updates;
- history scroll works;
- Pause/Resume works;
- Reset requires confirmation and starts a new session;
- positive/negative net formatting is correct.

### Accounting flow

- kill/grant XP -> XP gained increases;
- loot or other positive money delta -> earned increases;
- purchase/repair or other negative money delta -> spent increases;
- level-up -> XP gained remains correct across wrap;
- `/reload` -> same session continues;
- short relog -> same session continues;
- offline longer than configured timeout -> new session;
- 5+ minutes without XP or money activity -> active time stops growing after the timeout;
- first XP/money activity after idle -> active timing resumes.

## 19. Roadmap completion rule

Implementation can be called repo-complete after:

- tracker and UI are implemented;
- automated session smoke tests pass;
- addon Lua compile checks pass;
- version/changelog/roadmap documentation is updated.

The Session Tracker E2E/runtime item remains open until the live Forever acceptance above is recorded.

## 20. Future extension points

The design intentionally leaves clean seams for later work:

- export current/history records to the Companion;
- account-wide Companion aggregation;
- gold-source categories;
- rolling-window rates;
- per-zone/per-source farming profitability;
- richer historical charts.

Those extensions must not be pulled into V1 unless separately designed.
