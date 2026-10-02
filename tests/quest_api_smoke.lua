-- Run from repository root: lua5.4 tests/quest_api_smoke.lua
-- Simulated WoW APIs; this is not live Forever-client capability evidence.

local consolePrint = print
local passed = 0

local function truthy(value, message)
    assert(value, message or "expected truthy value")
end

local function equal(actual, expected, message)
    assert(actual == expected, message or (tostring(actual) .. " ~= " .. tostring(expected)))
end

local function contains(text, fragment)
    assert(text:find(fragment, 1, true), "missing: " .. fragment .. " in " .. text)
end

local function resetQuestGlobals()
    C_QuestLog = nil
    C_Timer = nil
    GetZoneText = nil
    GetSubZoneText = nil
    GetNumQuestLogEntries = nil
    GetQuestLogTitle = nil
    GetNumQuestLeaderBoards = nil
    GetQuestLogLeaderBoard = nil
    GetQuestLogIndexByID = nil
    GetQuestID = nil
    IsQuestFlaggedCompleted = nil
    QueryQuestsCompleted = nil
    GetQuestsCompleted = nil
end

local function setup(mode)
    resetQuestGlobals()

    local state = {
        messages = {},
        frames = {},
        timers = {},
        queriedCompleted = false,
    }
    local FDB = {}

    print = function(...)
        local parts = {}
        for i = 1, select("#", ...) do
            parts[#parts + 1] = tostring(select(i, ...))
        end
        state.messages[#state.messages + 1] = table.concat(parts, " ")
    end

    GetZoneText = function() return "Tirisfal Glades" end
    GetSubZoneText = function() return "Brill" end

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
            if frame.events[event] and frame.handler then
                frame.handler(frame, event, ...)
            end
        end
    end

    if mode == "modern" then
        C_QuestLog = {
            GetNumQuestLogEntries = function() return 3 end,
            GetInfo = function(index)
                if index == 1 then
                    return { title = "Tirisfal Glades", isHeader = true }
                elseif index == 2 then
                    return { title = "A New Plague", questID = 367, level = 7, isHeader = false }
                end
                return { title = "Fields of Grief", questID = 365, level = 7, isHeader = false }
            end,
            GetQuestObjectives = function(questID)
                if questID == 367 then
                    return {
                        { text = "Darkhound Blood: 2/5", finished = false },
                        { text = "Vile Fin Scale: 5/5", finished = true },
                    }
                end
                return {
                    { text = "Pumpkins: 10/10", finished = true },
                }
            end,
            IsComplete = function(questID) return questID == 365 end,
            IsQuestFlaggedCompleted = function(questID) return questID == 1 end,
            GetAllCompletedQuestIDs = function() return { 1, 2, 3, 4 } end,
        }
    elseif mode == "legacy" then
        GetNumQuestLogEntries = function() return 2, 1 end
        GetQuestLogTitle = function(index)
            if index == 1 then
                return "Tirisfal Glades", 0, 0, true, false, nil, nil, nil
            end
            return "At War With The Scarlet Crusade", 8, 0, false, false, 0, 1, 427
        end
        GetNumQuestLeaderBoards = function(index)
            return index == 2 and 1 or 0
        end
        GetQuestLogLeaderBoard = function(objectiveIndex, questIndex)
            assert(objectiveIndex == 1)
            assert(questIndex == 2)
            return "Scarlet Warrior slain: 3/10", "monster", false
        end
        GetQuestLogIndexByID = function() return 2 end
        GetQuestID = function() return 427 end
        IsQuestFlaggedCompleted = function() return false end
        QueryQuestsCompleted = function()
            state.queriedCompleted = true
        end
        GetQuestsCompleted = function()
            return { [101] = true, [202] = true, [303] = false }
        end
        C_Timer = {
            After = function(_, callback)
                state.timers[#state.timers + 1] = callback
            end,
        }
    end

    assert(loadfile("addon/ForeverDB/QuestApiProbe.lua"))("ForeverDB", FDB)
    FDB:InitializeQuestApiProbe()

    return FDB, state
end

local function test(name, run)
    local ok, err = pcall(run)
    print = consolePrint
    resetQuestGlobals()
    if not ok then
        error(name .. ": " .. tostring(err))
    end
    passed = passed + 1
    consolePrint("PASS (simulated): " .. name)
end

test("modern quest APIs print active quests, objectives and completed count without persistence", function()
    local FDB, state = setup("modern")
    FDB:RunQuestApiProbe()

    local output = table.concat(state.messages, "\n")
    contains(output, "questapi: read-only compatibility probe")
    contains(output, "zone=Tirisfal Glades subzone=Brill")
    contains(output, "C_QuestLog.GetInfo")
    contains(output, "active log entries=3 path=modern")
    contains(output, "A New Plague id=367 lvl=7 complete=false")
    contains(output, "Darkhound Blood: 2/5")
    contains(output, "Vile Fin Scale: 5/5")
    contains(output, "Fields of Grief id=365 lvl=7 complete=true")
    contains(output, "completed quest ids=4 path=modern")
    contains(output, "probe complete; nothing was saved or uploaded")
    equal(ForeverDB_Saved, nil, "probe must not create SavedVariables")
    equal(ForeverDB_Export, nil, "probe must not create export data")
end)

test("legacy quest APIs wait for QUEST_QUERY_COMPLETE and print completion cache", function()
    local FDB, state = setup("legacy")
    FDB:RunQuestApiProbe()

    truthy(state.queriedCompleted, "legacy probe should request completed quest cache")
    equal(#state.timers, 1, "legacy completion query should have a timeout fallback")

    local beforeEvent = table.concat(state.messages, "\n")
    contains(beforeEvent, "active log entries=2 path=legacy")
    contains(beforeEvent, "At War With The Scarlet Crusade id=427 lvl=8 complete=false")
    contains(beforeEvent, "Scarlet Warrior slain: 3/10")
    contains(beforeEvent, "QueryQuestsCompleted request=OK")

    state:event("QUEST_QUERY_COMPLETE")
    local output = table.concat(state.messages, "\n")
    contains(output, "completed-query: QUEST_QUERY_COMPLETE received")
    contains(output, "completed quest ids=2")
    contains(output, "probe complete; nothing was saved or uploaded")

    -- The timeout callback must be harmless after the event already completed.
    state.timers[1]()
    local afterTimeout = table.concat(state.messages, "\n")
    local _, occurrences = afterTimeout:gsub("probe complete; nothing was saved or uploaded", "")
    equal(occurrences, 1, "completion output must not be duplicated")
end)

test("missing quest APIs fail soft and remain read-only", function()
    local FDB, state = setup("missing")
    FDB:RunQuestApiProbe()

    local output = table.concat(state.messages, "\n")
    contains(output, "active quest log snapshot unavailable")
    contains(output, "completed quest enumeration unavailable")
    contains(output, "probe complete; nothing was saved or uploaded")
end)

test("Core initializes quest probe and routes /fdb questapi plus /fdb quests alias", function()
    resetQuestGlobals()

    local state = { frames = {}, probeInit = 0, probeRuns = 0 }
    local FDB = {}

    CreateFrame = function()
        local frame = { events = {} }
        function frame:RegisterEvent(event) self.events[event] = true end
        function frame:SetScript(_, handler) self.handler = handler end
        state.frames[#state.frames + 1] = frame
        return frame
    end
    SlashCmdList = {}
    print = function() end

    for _, name in ipairs({
        "InitializeDatabase", "InitializeSessionTracker", "InitializeSessionUI",
        "InitializeGuildApiProbe", "InitializeGuildbookTracker",
        "InitializeGatheringTracker", "InitializeSkinningTracker",
        "InitializeFishingPoolTracker", "InitializeDisenchantTracker",
        "InitializeLootTracker", "InitializeTooltip", "BuildExportSnapshot",
    }) do
        FDB[name] = function() end
    end

    FDB.InitializeQuestApiProbe = function()
        state.probeInit = state.probeInit + 1
    end
    FDB.RunQuestApiProbe = function()
        state.probeRuns = state.probeRuns + 1
    end

    assert(loadfile("addon/ForeverDB/Core.lua"))("ForeverDB", FDB)
    truthy(FDB.EventFrame and FDB.EventFrame.handler, "Core event frame should be wired")

    FDB.EventFrame.handler(FDB.EventFrame, "ADDON_LOADED", "ForeverDB")
    equal(state.probeInit, 1)
    truthy(type(SlashCmdList.FOREVERDB) == "function", "/fdb slash command should be registered")

    SlashCmdList.FOREVERDB("questapi")
    SlashCmdList.FOREVERDB("quests")
    equal(state.probeRuns, 2)
end)

test("TOC loads QuestApiProbe before Core can initialize dependent runtime state", function()
    local file = assert(io.open("addon/ForeverDB/ForeverDB.toc", "r"))
    local toc = file:read("*a")
    file:close()

    local questPos = assert(toc:find("QuestApiProbe.lua", 1, true))
    local guildbookPos = assert(toc:find("GuildbookTracker.lua", 1, true))
    truthy(questPos < guildbookPos, "QuestApiProbe.lua should be loaded before GuildbookTracker.lua")
end)

consolePrint(passed .. " quest API simulated checks passed; live Forever probe remains PENDING")
