-- Run from the repository root: lua tests/collector_smoke.lua (or texlua).
-- Simulated WoW APIs; this is NOT live collector/persistence acceptance.
local consolePrint = print
local passed = 0
local unpackValues = table.unpack or unpack

local function equal(actual, expected)
    assert(actual == expected, tostring(actual) .. " ~= " .. tostring(expected))
end

local function contains(text, fragment)
    assert(text:find(fragment, 1, true), "missing: " .. fragment .. " in " .. text)
end

local function setup(api)
    local state = {
        now = 100,
        frames = {},
        messages = {},
        slots = {},
        hooks = {},
        cursorSpellId = 13262,
        spellCanTargetItem = false,
    }
    local FDB = {}
    print = function(...)
        local parts = {}
        for i = 1, select("#", ...) do parts[i] = tostring(select(i, ...)) end
        state.messages[#state.messages + 1] = table.concat(parts, " ")
    end
    GetTime = function() return state.now end
    GetServerTime = function() return 1000 + state.now end
    GetTimePreciseSec, debugprofilestop = nil, nil
    SlashCmdList = {}
    ForeverDB_Saved = { installationId = "offline-fixture", sources = {} }
    ForeverDB_Export = nil
    CreateFrame = function()
        local frame = { events = {} }
        function frame:RegisterEvent(event) self.events[event] = true end
        function frame:SetScript(_, handler) self.handler = handler end
        state.frames[#state.frames + 1] = frame
        return frame
    end
    function state:event(event, ...)
        for _, frame in ipairs(self.frames) do
            if frame.events[event] then frame.handler(frame, event, ...) end
        end
    end
    strsplit = function(separator, value)
        local parts = {}
        for part in (value .. separator):gmatch("(.-)" .. separator) do
            parts[#parts + 1] = part
        end
        return unpackValues(parts)
    end
    UnitGUID = function(unit) return unit == "npc" and state.guid or nil end
    UnitName = function() return "Test Herb Node" end
    UnitNameFromGUID = function() return "Test Herb Node" end
    GetZoneText = function() return "Test Zone" end
    GetSubZoneText = function() return "Test Subzone" end
    C_Map = {
        GetBestMapForUnit = function() return 42 end,
        GetPlayerMapPosition = function() return { x = 0.421, y = 0.337 } end,
    }
    C_Spell = { GetSpellName = function() return "Localized gathering spell" end }
    GetCursorInfo = function()
        return "spell", nil, nil, state.cursorSpellId
    end
    SpellCanTargetItem = function()
        return state.spellCanTargetItem
    end
    SpellCanTargetItemID = function()
        return false
    end
    GetItemInfo = function() return "Test Input" end
    local container = {
        UseContainerItem = function() end,
        GetContainerItemLink = function() return "item:9001" end,
    }
    C_Container, UseContainerItem, GetContainerItemLink = nil, nil, nil
    if api == "legacy" then
        UseContainerItem = container.UseContainerItem
        GetContainerItemLink = container.GetContainerItemLink
    elseif api ~= "missing" then
        C_Container = container
    end
    hooksecurefunc = function(owner, name, callback)
        if type(owner) == "string" then state.hooks.use = name
        else state.hooks.use = callback end
    end
    GetNumLootItems = function() return #state.slots end
    GetLootSourceInfo = function() return state.guid, 1 end
    GetLootSlotLink = function(slot) return "item:" .. state.slots[slot].id end
    GetLootSlotInfo = function(slot)
        local item = state.slots[slot]
        return nil, item.name or "Test Output", item.qty, nil, nil, nil, false, nil
    end
    for _, file in ipairs({ "Core", "Database", "Exporter", "LocationTracker",
        "GatheringTracker", "DisenchantTracker", "LootTracker" }) do
        assert(loadfile("addon/ForeverDB/" .. file .. ".lua"))("ForeverDB", FDB)
    end
    FDB:InitializeDatabase()
    FDB:InitializeGatheringTracker()
    FDB:InitializeDisenchantTracker()
    FDB:InitializeLootTracker()
    function state:startDisenchant()
        self:event("CURSOR_CHANGED")
        assert(self.hooks.use, "container hook absent")(0, 1)
    end
    return FDB, state
end

local function test(name, run)
    local ok, err = pcall(run)
    print = consolePrint
    if not ok then error(name .. ": " .. tostring(err)) end
    passed = passed + 1
    consolePrint("PASS (simulated): " .. name)
end

test("herbalism identity, item aggregation, status/last and export", function()
    local f, s = setup()
    s.guid = "GameObject-0-0-0-0-1618-0001"
    s.slots = { { id = 2447, qty = 2 }, { id = 2447, qty = 1 }, { id = 765, qty = 1 } }
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 2366)
    s:event("LOOT_READY")
    s:event("LOOT_READY") -- same open window must not count twice
    local b = f.DB.sources["gameobject:1618"].buckets.herbalism
    equal(b.observations, 1)
    equal(b.items["2447"].drops, 1)
    equal(b.items["2447"].quantity, 3)
    equal(b.items["765"].quantity, 1)
    equal(f.DB.lastObservation.itemKinds, 2)
    equal(f.DB.lastObservation.totalQuantity, 4)
    equal(f.DB.lastObservation.location.x, 42)
    equal(f.DB.lastObservation.location.y, 33.5)
    equal(f.PendingGathering, nil)
    equal(f:GetDatabaseStats().unresolvedLootWindows, 0)
    f:PrintStatus(); f:PrintLastObservation()
    contains(table.concat(s.messages, "\n"), "herbalism: 1")
    contains(table.concat(s.messages, "\n"), "last: herbalism gameobject 1618")
    contains(ForeverDB_Export, "B|gameobject|1618|0|herbalism|1")
    contains(ForeverDB_Export, "I|gameobject|1618|0|herbalism|2447|Test Output|1|3|0|")
    local x, y = ForeverDB_Export:match(
        "L|gameobject|1618|0|herbalism|42|Test Zone|Test Subzone|([^|]+)|([^|]+)|1")
    equal(tonumber(x), 42)
    equal(tonumber(y), 33.5)
    -- Reopening the same physical GameObject instance must not create
    -- another observation or duplicate already-seen outputs.
    s:event("LOOT_CLOSED")
    s.slots = { { id = 765, qty = 1 } }
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast2", 2366)
    s:event("LOOT_READY")
    equal(b.observations, 1)
    equal(b.items["2447"].drops, 1)
    equal(b.items["2447"].quantity, 3)
    equal(b.items["765"].drops, 1)
    equal(b.items["765"].quantity, 1)
    contains(
        table.concat(s.messages, "\n"),
        "duplicate gathering source skipped GameObject-0-0-0-0-1618-0001"
    )

    -- A different physical node with the same GameObject type ID must still
    -- count as a fresh observation.
    s:event("LOOT_CLOSED")
    s.guid = "GameObject-0-0-0-0-1618-0002"
    s.slots = { { id = 2447, qty = 2 } }
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast3", 2366)
    s:event("LOOT_READY")
    equal(b.observations, 2)
    equal(b.items["2447"].drops, 2)
    equal(b.items["2447"].quantity, 5)
end)

test("herbalism expires; unrelated object is not an herb", function()
    local f, s = setup()
    s:event("UNIT_SPELLCAST_SUCCEEDED", "party1", "cast", 2366)
    equal(f.PendingGathering, nil)
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 2366)
    s.now = 113
    equal(f:GetPendingGathering(), nil)
    equal(f:GetLootKind("gameobject", "GameObject-0-0-0-0-9-0001", "Chest"), "chest")
    equal(f:GetDatabaseStats().sourceCount, 0)
end)

test("unresolved herb loot increments diagnostics, not observations", function()
    local f, s = setup()
    s.slots = { { id = 2447, qty = 1 } }
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 2366)
    s:event("LOOT_READY")
    equal(f:GetDatabaseStats().unresolvedLootWindows, 1)
    equal(f:GetDatabaseStats().sourceCount, 0)
    equal(f.DB.lastObservation, nil)
end)

test("disenchant combined-bag path captures target from item lock without cursor spell ID", function()
    local f, s = setup("modern")
    s.cursorSpellId = nil
    s.spellCanTargetItem = true
    s.slots = { { id = 10940, qty = 2 } }

    s:event("CURSOR_CHANGED")
    s:event("ITEM_LOCK_CHANGED", 0, 1)
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 13262)
    s:event("LOOT_READY")

    local b = f.DB.sources["item:9001"].buckets.disenchant
    equal(b.observations, 1)
    equal(b.items["10940"].quantity, 2)
    equal(f.ActiveDisenchant, nil)
    contains(
        table.concat(s.messages, "\n"),
        "disenchant cursor detected item-target"
    )
    contains(
        table.concat(s.messages, "\n"),
        "disenchant target 9001 Test Input via item-lock"
    )
    contains(
        table.concat(s.messages, "\n"),
        "disenchant armed 9001"
    )
end)

for _, api in ipairs({ "modern", "legacy" }) do
    test("disenchant " .. api .. " hook to item source/export", function()
        local f, s = setup(api)
        s.slots = { { id = 10940, qty = 2 }, { id = 10940, qty = 1 } }
        s:startDisenchant()
        s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 13262)
        s:event("LOOT_READY")
        s:event("LOOT_READY")
        local b = f.DB.sources["item:9001"].buckets.disenchant
        equal(b.observations, 1)
        equal(b.items["10940"].drops, 1)
        equal(b.items["10940"].quantity, 3)
        equal(next(b.locations), nil)
        equal(f.DB.sources["item:10940"], nil)
        equal(f.ActiveDisenchant, nil)
        equal(f.DB.lastObservation.sourceLevel, 0)
        equal(f.DB.lastObservation.totalQuantity, 3)
        f:PrintStatus(); f:PrintLastObservation()
        contains(table.concat(s.messages, "\n"), "disenchant: 1")
        contains(table.concat(s.messages, "\n"), "last: disenchant item 9001 Test Input")
        contains(ForeverDB_Export, "B|item|9001|0|disenchant|1")
        contains(ForeverDB_Export, "I|item|9001|0|disenchant|10940|Test Output|1|3|0|")
        -- In-memory save preparation is testable; real disk persistence is not.
        f:PrepareForSave()
        equal(ForeverDB_Saved.sources["item:9001"].buckets.disenchant.observations, 1)
        s:event("LOOT_CLOSED")
        s:startDisenchant()
        s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast2", 13262)
        s:event("LOOT_READY")
        equal(b.observations, 2)
        equal(b.items["10940"].quantity, 6)
    end)
end

test("failed/interrupted disenchant clears attribution", function()
    for _, event in ipairs({ "UNIT_SPELLCAST_FAILED", "UNIT_SPELLCAST_INTERRUPTED" }) do
        local f, s = setup()
        s:startDisenchant()
        s:event(event, "player", "cast", 13262)
        equal(f.PendingDisenchant, nil)
        equal(f:GetActiveDisenchant(), nil)
        equal(f.DisenchantCursorActiveAt, nil)
        s.guid = "GameObject-0-0-0-0-1618-0001"
        s.slots = { { id = 2447, qty = 1 } }
        s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 2366)
        s:event("LOOT_READY")
        equal(f.DB.lastObservation.kind, "herbalism")
        equal(f:GetDatabaseStats().byKind.disenchant, nil)
    end
end)

test("missing/expired disenchant targets never arm", function()
    local f, s = setup()
    f:ArmDisenchant()
    equal(f:GetActiveDisenchant(), nil)
    s:startDisenchant()
    s.now = 113
    f:ArmDisenchant()
    equal(f:GetActiveDisenchant(), nil)
    s:startDisenchant()
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 13262)
    s.now = 134
    equal(f:GetActiveDisenchant(), nil)
    equal(f:GetDatabaseStats().sourceCount, 0)
end)

test("missing container API does not create a target", function()
    local f, s = setup("missing")
    s:event("CURSOR_CHANGED")
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 13262)
    equal(f.PendingDisenchant, nil)
    equal(f:GetActiveDisenchant(), nil)
    equal(f:GetDatabaseStats().sourceCount, 0)
end)

consolePrint(passed .. " simulated checks passed; live WoW E2E remains PENDING")
