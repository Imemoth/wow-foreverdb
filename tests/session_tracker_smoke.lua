-- Run from the repository root: lua5.4 tests/session_tracker_smoke.lua
-- Simulated WoW APIs; this is NOT live Forever client acceptance.
local consolePrint = print
local passed = 0

local function equal(actual, expected, label)
    if actual ~= expected then
        error((label or "value") .. ": " .. tostring(actual) .. " ~= " .. tostring(expected))
    end
end

local function truthy(value, label)
    if not value then
        error((label or "value") .. " expected truthy, got " .. tostring(value))
    end
end

local function falsy(value, label)
    if value then
        error((label or "value") .. " expected falsy, got " .. tostring(value))
    end
end

-- Build a fresh simulated WoW environment plus a freshly loaded FDB module set.
local function setup()
    local state = {
        now = 1000,
        guid = "Player-1-000001",
        name = "Vesperix",
        realm = "TestRealm",
        level = 20,
        xp = 1000,
        xpMax = 10000,
        money = 5000,
        frames = {},
        tickers = {},
    }

    local FDB = {}

    GetServerTime = function() return state.now end
    GetTime = function() return state.now end
    time = function() return state.now end

    UnitGUID = function(unit)
        if unit == "player" then return state.guid end
        return nil
    end
    UnitName = function(unit)
        if unit == "player" then return state.name end
        return nil
    end
    GetRealmName = function() return state.realm end
    UnitLevel = function(unit)
        if unit == "player" then return state.level end
        return nil
    end
    UnitXP = function(unit)
        if unit == "player" then return state.xp end
        return nil
    end
    UnitXPMax = function(unit)
        if unit == "player" then return state.xpMax end
        return nil
    end
    GetMoney = function() return state.money end

    CreateFrame = function()
        local frame = { events = {} }
        function frame:RegisterEvent(event) self.events[event] = true end
        function frame:UnregisterEvent(event) self.events[event] = nil end
        function frame:SetScript(_, handler) self.handler = handler end
        state.frames[#state.frames + 1] = frame
        return frame
    end

    function state:event(event, ...)
        for _, frame in ipairs(self.frames) do
            if frame.events[event] then frame.handler(frame, event, ...) end
        end
    end

    C_Timer = {
        NewTicker = function(interval, callback)
            local ticker = { interval = interval, callback = callback }
            state.tickers[#state.tickers + 1] = ticker
            return ticker
        end,
        After = function() end,
    }

    function state:fireTickers()
        for _, ticker in ipairs(self.tickers) do
            ticker.callback()
        end
    end

    ForeverDB_Saved = nil
    ForeverDB_Export = nil

    assert(loadfile("addon/ForeverDB/Core.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/Database.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/Exporter.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/SessionTracker.lua"))("ForeverDB", FDB)

    FDB:InitializeDatabase()

    return FDB, state
end

local function test(name, run)
    local ok, err = pcall(run)
    if not ok then error(name .. ": " .. tostring(err)) end
    passed = passed + 1
    consolePrint("PASS (simulated): " .. name)
end

test("starts a session for a valid GUID with exact defaults", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    local settings = FDB:GetSessionSettings()
    equal(settings.offlineTimeout, 3600)
    equal(settings.inactivityTimeout, 300)
    equal(settings.historyLimit, 30)

    local char = FDB.DB.sessions.characters[state.guid]
    truthy(char)
    equal(char.name, state.name)
    equal(char.realm, state.realm)
    equal(char.current.startedAt, state.now)
    equal(char.current.trackedSeconds, 0)
    equal(char.current.activeSeconds, 0)
    falsy(char.current.paused)
    equal(char.current.xp.startLevel, state.level)
    equal(char.current.xp.startXP, state.xp)
    equal(char.current.gold.startCopper, state.money)
    equal(char.current.gold.lastCopper, state.money)
end)

test("missing GUID defers initialization and never creates a nil character key", function()
    local FDB, state = setup()
    state.guid = nil
    falsy(FDB:SessionPlayerReady())

    local count = 0
    for _ in pairs(FDB.DB.sessions.characters) do count = count + 1 end
    equal(count, 0)
    falsy(FDB.SessionState)
end)

test("PLAYER_ENTERING_WORLD retries a player GUID that was unavailable at login", function()
    local FDB, state = setup()
    state.guid = nil
    FDB:InitializeSessionTracker()
    falsy(FDB:SessionPlayerReady())

    state.guid = "Player-1-000099"
    state:event("PLAYER_ENTERING_WORLD")

    truthy(FDB.SessionState)
    equal(FDB.SessionState.guid, state.guid)
    truthy(FDB.DB.sessions.characters[state.guid])
end)

test("offline gap within 60 minutes resumes and re-baselines without counting the gap", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local originalStartedAt = state.now

    state.now = state.now + 100
    FDB:CheckpointSession(state.now)
    equal(FDB.DB.sessions.characters[state.guid].current.trackedSeconds, 100)

    FDB:SessionBeforeLogout()
    equal(FDB.DB.sessions.characters[state.guid].current.lastSeenAt, state.now)

    state.now = state.now + 1800 -- 30 minutes offline, within 60 minute timeout
    state.level = 21
    state.xp = 500
    state.money = 6000
    FDB.SessionState = nil -- simulate a fresh Lua state after reload/relog

    truthy(FDB:SessionPlayerReady())

    local char = FDB.DB.sessions.characters[state.guid]
    equal(char.current.startedAt, originalStartedAt)
    equal(char.current.trackedSeconds, 100) -- offline gap excluded
    equal(char.current.checkpointAt, state.now)
    equal(char.current.lastActivityAt, state.now)
    equal(char.current.xp.lastLevel, 21)
    equal(char.current.xp.lastXP, 500)
    equal(char.current.gold.lastCopper, 6000)
    equal(#char.history, 0)
end)

test("offline gap over 60 minutes archives and starts a new session", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    state.now = state.now + 120
    state.xp = state.xp + 50
    state:event("PLAYER_XP_UPDATE")
    FDB:SessionBeforeLogout()

    local oldId = FDB.DB.sessions.characters[state.guid].current.id

    state.now = state.now + 3601 -- just over the 3600s default offline timeout
    FDB.SessionState = nil
    truthy(FDB:SessionPlayerReady())

    local char = FDB.DB.sessions.characters[state.guid]
    equal(#char.history, 1)
    equal(char.history[1].id, oldId)
    equal(char.history[1].xpGained, 50)
    truthy(char.current.id ~= oldId)
    equal(char.current.startedAt, state.now)
    equal(char.current.trackedSeconds, 0)
    equal(char.current.activeSeconds, 0)
end)

test("pause/resume excludes paused time and re-baselines XP/money", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 50
    truthy(FDB:PauseSession())
    equal(char.current.trackedSeconds, 50)
    truthy(char.current.paused)

    state.now = state.now + 500
    state.xp = state.xp + 999
    state.money = state.money + 999
    state:event("PLAYER_XP_UPDATE")
    state:event("PLAYER_MONEY")

    equal(char.current.trackedSeconds, 50)
    equal(char.current.xp.gained, 0)
    equal(char.current.gold.earned, 0)

    truthy(FDB:ResumeSession())
    falsy(char.current.paused)
    equal(char.current.trackedSeconds, 50)
    equal(char.current.xp.lastXP, state.xp)
    equal(char.current.gold.lastCopper, state.money)

    state.now = state.now + 10
    state.xp = state.xp + 20
    state:event("PLAYER_XP_UPDATE")
    equal(char.current.xp.gained, 20)
end)

test("five-minute inactivity caps active time", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 200
    state.xp = state.xp + 10
    state:event("PLAYER_XP_UPDATE") -- activity at +200

    state.now = state.now + 1000
    FDB:CheckpointSession(state.now)

    equal(char.current.trackedSeconds, 1200)
    equal(char.current.activeSeconds, 500) -- 200 (to activity) + 300 (inactivity window)
end)

test("configurable inactivity timeout changes the active-time cap", function()
    local FDB, state = setup()
    truthy(FDB:SetSessionInactivityTimeout(10)) -- 600 seconds
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 200
    state.xp = state.xp + 1
    state:event("PLAYER_XP_UPDATE")

    state.now = state.now + 1000
    FDB:CheckpointSession(state.now)

    equal(char.current.trackedSeconds, 1200)
    equal(char.current.activeSeconds, 800) -- 200 + 600
end)

test("new activity after idle does not backfill the idle gap", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 1000 -- long idle, no activity
    state.xp = state.xp + 5
    state:event("PLAYER_XP_UPDATE")

    equal(char.current.trackedSeconds, 1000)
    equal(char.current.activeSeconds, 300) -- only the original inactivity window counts
    equal(char.current.lastActivityAt, state.now)
end)

test("configurable offline and inactivity timeouts validate positive integer minutes", function()
    local FDB = setup()

    truthy(FDB:SetSessionOfflineTimeout(90))
    equal(FDB:GetSessionSettings().offlineTimeout, 5400)

    local ok1 = FDB:SetSessionOfflineTimeout(0)
    falsy(ok1)
    equal(FDB:GetSessionSettings().offlineTimeout, 5400)

    local ok2 = FDB:SetSessionOfflineTimeout(1.5)
    falsy(ok2)
    equal(FDB:GetSessionSettings().offlineTimeout, 5400)

    local ok3 = FDB:SetSessionOfflineTimeout(-5)
    falsy(ok3)
    equal(FDB:GetSessionSettings().offlineTimeout, 5400)

    truthy(FDB:SetSessionInactivityTimeout(10))
    equal(FDB:GetSessionSettings().inactivityTimeout, 600)

    local ok4 = FDB:SetSessionInactivityTimeout(0)
    falsy(ok4)
    equal(FDB:GetSessionSettings().inactivityTimeout, 600)
end)

test("malformed optional session state recovers without changing sources maps or guilds", function()
    local FDB = setup()
    FDB.DB.sources = { keep = "yes" }
    FDB.DB.maps = { keep = "yes" }
    FDB.DB.guilds = { keep = "yes" }
    FDB.DB.sessions = "not-a-table"

    local sessions = FDB:GetSessionsRoot()
    truthy(type(sessions) == "table")
    equal(sessions.settings.offlineTimeout, 3600)
    equal(sessions.settings.inactivityTimeout, 300)
    equal(sessions.settings.historyLimit, 30)
    equal(FDB.DB.sources.keep, "yes")
    equal(FDB.DB.maps.keep, "yes")
    equal(FDB.DB.guilds.keep, "yes")

    FDB.DB.sessions.settings = "broken"
    FDB.DB.sessions.characters = 42
    local sessions2 = FDB:GetSessionsRoot()
    equal(sessions2.settings.offlineTimeout, 3600)
    truthy(type(sessions2.characters) == "table")
    equal(FDB.DB.sources.keep, "yes")
end)

test("short empty session is discarded", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 10 -- under 60s, no XP/gold activity
    truthy(FDB:ResetSession())
    equal(#char.history, 0)
end)

test("history retains only the latest 30 completed sessions", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    for _ = 1, 35 do
        state.now = state.now + 61
        state.xp = state.xp + 1
        state:event("PLAYER_XP_UPDATE")
        truthy(FDB:ResetSession())
    end

    equal(#char.history, 30)
end)

test("two character GUIDs keep isolated current/history state", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local charA = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 70
    state.xp = state.xp + 5
    state:event("PLAYER_XP_UPDATE")
    truthy(FDB:ResetSession())

    FDB.SessionState = nil
    state.guid = "Player-1-000002"
    state.level = 5
    state.xp = 100
    state.xpMax = 2000
    state.money = 0
    truthy(FDB:SessionPlayerReady())
    local charB = FDB.DB.sessions.characters[state.guid]

    equal(#charA.history, 1)
    equal(#charB.history, 0)
    truthy(charA ~= charB)
    equal(charB.current.xp.startLevel, 5)
    equal(charB.current.gold.startCopper, 0)
end)

-- Task 2: XP accounting, level-up reconciliation, XP/hour, ETA ------------

test("normal same-level XP gain increments once and marks activity", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 30
    state.xp = state.xp + 400
    state:event("PLAYER_XP_UPDATE")

    equal(char.current.xp.gained, 400)
    equal(char.current.lastActivityAt, state.now)
end)

test("XP/hour uses active seconds", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 1800 -- 30 minutes, fully active (well within inactivity window)
    state.xp = state.xp + 900
    state:event("PLAYER_XP_UPDATE")

    local snapshot = FDB:GetSessionSnapshot()
    -- activeSeconds is capped by the inactivity window (300s) from start,
    -- since the only activity happened at +1800s: active = 300s.
    equal(snapshot.activeSeconds, 300)
    equal(snapshot.xpGained, 900)
    equal(snapshot.xpPerHour, 900 / 300 * 3600)
end)

test("level-up XP wrap uses previous max minus previous XP plus new XP", function()
    local FDB, state = setup()
    state.level = 23
    state.xp = 48000
    state.xpMax = 50000
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 10
    state.level = 24
    state.xp = 1200
    state.xpMax = 54000
    state:event("PLAYER_LEVEL_UP", 24)
    state:event("PLAYER_XP_UPDATE")

    equal(char.current.xp.gained, 3200)
    equal(char.current.xp.lastLevel, 24)
    equal(char.current.xp.lastXP, 1200)
    equal(char.current.xp.lastXPMax, 54000)
end)

test("level-up event before XP event does not double-count", function()
    local FDB, state = setup()
    state.level = 23
    state.xp = 48000
    state.xpMax = 50000
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.level = 24
    state.xp = 1200
    state.xpMax = 54000
    state:event("PLAYER_LEVEL_UP", 24) -- level-up arrives first
    state:event("PLAYER_XP_UPDATE")    -- xp update arrives second, no new delta

    equal(char.current.xp.gained, 3200)
end)

test("XP event before level-up event does not double-count", function()
    local FDB, state = setup()
    state.level = 23
    state.xp = 48000
    state.xpMax = 50000
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.level = 24
    state.xp = 1200
    state.xpMax = 54000
    state:event("PLAYER_XP_UPDATE")    -- xp update arrives first
    state:event("PLAYER_LEVEL_UP", 24) -- level-up arrives second, no new delta

    equal(char.current.xp.gained, 3200)
end)

test("duplicate XP events with unchanged state add zero", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state:event("PLAYER_XP_UPDATE")
    state:event("PLAYER_XP_UPDATE")
    state:event("PLAYER_XP_UPDATE")

    equal(char.current.xp.gained, 0)
end)

test("same-level XP decrease re-baselines instead of subtracting gained XP", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.xp = state.xp + 200
    state:event("PLAYER_XP_UPDATE")
    equal(char.current.xp.gained, 200)

    -- Same-level XP decrease (e.g. addon reload race / dev reset) must not
    -- subtract from gained XP; it only re-baselines the tracked value.
    state.xp = state.xp - 500
    state:event("PLAYER_XP_UPDATE")

    equal(char.current.xp.gained, 200)
    equal(char.current.xp.lastXP, state.xp)
end)

test("max-level or unusable XP max returns no ETA", function()
    local FDB, state = setup()
    state.xpMax = 0 -- Forever client convention for max level
    truthy(FDB:SessionPlayerReady())

    local snapshot = FDB:GetSessionSnapshot()
    truthy(snapshot.isMaxLevel)
    equal(snapshot.etaSeconds, nil)
end)

test("missing XP APIs fail safely and preserve prior totals", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.xp = state.xp + 100
    state:event("PLAYER_XP_UPDATE")
    equal(char.current.xp.gained, 100)

    local realUnitXP = UnitXP
    UnitXP = function() return nil end
    state:event("PLAYER_XP_UPDATE")
    UnitXP = realUnitXP

    equal(char.current.xp.gained, 100)
    equal(char.current.xp.lastXP, state.xp)
end)

test("paused XP gained is not backfilled after resume", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    truthy(FDB:PauseSession())
    state.xp = state.xp + 5000
    state:event("PLAYER_XP_UPDATE")
    equal(char.current.xp.gained, 0)

    truthy(FDB:ResumeSession())
    equal(char.current.xp.gained, 0)
    equal(char.current.xp.lastXP, state.xp)

    state.xp = state.xp + 10
    state:event("PLAYER_XP_UPDATE")
    equal(char.current.xp.gained, 10)
end)

-- Task 3: gold accounting, rates, snapshot, export isolation --------------

test("positive money delta increments earned in integer copper", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.money = state.money + 1234
    state:event("PLAYER_MONEY")

    equal(char.current.gold.earned, 1234)
    equal(char.current.gold.spent, 0)
    equal(char.current.gold.lastCopper, state.money)
end)

test("negative money delta increments spent and net equals earned minus spent", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.money = state.money + 500
    state:event("PLAYER_MONEY")
    state.money = state.money - 200
    state:event("PLAYER_MONEY")

    equal(char.current.gold.earned, 500)
    equal(char.current.gold.spent, 200)

    local snapshot = FDB:GetSessionSnapshot()
    equal(snapshot.netGold, 300)
end)

test("unchanged duplicate money notification records zero", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state:event("PLAYER_MONEY")
    state:event("PLAYER_MONEY")

    equal(char.current.gold.earned, 0)
    equal(char.current.gold.spent, 0)
end)

test("rapid sequential money notifications record each signed delta exactly once", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.money = state.money + 100
    state:event("PLAYER_MONEY")
    state.money = state.money + 50
    state:event("PLAYER_MONEY")
    state.money = state.money - 30
    state:event("PLAYER_MONEY")

    equal(char.current.gold.earned, 150)
    equal(char.current.gold.spent, 30)
end)

test("missing first money baseline only establishes baseline", function()
    local FDB, state = setup()
    state.money = nil
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]
    equal(char.current.gold.lastCopper, nil)

    state.money = 777
    state:event("PLAYER_MONEY")

    equal(char.current.gold.earned, 0)
    equal(char.current.gold.spent, 0)
    equal(char.current.gold.lastCopper, 777)
end)

test("paused money changes are not backfilled after resume", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    truthy(FDB:PauseSession())
    state.money = state.money + 9999
    state:event("PLAYER_MONEY")
    equal(char.current.gold.earned, 0)

    truthy(FDB:ResumeSession())
    equal(char.current.gold.earned, 0)
    equal(char.current.gold.lastCopper, state.money)

    state.money = state.money + 25
    state:event("PLAYER_MONEY")
    equal(char.current.gold.earned, 25)
end)

test("earned spent and net per hour use active time, not tracked time", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    -- A long idle gap before any activity, deliberately making
    -- activeSeconds and trackedSeconds diverge: a regression that computed
    -- these rates from trackedSeconds instead of activeSeconds must fail
    -- this test (it would not have with a scenario where the two happen
    -- to be equal).
    state.now = state.now + 1800
    state.money = state.money + 200
    state:event("PLAYER_MONEY") -- activity at +1800; active window capped at 300s from start

    state.now = state.now + 50
    state.money = state.money - 50
    state:event("PLAYER_MONEY") -- activity at +1850, within the new 300s window

    local snapshot = FDB:GetSessionSnapshot()
    equal(snapshot.trackedSeconds, 1850)
    equal(snapshot.activeSeconds, 350)
    equal(snapshot.earnedPerHour, 200 / 350 * 3600)
    equal(snapshot.spentPerHour, 50 / 350 * 3600)
    equal(snapshot.netPerHour, 150 / 350 * 3600)
end)

test("status precedence is PAUSED then IDLE then RUNNING", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    equal(FDB:GetSessionSnapshot().status, "RUNNING")

    state.now = state.now + 400 -- exceeds default 300s inactivity timeout
    equal(FDB:GetSessionSnapshot().status, "IDLE")

    truthy(FDB:PauseSession())
    equal(FDB:GetSessionSnapshot().status, "PAUSED")
end)

test("history snapshot records close-time XP and gold rates", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 120
    state.xp = state.xp + 60
    state.money = state.money + 120
    state:event("PLAYER_XP_UPDATE")
    state:event("PLAYER_MONEY")

    truthy(FDB:ResetSession())

    local history = FDB:GetSessionHistory()
    equal(#history, 1)
    local record = history[1]
    equal(record.xpGained, 60)
    equal(record.goldEarned, 120)
    equal(record.netGold, 120)
    truthy(record.xpPerHour ~= nil)
    truthy(record.earnedPerHour ~= nil)
    truthy(record.netPerHour ~= nil)

    -- History rows must be copies, not live references into persisted state.
    record.xpGained = 999999
    equal(char.history[1].xpGained, 60)
end)

test("session SavedVariables stay local and schema 9 export has no session records", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    state.now = state.now + 90
    state.xp = state.xp + 40
    state:event("PLAYER_XP_UPDATE")
    truthy(FDB:ResetSession()) -- archive one session into history too

    equal(FDB.SCHEMA_VERSION, 9)
    truthy(FDB.DB.sessions)
    local char = FDB.DB.sessions.characters[state.guid]
    truthy(char)
    equal(#char.history, 1)

    local export = FDB:BuildExportSnapshot()
    truthy(export:match("^H|9|"))
    falsy(export:find("session", 1, true))
    falsy(export:find(char.history[1].id, 1, true))
    falsy(export:find(char.current.id, 1, true))
end)

-- Reviewer A findings: crash-safety on corrupted leaf fields, and a
-- content-based (not count-only) history eviction assertion. ------------

test("a wrong-typed current.startedAt does not crash and rebuilds a clean session", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    -- Simulate hand-edited/corrupted SavedVariables: a non-numeric leaf
    -- field on an otherwise well-formed `current` table.
    FDB.DB.sessions.characters[state.guid].current.startedAt = "corrupted-string"
    FDB.SessionState = nil

    local ok, result = pcall(function() return FDB:SessionPlayerReady() end)
    truthy(ok, "SessionPlayerReady must not error on corrupted state: " .. tostring(result))
    truthy(result)

    local char = FDB.DB.sessions.characters[state.guid]
    truthy(type(char.current.startedAt) == "number")
    truthy(char.current.startedAt > 0)
    equal(char.current.trackedSeconds, 0)
end)

test("a wrong-typed current.xp.gained does not crash and rebuilds a clean session", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    -- current.xp itself is a well-formed table, but one inner leaf is
    -- corrupted -- a narrower/subtler case than the whole-current
    -- corruption above.
    FDB.DB.sessions.characters[state.guid].current.xp.gained = "corrupted"
    FDB.SessionState = nil

    local ok, result = pcall(function() return FDB:SessionPlayerReady() end)
    truthy(ok, "SessionPlayerReady must not error on corrupted xp.gained: " .. tostring(result))
    truthy(result)

    local char = FDB.DB.sessions.characters[state.guid]
    truthy(type(char.current.xp.gained) == "number")

    state.xp = state.xp + 5
    local ok2, err2 = pcall(function() state:event("PLAYER_XP_UPDATE") end)
    truthy(ok2, "delivering an XP event after recovery must not crash: " .. tostring(err2))
    equal(char.current.xp.gained, 5)
end)

test("a wrong-typed current.gold.earned does not crash when checked for offline archival on login", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    local char = FDB.DB.sessions.characters[state.guid]
    char.current.trackedSeconds = 500 -- would be "meaningful" if left uncorrupted
    char.current.gold.earned = "corrupted"
    char.current.lastSeenAt = state.now
    FDB.SessionState = nil

    state.now = state.now + 3601 -- beyond the default 3600s offline timeout,
                                  -- forcing the archive-on-login path that
                                  -- reads gold.earned to decide meaningfulness

    local ok, result = pcall(function() return FDB:SessionPlayerReady() end)
    truthy(ok, "SessionPlayerReady must not error on corrupted gold.earned: " .. tostring(result))
    truthy(result)

    local newChar = FDB.DB.sessions.characters[state.guid]
    truthy(type(newChar.current.gold.earned) == "number")
    equal(newChar.current.startedAt, state.now)
end)

test("history eviction discards the oldest sessions, not the newest", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    for i = 1, 35 do
        state.now = state.now + 61
        state.xp = state.xp + i -- distinct per-session xpGained tags the record
        state:event("PLAYER_XP_UPDATE")
        truthy(FDB:ResetSession())
    end

    equal(#char.history, 30)
    -- Sessions tagged 1-5 must be evicted as oldest; 6-35 must survive,
    -- oldest-to-newest. A reversed eviction (dropping newest) would leave
    -- history[1]==1 and history[30]==30 instead.
    equal(char.history[1].xpGained, 6)
    equal(char.history[30].xpGained, 35)
end)

test("offline gap exactly at the timeout boundary resumes, not archives", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local originalStartedAt = state.now

    FDB:SessionBeforeLogout()
    state.now = state.now + 3600 -- exactly the default 3600s offline timeout
    FDB.SessionState = nil
    truthy(FDB:SessionPlayerReady())

    local char = FDB.DB.sessions.characters[state.guid]
    equal(char.current.startedAt, originalStartedAt) -- resumed, not archived
    equal(#char.history, 0)
end)

test("tracked time exactly 60 seconds is meaningful and is retained", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 60 -- exactly the meaningful-session threshold
    truthy(FDB:ResetSession())

    equal(#char.history, 1)
    equal(char.history[1].trackedSeconds, 60)
end)

test("the periodic checkpoint ticker updates timing and lastSeenAt", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    equal(#state.tickers, 1)
    equal(state.tickers[1].interval, 30)

    state.now = state.now + 30
    state:fireTickers()

    equal(char.current.trackedSeconds, 30)
    equal(char.current.lastSeenAt, state.now)
end)

test("a transient missing money API fails safely and preserves prior totals", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.money = state.money + 100
    state:event("PLAYER_MONEY")
    equal(char.current.gold.earned, 100)

    local realGetMoney = GetMoney
    GetMoney = function() return nil end
    state:event("PLAYER_MONEY")
    GetMoney = realGetMoney

    equal(char.current.gold.earned, 100)
    equal(char.current.gold.lastCopper, state.money)
end)

test("HUD shown/locked/position settings default and persist per character", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    local defaults = FDB:GetSessionHUDSettings()
    truthy(defaults.hudShown)
    falsy(defaults.hudLocked)
    equal(defaults.hudPoint, "TOPLEFT")
    equal(defaults.hudRelativePoint, "TOPLEFT")
    equal(defaults.hudX, 100)
    equal(defaults.hudY, -100)

    truthy(FDB:SetSessionHUDShown(false))
    truthy(FDB:SetSessionHUDLocked(true))
    truthy(FDB:SetSessionHUDPosition("BOTTOMRIGHT", "CENTER", 42, -17))

    local settings = FDB:GetSessionHUDSettings()
    falsy(settings.hudShown)
    truthy(settings.hudLocked)
    equal(settings.hudPoint, "BOTTOMRIGHT")
    equal(settings.hudRelativePoint, "CENTER")
    equal(settings.hudX, 42)
    equal(settings.hudY, -17)
end)

test("invalid HUD position data normalizes to safe defaults", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    char.ui = { hudPoint = 42, hudRelativePoint = false, hudX = "left", hudY = nil }
    local settings = FDB:GetSessionHUDSettings()

    equal(settings.hudPoint, "TOPLEFT")
    equal(settings.hudRelativePoint, "TOPLEFT")
    equal(settings.hudX, 100)
    equal(settings.hudY, -100)

    -- A well-typed position update must not be discarded by a subsequent
    -- normalize pass, and out-of-type arguments must be ignored rather
    -- than corrupting the stored value.
    truthy(FDB:SetSessionHUDPosition("BOTTOMRIGHT", "CENTER", 5, 6))
    truthy(FDB:SetSessionHUDPosition(nil, nil, "bad", nil))
    local after = FDB:GetSessionHUDSettings()
    equal(after.hudPoint, "BOTTOMRIGHT")
    equal(after.hudRelativePoint, "CENTER")
    equal(after.hudX, 5)
    equal(after.hudY, 6)
end)

-- External review round 2: corrupted character records and history --------

test("a non-table character record (string) recovers into a fresh valid character", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB.SessionState = nil

    local sessions = FDB:GetSessionsRoot()
    sessions.characters[state.guid] = "corrupted"

    local ok, result = pcall(function() return FDB:SessionPlayerReady() end)
    truthy(ok, "SessionPlayerReady must not error on a non-table character record: " .. tostring(result))
    truthy(result)

    local char = FDB.DB.sessions.characters[state.guid]
    truthy(type(char) == "table")
    truthy(type(char.current) == "table")
    equal(char.current.startedAt, state.now)

    state.xp = state.xp + 5
    local ok2, err2 = pcall(function() state:event("PLAYER_XP_UPDATE") end)
    truthy(ok2, "delivering an XP event after recovery must not crash: " .. tostring(err2))
    equal(char.current.xp.gained, 5)
end)

test("a non-table character record (number) recovers into a fresh valid character", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB.SessionState = nil

    local sessions = FDB:GetSessionsRoot()
    sessions.characters[state.guid] = 42

    local ok, result = pcall(function() return FDB:SessionPlayerReady() end)
    truthy(ok, "SessionPlayerReady must not error on a numeric character record: " .. tostring(result))
    truthy(result)
    truthy(type(FDB.DB.sessions.characters[state.guid]) == "table")
end)

test("a non-table character record (boolean) recovers into a fresh valid character", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB.SessionState = nil

    local sessions = FDB:GetSessionsRoot()
    sessions.characters[state.guid] = true

    local ok, result = pcall(function() return FDB:SessionPlayerReady() end)
    truthy(ok, "SessionPlayerReady must not error on a boolean character record: " .. tostring(result))
    truthy(result)
    truthy(type(FDB.DB.sessions.characters[state.guid]) == "table")
end)

test("history list with valid and non-table records mixed returns only the valid ones", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    char.history = {
        { id = "a", xpGained = 10, trackedSeconds = 100 },
        "corrupted-string-entry",
        { id = "b", xpGained = 20, trackedSeconds = 200 },
        42,
        false,
    }

    local history
    local ok, err = pcall(function() history = FDB:GetSessionHistory() end)
    truthy(ok, "GetSessionHistory must not error on mixed valid/invalid records: " .. tostring(err))
    equal(#history, 2)
    equal(history[1].id, "a")
    equal(history[2].id, "b")
end)

test("a history record with a wrong-typed display field does not crash GetSessionHistory", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    char.history = {
        { id = "a", xpGained = "not-a-number", trackedSeconds = "also-bad", goldEarned = {} },
    }

    local history
    local ok, err = pcall(function() history = FDB:GetSessionHistory() end)
    truthy(ok, "GetSessionHistory must not error on a wrong-typed display field: " .. tostring(err))
    equal(#history, 1)
    equal(history[1].id, "a")
end)

test("recovering one corrupted character does not affect other characters or non-session data", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    state.now = state.now + 70
    state.xp = state.xp + 5
    state:event("PLAYER_XP_UPDATE")
    truthy(FDB:ResetSession())
    local goodGuid = state.guid
    local goodHistoryCount = #FDB.DB.sessions.characters[goodGuid].history
    truthy(goodHistoryCount > 0)

    FDB.DB.sources = { keep = "yes" }
    FDB.DB.maps = { keep = "yes" }
    FDB.DB.guilds = { keep = "yes" }

    local sessions = FDB:GetSessionsRoot()
    sessions.characters["Player-1-000099"] = "corrupted"

    FDB.SessionState = nil
    state.guid = "Player-1-000099"
    truthy(FDB:SessionPlayerReady())

    equal(#FDB.DB.sessions.characters[goodGuid].history, goodHistoryCount)
    equal(FDB.DB.sources.keep, "yes")
    equal(FDB.DB.maps.keep, "yes")
    equal(FDB.DB.guilds.keep, "yes")
end)

-- Reviewer C finding: history corruption that happens mid-session (after
-- normalization already ran once at login) is a different failure shape
-- than corruption present in SavedVariables at login, and must be
-- equally safe.
test("history corrupted mid-session does not crash the archive step", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]

    state.now = state.now + 70
    state.xp = state.xp + 5
    state:event("PLAYER_XP_UPDATE")

    -- Corruption introduced AFTER GetOrCreateSessionCharacter's own
    -- normalization already ran for this login -- simulating some other
    -- code path (or a future bug) clobbering char.history in place.
    char.history = "corrupted-string-value"

    local ok, err = pcall(function() return FDB:ResetSession() end)
    truthy(ok, "ResetSession must not error when char.history was corrupted mid-session: " .. tostring(err))
    truthy(type(char.history) == "table")
    equal(#char.history, 1)
    equal(char.history[1].xpGained, 5)
    equal(char.current.startedAt, state.now)
end)

consolePrint(passed .. " session tracker smoke tests passed; live Forever E2E remains PENDING")
