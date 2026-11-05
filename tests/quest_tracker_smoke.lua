-- Run from repository root: lua5.4 tests/quest_tracker_smoke.lua
-- Simulated API observations only; real WoW: Forever client acceptance is required.
local passed = 0
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
    GetQuestID = (not opts.noQuestAPI) and function() return state.questId end
    GetTitleText = function() return state.title end
    GetObjectiveText = function() return state.objectiveText end
    GetQuestText = function() return "The Apothecary Society requests blood samples." end
    GetNumQuestRewards = (not opts.noQuestAPI) and function() return 1 end
    GetNumQuestChoices = (not opts.noQuestAPI) and function() return 2 end
    GetQuestItemInfo = (not opts.noQuestAPI) and function(kind, index)
        if kind == "reward" then return "Robe of Testing", nil, 1, nil, nil, 901 end
        if index == 1 then return "Sword of Testing", nil, 1, nil, nil, 902 end
        return "Shield of Testing", nil, 1, nil, nil, 903
    end
    GetQuestItemLink = (not opts.noQuestAPI) and function(kind, index)
        return "item:" .. tostring(kind == "reward" and 901 or 901 + index)
    end
    GetRewardXP = (not opts.noQuestAPI) and function() return 1000 end
    GetRewardMoney = (not opts.noQuestAPI) and function() return 150 end
    C_QuestLog = (not opts.noQuestAPI) and {
        GetTitleForQuestID = function(id) return id == 367 and "A New Plague" or nil end,
        GetQuestObjectives = function(id)
            if id ~= 367 then return nil end
            return {
                { text="Darkhound Blood: 0/5", type="item", objectID=123, finished=false },
                { text="Darkhounds slain: 2/5", type="monster", objectID=7000, finished=false },
            }
        end
    }
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
    if not ok then error(name .. ": " .. tostring(err)) end
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
    equal(q.description, "The Apothecary Society requests blood samples.")
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
    -- Inspect offered item rewards while the reward dialog is still open.
    local beforeTurnIn = FDB.DB.questJournal[state.player].entries["367"]
    equal(beforeTurnIn.status, "active")
    equal(beforeTurnIn.rewards.guaranteed[1].itemId, 901)
    equal(#beforeTurnIn.rewards.choices, 2)
    falsy(beforeTurnIn.rewards.grantedXP)
    falsy(beforeTurnIn.turnIn, "offer preview is not a completed turn-in")
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

test("repeatable quest accept discards stale NPC and former reward evidence", function()
    local FDB, state = setup()
    state:emit("QUEST_DETAIL")
    state:emit("QUEST_ACCEPTED", 4, 367)
    state:emit("QUEST_TURNED_IN", 367, 1000, 200)
    local q = FDB.DB.questJournal[state.player].entries["367"]
    truthy(q.accept)
    truthy(q.rewards)
    state:emit("QUEST_ACCEPTED", 4, 367)
    equal(q.status, "active")
    falsy(q.accept, "old giver cannot leak into a repeated acceptance")
    falsy(q.rewards, "old reward cannot leak into a repeated acceptance")
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

print(passed .. " quest tracker simulated smoke checks passed; live Forever client gate PENDING")
