-- Run from repository root: lua5.4 tests/quest_tracker_smoke.lua
-- Simulated API observations only; real WoW: Forever client acceptance is required.
local passed, failed = 0, 0
local function equal(a, b, message)
    assert(a == b, (message or "value mismatch") .. ": " .. tostring(a) .. " != " .. tostring(b))
end
local function truthy(a, message) assert(a, message or "expected true") end
local function falsy(a, message) assert(not a, message or "expected false") end
local function contains(s, needle)
    assert(s:find(needle, 1, true), "missing " .. needle .. " in " .. s)
end

local function setup(opts)
    opts = opts or {}
    local state = {
        frames = {},
        at = 100,
        now = 1783530000,
        player = "Player-0-AAAA",
        giverId = 99,
        giverName = "Quest Giver",
        location = { mapId=85, zoneName="Tirisfal Glades", subZoneName="Brill", x=31.5, y=60.0 },
        questId = 367,
        title = "A New Plague",
        objectiveText = "Collect Darkhound Blood.",
        loot = {},
        guid = "Creature-0-0-0-0-7000-00000001",
        tooltipHooks = {},
    }
    C_Timer, GetQuestLogTitle, GetQuestLogIndexByID = nil, nil, nil
    GetNumQuestLogEntries, GetNumQuestLeaderBoards, GetQuestLogLeaderBoard = nil, nil, nil
    issecretvalue = nil
    GetServerTime = function() return state.now end
    GetTime = function() return state.at end
    UnitGUID = function(unit)
        if unit == "player" then return state.player end
        if unit == "npc" then return "Creature-0-0-0-0-" .. tostring(state.giverId) .. "-00000001" end
        if unit == "target" or unit == "mouseover" then return state.guid end
        return nil
    end
    UnitName = function(unit) return unit == "npc" and state.giverName or "Cursed Wolf" end
    UnitLevel = function() return 7 end
    GetQuestID = opts.noQuestAPI and nil or function() return state.questId end
    GetTitleText = function() return state.title end
    GetObjectiveText = function() return state.objectiveText end
    GetNumQuestRewards = opts.noQuestAPI and nil or function() return 1 end
    GetNumQuestChoices = opts.noQuestAPI and nil or function() return 2 end
    GetQuestItemInfo = opts.noQuestAPI and nil or function(kind, index)
        if kind == "reward" then return "Robe of Testing", nil, 1, nil, nil, 901 end
        if index == 1 then return "Sword of Testing", nil, 1, nil, nil, 902 end
        return "Shield of Testing", nil, 1, nil, nil, 903
    end
    GetQuestItemLink = opts.noQuestAPI and nil or function(kind, index)
        return "item:" .. tostring(kind == "reward" and 901 or 901 + index)
    end
    GetRewardXP = opts.noQuestAPI and nil or function() return 1000 end
    GetRewardMoney = opts.noQuestAPI and nil or function() return 150 end
    C_QuestLog = opts.noQuestAPI and nil or {
        GetTitleForQuestID = function(id) return id == 367 and "A New Plague" or nil end,
        GetQuestObjectives = function(id)
            if id ~= 367 then return nil end
            return {
                { text="Darkhound Blood: 0/5", type="item", objectID=123, finished=false },
                { text="Darkhounds slain: 2/5", type="monster", objectID=7000, finished=false },
            }
        end
    }
    GetQuestText = function() return "The plague is spreading." end
    if opts.noQuestAPI then
        GetQuestID, GetNumQuestRewards, GetNumQuestChoices = nil, nil, nil
        GetQuestItemInfo, GetQuestItemLink, GetRewardXP, GetRewardMoney, C_QuestLog = nil, nil, nil, nil, nil
    end
    CreateFrame = function()
        local f = { events = {} }
        function f:RegisterEvent(ev) self.events[ev] = true end
        function f:SetScript(kind, cb) self.callback = cb end
        state.frames[#state.frames+1] = f
        return f
    end
    function state:emit(ev, ...)
        for _, f in ipairs(self.frames) do
            if f.events[ev] and f.callback then
                f.callback(f, ev, ...)
            end
        end
    end
    local FDB = {
        DB = { sources = {}, guilds = {}, schemaVersion = 9, updatedAt=1 },
        VERSION = "0.6.0-alpha", SCHEMA_VERSION = 9,
        Debug = function() end,
    }
    function FDB:GetCurrentLocation()
        local l = state.location
        return { mapId=l.mapId, zoneName=l.zoneName, subZoneName=l.subZoneName, x=l.x, y=l.y }
    end
    function FDB:ParseSourceGuid(guid)
        if not guid then return nil end
        local kind, id = guid:match("^(%a+)%-.-%-(%d+)%-[^%-]+$")
        if kind == "Creature" then return "creature", tonumber(id) end
        return nil
    end
    assert(loadfile("addon/ForeverDB/QuestTracker.lua"))("ForeverDB", FDB)
    FDB:InitializeQuestTracker()
    return FDB, state
end

local function test(name, run)
    local ok, err = pcall(run)
    if not ok then failed = failed + 1; print("FAIL: " .. name .. ": " .. tostring(err)); return end
    passed = passed + 1
    print("PASS (simulated): " .. name)
end

test("quest accept captures dialog giver, approximate position and real item objective", function()
    local FDB, state = setup()
    state:emit("QUEST_DETAIL")
    state:emit("QUEST_ACCEPTED", 4, 367)
    local char = FDB.DB.questJournal[state.player]
    local q = char.entries["367"]
    truthy(q, "missing quest")
    equal(q.status, "active")
    equal(q.title, "A New Plague")
    equal(q.accept.sourceId, 99)
    equal(q.accept.name, "Quest Giver")
    equal(q.accept.location.x, 31.5)
    equal(q.accept.location.mapId, 85)
    equal(q.objectiveText, "Collect Darkhound Blood.")
    equal(#q.objectives, 2)
    truthy(q.requiredItemIds["123"])
    falsy(q.requiredItemIds["7000"], "a monster kill is not an item ID")
    local isQuest, linked = FDB:IdentifyQuestLoot(123, false, nil)
    truthy(isQuest)
    equal(linked, 367)
    falsy(FDB:IdentifyQuestLoot(7000, false, nil))
    falsy(FDB.DB.sources["creature:99:7"], "quest giver must not become a loot source")
    local oldAccept = q.acceptedAt
    state.now = state.now + 10
    state:emit("QUEST_ACCEPTED", 4, 367)
    equal(q.acceptedAt, oldAccept, "duplicate event must not increment acceptance")
end)

test("turn-in captures actual giver, offered choices separately from granted XP/money", function()
    local FDB, state = setup()
    state:emit("QUEST_DETAIL")
    state:emit("QUEST_ACCEPTED", 4, 367)
    state.giverId, state.giverName = 501, "Apothecary"
    state.location.x, state.location.y = 42.0, 30.5
    state:emit("QUEST_COMPLETE")
    state:emit("QUEST_TURNED_IN", 367, 1700, 275)
    local q = FDB.DB.questJournal[state.player].entries["367"]
    equal(q.status, "completed")
    equal(q.turnIn.sourceId, 501)
    equal(q.turnIn.location.y, 30.5)
    equal(q.rewards.guaranteed[1].itemId, 901)
    equal(#q.rewards.choices, 2)
    equal(q.rewards.choices[2].itemId, 903)
    equal(q.rewards.offeredXP, 1000)
    equal(q.rewards.grantedXP, 1700)
    equal(q.rewards.grantedMoney, 275)
    falsy(q.rewards.selectedItemId, "selected choice is not proven by offer list")
    falsy(FDB:IdentifyQuestLoot(123, false, nil), "completed quest cannot create active association")
    truthy(FDB:IdentifyQuestLoot(123, true, nil), "WoW explicit quest flag is evidence")
    state:emit("QUEST_REMOVED", 367)
    equal(q.status, "completed", "remove after turn-in must not be abandonment")
end)

test("quest removal records not-completed and a different character is isolated", function()
    local FDB, state = setup()
    state:emit("QUEST_DETAIL")
    state:emit("QUEST_ACCEPTED", 4, 367)
    state:emit("QUEST_REMOVED", 367)
    local record = FDB.DB.questJournal[state.player].entries["367"]
    equal(record.status, "removed")
    falsy(record.completedAt)
    falsy(FDB:IdentifyQuestLoot(123, false, nil))
    state.player = "Player-0-BBBB"
    falsy(FDB.DB.questJournal[state.player], "another character should not inherit quest journal")
    state:emit("QUEST_ACCEPTED", 4, 404)
    local second = FDB.DB.questJournal[state.player].entries["404"]
    equal(second.status, "active")
    falsy(second.accept, "a mismatched offer cannot be assigned to another quest")
    equal(FDB.DB.questJournal["Player-0-AAAA"].entries["367"].status, "removed")
end)

test("missing client quest APIs fail soft; no remote export or Guildbook records", function()
    local FDB, state = setup({ noQuestAPI = true })
    state:emit("QUEST_DETAIL")
    state:emit("QUEST_ACCEPTED", 0, 367)
    state:emit("QUEST_COMPLETE")
    state:emit("QUEST_TURNED_IN", 367)
    local q = FDB.DB.questJournal[state.player].entries["367"]
    equal(q.status, "completed")
    falsy(q.accept)
    falsy(q.turnIn)
    falsy(q.rewards.guaranteed)
    falsy(q.rewards.choices)
    falsy(q.rewards.grantedXP)
    falsy(ForeverDB_Export, "Quest Tracker must never write export data")
    falsy(next(FDB.DB.guilds), "Quest Tracker must not write Guildbook records")
end)

test("loot collector marks quest objective item even when GetLootSlotInfo flag is false", function()
    local FDB, state = setup()
    state:emit("QUEST_DETAIL")
    state:emit("QUEST_ACCEPTED", 4, 367)
    GetNumLootItems = function() return 1 end
    GetLootSourceInfo = function() return state.guid, 1 end
    GetLootSlotLink = function() return "item:123" end
    GetLootSlotInfo = function()
        return nil, "Darkhound Blood", 1, nil, nil, nil, false, nil
    end
    GetZoneText = function() return "Tirisfal Glades" end
    GetSubZoneText = function() return "Brill" end
    C_Map = { GetBestMapForUnit = function() return 85 end }
    function FDB:GetSourceNameFromGuid() return "Cursed Wolf" end
    function FDB:GetPendingGatheringKind() return nil end
    function FDB:GetPendingGathering() return nil end
    function FDB:ConsumePendingGatheringKind() end
    function FDB:RecordObservation(kind, sourceType, sourceId, sourceName, items)
        state.loot = {kind=kind, sourceType=sourceType, sourceId=sourceId, name=sourceName, items=items}
    end
    assert(loadfile("addon/ForeverDB/LootTracker.lua"))("ForeverDB", FDB)
    FDB:InitializeLootTracker()
    state:emit("LOOT_READY")
    equal(state.loot.kind, "mob")
    equal(state.loot.sourceId, 7000)
    truthy(state.loot.items[123].isQuestItem, "quest item not marked")
    equal(state.loot.items[123].questId, 367)
    state:emit("LOOT_CLOSED")
    state:emit("QUEST_TURNED_IN", 367, 1700, 100)
    state:emit("LOOT_READY")
    falsy(state.loot.items[123].isQuestItem,
        "without an active quest and without WoW's flag, it is not a current quest item")
end)

test("mob tooltip prioritizes and explicitly labels observed quest items", function()
    local FDB, state = setup()
    FDB.DB.sources["creature:7000:7"] = {
        sourceType="creature", sourceId=7000, sourceLevel=7, name="Cursed Wolf",
        buckets={mob={ observations=2, items={
            ["123"]={itemId=123, name="Darkhound Blood", drops=1, quantity=1, questDrops=1, questIds={["367"]=true}},
            ["777"]={itemId=777, name="Common Claw", drops=2, quantity=2, questDrops=0},
        }}}
    }
    TooltipDataProcessor = {
        AddTooltipPostCall = function(kind, callback)
            state.tooltipHooks[kind] = callback
        end
    }
    Enum = { TooltipDataType={ Unit=1, Item=2 } }
    FDB.SourceKey = function(_, kind, id, level) return kind .. ":" .. id .. ":" .. level end
    assert(loadfile("addon/ForeverDB/Tooltip.lua"))("ForeverDB", FDB)
    FDB:InitializeTooltip()
    local lines = {}
    local tooltip = {
        AddLine=function(_,line) lines[#lines+1] = line end,
        AddDoubleLine=function(_,a,b) lines[#lines+1] = a .. " " .. b end,
    }
    state.tooltipHooks[1](tooltip, { guid=state.guid, level=7 })
    local output = table.concat(lines, "\n")
    contains(output, "Darkhound Blood [Quest item]")
    contains(output, "Common Claw")
    assert(output:find("Darkhound Blood", 1, true) <
        output:find("Common Claw", 1, true), "quest items must precede higher-rate normal loot")
    local sources = FDB:GetItemSources(123)
    equal(#sources, 1)
    equal(sources[1].questDrops, 1)
end)

test("description, level and objective counters are actual client metadata", function()
    local FDB, s = setup()
    C_QuestLog.GetLogIndexForQuestID = function() return 2 end
    C_QuestLog.GetInfo = function() return {questID=367, title=s.title, level=7} end
    C_QuestLog.GetQuestObjectives = function() return {{text="Blood: 2/5", type="item", objectID=123,
        numFulfilled=2, numRequired=5, finished=false}} end
    s:emit("QUEST_DETAIL"); s:emit("QUEST_ACCEPTED", 367)
    local q = FDB.DB.questJournal[s.player].entries["367"]
    equal(q.description, "The plague is spreading.")
    equal(q.level, 7)
    equal(q.objectives[1].numFulfilled, 2)
    equal(q.objectives[1].numRequired, 5)
end)

test("legacy log index resolves to canonical ID and captures objectives", function()
    local FDB, s = setup({noQuestAPI=true})
    GetQuestLogTitle = function(index)
        if index == 2 then return "Legacy Quest", 9, nil, false, nil, 0, nil, 427 end
    end
    GetQuestLogIndexByID = function(id) if id == 427 then return 2 end end
    GetNumQuestLeaderBoards = function(index) equal(index, 2); return 1 end
    GetQuestLogLeaderBoard = function(i, index)
        equal(i, 1); equal(index, 2); return "Warriors slain: 1/10", "monster", nil
    end
    s:emit("QUEST_ACCEPTED", 2)
    local entries = FDB.DB.questJournal[s.player].entries
    truthy(entries["427"], "legacy index must not become quest ID 2")
    falsy(entries["2"])
    equal(entries["427"].title, "Legacy Quest")
    equal(entries["427"].level, 9)
    equal(entries["427"].objectives[1].text, "Warriors slain: 1/10")
end)

test("no npc never borrows target and closed dialog cannot leak into acceptance", function()
    local FDB, s = setup()
    local units = UnitGUID
    UnitGUID = function(unit) if unit == "npc" then return nil end; return units(unit) end
    UnitName = function(unit) if unit == "target" then return "Unrelated target" end end
    s:emit("QUEST_DETAIL"); s:emit("QUEST_ACCEPTED", 367)
    local q = FDB.DB.questJournal[s.player].entries["367"]
    falsy(q.accept.sourceId); falsy(q.accept.name)
    equal(q.accept.location.mapId, 85)
    s.questId = 404
    s:emit("QUEST_DETAIL"); s:emit("QUEST_FINISHED"); s:emit("QUEST_ACCEPTED", 404)
    falsy(FDB.DB.questJournal[s.player].entries["404"].accept)
end)

test("duplicate turn-in preserves location, rewards and timestamp", function()
    local FDB, s = setup()
    s:emit("QUEST_COMPLETE"); s:emit("QUEST_TURNED_IN", 367, 1000, 150)
    local q = FDB.DB.questJournal[s.player].entries["367"]
    s.now = s.now + 30
    s:emit("QUEST_TURNED_IN", 367)
    equal(q.turnIn.sourceId, 99)
    equal(q.completedAt, 1783530000)
    equal(q.rewards.grantedXP, 1000)
    equal(q.rewards.grantedMoney, 150)
end)

test("repeatable reacceptance cannot retain a previous giver or item association", function()
    local FDB, s = setup()
    s:emit("QUEST_DETAIL"); s:emit("QUEST_ACCEPTED", 367)
    s:emit("QUEST_REMOVED", 367)
    C_QuestLog.GetQuestObjectives = function() return nil end
    s:emit("QUEST_ACCEPTED", 367)
    local q = FDB.DB.questJournal[s.player].entries["367"]
    falsy(q.accept); falsy(q.requiredItemIds)
    falsy(FDB:IdentifyQuestLoot(123, false, nil))
end)

test("existing active log after login is observed without inventing acceptance", function()
    local FDB, s = setup()
    C_QuestLog.GetNumQuestLogEntries = function() return 2 end
    C_QuestLog.GetInfo = function(index)
        if index == 1 then return {isHeader=true} end
        return {questID=367, title=s.title, level=7}
    end
    s:emit("PLAYER_LOGIN")
    local q = FDB.DB.questJournal[s.player].entries["367"]
    equal(q.status, "active"); falsy(q.acceptedAt); falsy(q.accept)
    truthy(FDB:IdentifyQuestLoot(123, false, nil))
end)

test("objective updates coalesce repeated events", function()
    local FDB, s = setup()
    s:emit("QUEST_ACCEPTED", 367)
    local calls, callbacks = 0, {}
    C_QuestLog.GetQuestObjectives = function() calls=calls+1; return {} end
    C_Timer = {After=function(_, cb) callbacks[#callbacks+1]=cb end}
    for i=1,25 do s:emit("QUEST_LOG_UPDATE") end
    equal(#callbacks, 1)
    equal(calls, 0)
    callbacks[1]()
    equal(calls, 1)
end)

test("quest status and invalid requested IDs do not fall back to last record", function()
    local FDB, s = setup()
    s:emit("QUEST_ACCEPTED", 367)
    local savedPrint, lines = print, {}
    print = function(...) local parts={}; for i=1,select("#", ...) do parts[i]=tostring(select(i,...)) end
        lines[#lines+1]=table.concat(parts," ") end
    local ok, err = pcall(function()
        FDB:PrintTrackedQuest("status")
        contains(table.concat(lines,"\n"), "active=1")
        lines={}; FDB:PrintTrackedQuest("999")
        contains(table.concat(lines,"\n"), "no local quest record")
        lines={}; FDB:PrintTrackedQuest("bad-id")
        contains(table.concat(lines,"\n"), "usage:")
    end)
    print=savedPrint; assert(ok, err)
end)

test("unsupported events fail soft and are reported", function()
    local FDB, s = setup()
    -- Re-load a fresh tracker with a client that rejects an event name.
    local create = CreateFrame
    CreateFrame = function()
        local f = create(); local register=f.RegisterEvent
        f.RegisterEvent=function(self, event)
            if event == "QUEST_TURNED_IN" then error("unknown event") end
            register(self,event)
        end
        return f
    end
    assert(loadfile("addon/ForeverDB/QuestTracker.lua"))("ForeverDB", FDB)
    FDB:InitializeQuestTracker()
    s:emit("QUEST_ACCEPTED", 367)
    equal(FDB.DB.questJournal[s.player].entries["367"].status,"active")
end)

assert(failed == 0, tostring(failed) .. " quest tracker checks failed")
print(passed .. " quest tracker simulated smoke checks passed; live Forever client gate PENDING")
