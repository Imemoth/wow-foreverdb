-- Run from the repository root: lua5.4 tests/guildbook_capture_smoke.lua
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

local function contains(value, needle, label)
    if type(value) ~= "string" or not value:find(needle, 1, true) then
        error((label or "value") .. " did not contain " .. needle)
    end
end

local function setup(saved)
    local state = {
        now = 1000,
        monotonic = 100,
        rosterName = "Vesperix",
        frames = {},
        timers = {},
        rosterRefreshes = 0,
    }

    local FDB = {}

    GetServerTime = function() return state.now end
    GetTime = function() return state.monotonic end
    time = function() return state.now end
    UnitGUID = function(unit)
        return unit == "player" and "Player-1-000001" or nil
    end
    UnitName = function(unit)
        return unit == "player" and "Vesperix" or nil
    end
    UnitClass = function() return "Rogue", "ROGUE" end
    UnitLevel = function() return 60 end
    GetRealmName = function() return "TestRealm" end
    GetRealZoneText = function() return "Tirisfal Glades" end
    IsInGuild = function() return true end
    GetGuildInfo = function()
        return "Test Guild", "Officer", 1
    end
    GetNumGuildMembers = function() return 1, 1 end
    GetGuildRosterInfo = function()
        local row = {
            state.rosterName,
            "Member",
            2,
            60,
            "Rogue",
            "Tirisfal Glades",
            "",
            "",
            true,
            "",
            "ROGUE",
            "",
            "",
            "",
            "",
            "",
            "Player-1-000001",
        }
        return unpack(row)
    end
    GetProfessions = function() return 1 end
    GetProfessionInfo = function()
        return "Skinning", nil, 300, 300, nil, nil, 393
    end
    C_GuildInfo = {
        GuildRoster = function() state.rosterRefreshes = state.rosterRefreshes + 1 end,
    }
    C_Timer = {
        After = function(_, callback)
            state.timers[#state.timers + 1] = callback
        end,
    }
    CreateFrame = function()
        local frame = { events = {} }
        function frame:RegisterEvent(event) self.events[event] = true end
        function frame:UnregisterEvent(event) self.events[event] = nil end
        function frame:SetScript(_, handler) self.handler = handler end
        state.frames[#state.frames + 1] = frame
        return frame
    end

    ForeverDB_Saved = saved
    ForeverDB_Export = nil
    SlashCmdList = {}

    assert(loadfile("addon/ForeverDB/Core.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/Database.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/Exporter.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/GuildbookTracker.lua"))("ForeverDB", FDB)

    FDB:InitializeDatabase()

    function state:runTimers()
        while #self.timers > 0 do
            local callback = table.remove(self.timers, 1)
            callback()
        end
    end

    return FDB, state
end

local function setupSlashCommand()
    local FDB, state = setup()
    local initializerNames = {
        "InitializeSessionTracker",
        "InitializeSessionUI",
        "InitializeGuildApiProbe",
        "InitializeQuestApiProbe",
        "InitializeGatheringTracker",
        "InitializeSkinningTracker",
        "InitializeFishingPoolTracker",
        "InitializeDisenchantTracker",
        "InitializeLootTracker",
        "InitializeTooltip",
    }

    for _, name in ipairs(initializerNames) do
        FDB[name] = function() end
    end

    local originalTrackerInitializer = FDB.InitializeGuildbookTracker
    FDB.InitializeGuildbookTracker = function() end
    FDB.EventFrame.handler(FDB.EventFrame, "ADDON_LOADED", "ForeverDB")
    FDB.InitializeGuildbookTracker = originalTrackerInitializer

    return FDB, state
end

local function test(name, run)
    local ok, err = pcall(run)
    print = consolePrint
    if not ok then error(name .. ": " .. tostring(err)) end
    passed = passed + 1
    consolePrint("PASS (simulated): " .. name)
end

test("fresh changed roster creates persisted provenance and optional header metadata", function()
    local f, s = setup()
    f:RefreshGuildbook("test-fresh")
    s:runTimers()

    local capture = f.DB.guildbookCapture
    truthy(capture, "capture")
    truthy(capture.captureId, "capture id")
    equal(capture.capturedAt, 1000)
    equal(capture.sourceCharacterGuid, "Player-1-000001")
    equal(capture.sourceCharacterName, "Vesperix")
    equal(capture.sourceCharacterRealm, "TestRealm")
    truthy(capture.fingerprint, "capture fingerprint")
    contains(ForeverDB_Export, "H|9|0.5.0-alpha|")
    contains(ForeverDB_Export, "|" .. capture.captureId .. "|1000|Player-1-000001|Vesperix|TestRealm")
end)

test("unchanged refresh and export do not create a new capture", function()
    local f, s = setup()
    f:RefreshGuildbook("test-initial")
    s:runTimers()
    local first = f.DB.guildbookCapture
    local firstExport = ForeverDB_Export

    s.now = 1100
    s.monotonic = 110
    f:BuildExportSnapshot()
    equal(f.DB.guildbookCapture.captureId, first.captureId)
    equal(f.DB.guildbookCapture.capturedAt, first.capturedAt)
    equal(ForeverDB_Export, firstExport)

    f:RefreshGuildbook("test-unchanged")
    s:runTimers()
    equal(f.DB.guildbookCapture.captureId, first.captureId)
    equal(f.DB.guildbookCapture.capturedAt, first.capturedAt)
end)

test("changed roster creates a new capture while normal observations remain separate", function()
    local f, s = setup()
    f:RefreshGuildbook("test-initial")
    s:runTimers()
    local firstId = f.DB.guildbookCapture.captureId

    s.now = 1200
    s.monotonic = 120
    s.rosterName = "New Member Name"
    f:RefreshGuildbook("test-changed")
    s:runTimers()

    equal(f.DB.guilds["TestRealm|Test Guild"].members["Player-1-000001"].name, "New Member Name")
    equal(f.DB.guildbookCapture.capturedAt, 1200)
    truthy(f.DB.guildbookCapture.captureId ~= firstId, "new capture id")
    equal(f.DB.guildbookCapture.sourceCharacterGuid, "Player-1-000001")
    equal(f.DB.guildbookCapture.sourceCharacterName, "Vesperix")
end)

test("reload preserves the last capture and export does not create one", function()
    local f, s = setup()
    f:RefreshGuildbook("test-initial")
    s:runTimers()
    local savedCapture = f.DB.guildbookCapture
    local savedExport = f:BuildExportSnapshot()
    local saved = ForeverDB_Saved

    local reloaded = setup(saved)
    equal(reloaded.DB.guildbookCapture.captureId, savedCapture.captureId)
    equal(reloaded.DB.guildbookCapture.capturedAt, savedCapture.capturedAt)
    equal(reloaded:BuildExportSnapshot(), savedExport)
end)

test("legacy schema-9 header remains readable by the unchanged export shape", function()
    local f = setup()
    f.DB.guildbookCapture = nil
    local export = f:BuildExportSnapshot()
    equal(export:match("^H|([^\n]+)"), "9|0.5.0-alpha|" .. f.DB.installationId .. "|1000")
    falsy(export:find("guildbookCapture", 1, true), "legacy header metadata")
end)

test("guildbook refresh slash command requests a fresh capture", function()
    local f = setupSlashCommand()
    local reason
    f.RefreshGuildbook = function(_, value) reason = value end

    SlashCmdList.FOREVERDB("guildbook refresh")
    equal(reason, "manual-command")
end)

consolePrint(passed .. " simulated checks passed; live WoW E2E remains PENDING")
