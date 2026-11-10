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
        mapId = 42,
        parentMapId = 1,
        zoneName = "Test Zone",
        mapName = "Test Zone",
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
    ForeverDB_ForkArchive = {}
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
    UnitGUID = function(unit)
        return (unit == "npc" or unit == "target") and state.guid or nil
    end
    UnitName = function() return "Test Herb Node" end
    UnitNameFromGUID = function() return "Test Herb Node" end
    GetZoneText = function() return state.zoneName end
    GetSubZoneText = function() return "Test Subzone" end
    C_Map = {
        GetBestMapForUnit = function() return state.mapId end,
        GetMapInfo = function(mapId)
            if mapId == state.mapId then
                return { mapID = mapId, name = state.mapName, mapType = 3, parentMapID = state.parentMapId }
            end
            if mapId == state.parentMapId then
                return { mapID = mapId, name = "Fixture Continent", mapType = 2, parentMapID = 0 }
            end
            return nil
        end,
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
    GetLootSourceInfo = function(slot)
        if state.lootSources then
            local source = state.lootSources[slot]
            if source then return source, 1 end
        end
        if state.afterLootSourceRead then
            local callback = state.afterLootSourceRead
            state.afterLootSourceRead = nil
            callback()
        end
        return state.guid, 1
    end
    GetLootSlotLink = function(slot) return "item:" .. state.slots[slot].id end
    GetLootSlotInfo = function(slot)
        local item = state.slots[slot]
        return nil, item.name or "Test Output", item.qty, nil, nil, nil, false, nil
    end
    for _, file in ipairs({ "Core", "Database", "Exporter", "GeoDiagnostics", "LocationTracker",
        "GatheringTracker", "SkinningTracker", "DisenchantTracker", "LootTracker" }) do
        assert(loadfile("addon/ForeverDB/" .. file .. ".lua"))("ForeverDB", FDB)
    end
    FDB:InitializeDatabase()
    FDB:InitializeGatheringTracker()
    FDB:InitializeSkinningTracker()
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
    local interactionZone = f.DB.geographicStats.interactionZone
        .zones["42|Test Zone"].sources["gameobject:1618"].buckets.herbalism
    equal(interactionZone.observations, 1)
    equal(interactionZone.items["2447"].drops, 1)
    equal(interactionZone.items["2447"].quantity, 3)
    equal(interactionZone.items["765"].drops, 1)
    equal(interactionZone.locations, nil)
    equal(f.DB.geographicStats.unknown.sources["gameobject:1618"], nil)
    equal(f.DB.snapshotRevision, 2)
    equal(f.PendingGathering, nil)
    equal(f:GetDatabaseStats().unresolvedLootWindows, 0)
    f:PrintStatus(); f:PrintLastObservation()
    contains(table.concat(s.messages, "\n"), "herbalism: 1")
    contains(table.concat(s.messages, "\n"), "last: herbalism gameobject 1618")
    contains(ForeverDB_Export, "B|gameobject|1618|0|herbalism|1")
    contains(ForeverDB_Export, "I|gameobject|1618|0|herbalism|2447|Test Output|1|3|0|")
    contains(ForeverDB_Export, "Q|1|2")
    contains(ForeverDB_Export, "Z|interaction_zone|42|Test Zone|gameobject|1618|0|herbalism|1|loot_event")
    contains(ForeverDB_Export, "Y|interaction_zone|42|Test Zone|gameobject|1618|0|herbalism|2447|Test Output|1|3|0|")
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

test("same-second observations advance the persisted snapshot revision", function()
    local f = setup()
    local before = f.DB.snapshotRevision
    equal(f.DB.updatedAt, 1100)

    f:RecordObservation("mob", "creature", 123, "Test Creature", {
        [501] = { name = "Test Item", quantity = 1 },
    }, 10, nil)
    equal(f.DB.updatedAt, 1100)
    equal(f.DB.snapshotRevision, before + 1)

    f:RecordObservation("mob", "creature", 123, "Test Creature", {
        [501] = { name = "Test Item", quantity = 1 },
    }, 10, nil)
    equal(f.DB.updatedAt, 1100)
    equal(f.DB.snapshotRevision, before + 2)
    contains(ForeverDB_Export, "Q|1|3")
end)

test("legacy observations are not retroactively copied into geographic counters", function()
    local f = setup()
    ForeverDB_Saved = {
        schemaVersion = 9,
        installationId = "legacy-installation",
        updatedAt = 900,
        sources = {
            ["creature:987:12"] = {
                sourceType = "creature",
                sourceId = 987,
                sourceLevel = 12,
                name = "Historical Creature",
                buckets = {
                    mob = {
                        observations = 17,
                        items = {
                            ["654"] = {
                                itemId = 654,
                                name = "Historical Item",
                                drops = 4,
                                quantity = 6,
                                questDrops = 0,
                                questIds = {},
                            },
                        },
                    },
                },
            },
        },
    }

    f:InitializeDatabase()
    f:BuildExportSnapshot()
    equal(f.DB.sources["creature:987:12"].buckets.mob.observations, 17)
    equal(next(f.DB.geographicStats.unknown.sources), nil)
    equal(f.DB.snapshotRevision, 1)
    equal(ForeverDB_Export:find("Z|unknown|creature|987|12|mob", 1, true), nil)
end)

test("fork archives history locally and starts a new installation with zero counters", function()
    local f = setup()
    f:RecordObservation("mob", "creature", 987, "Historical Creature", {
        [654] = { name = "Historical Item", quantity = 2 },
    }, 12, nil)
    f.DB.guildbookCapture = { captureId = "local-guildbook-marker", capturedAt = 1001 }
    f.DB.guilds = { legacy = { name = "Local Guild" } }
    local oldId = f.DB.installationId
    local oldSources = f.DB.sources

    local ok, newId = f:ForkInstallation()
    equal(ok, true)
    assert(newId and newId ~= oldId, "fork must create a new installation identity")
    equal(ForeverDB_ForkArchive[oldId].snapshot.sources, oldSources)
    equal(ForeverDB_ForkArchive[oldId].snapshot.sources["creature:987:12"].buckets.mob.observations, 1)
    equal(f.DB.installationId, newId)
    equal(next(f.DB.sources), nil)
    equal(next(f.DB.geographicStats.unknown.sources), nil)
    equal(f.DB.snapshotRevision, 1)
    equal(f.DB.guildbookCapture, nil)
    equal(next(f.DB.guilds), nil)
    equal(ForeverDB_Export:find("Historical Creature", 1, true), nil)
    equal(ForeverDB_Export:find("Local Guild", 1, true), nil)
end)

test("installation fork requires the explicit slash-command confirmation", function()
    local f, s = setup()
    f:RecordObservation("mob", "creature", 987, "Historical Creature", {
        [654] = { name = "Historical Item", quantity = 2 },
    }, 12, nil)
    local oldId = f.DB.installationId
    local shown
    StaticPopup_Show = function(dialog) shown = dialog end
    for _, name in ipairs({
        "InitializeDatabase", "InitializeSessionTracker", "InitializeSessionUI",
        "InitializeGuildApiProbe", "InitializeQuestApiProbe", "InitializeQuestKillTracker",
        "InitializeQuestTracker", "InitializeGuildbookTracker", "InitializeGatheringTracker",
        "InitializeSkinningTracker", "InitializeFishingPoolTracker", "InitializeDisenchantTracker",
        "InitializeLootTracker", "InitializeTooltip",
    }) do f[name] = function() end end
    s:event("ADDON_LOADED", "ForeverDB")
    local revisionBeforeDiagnostics = f.DB.snapshotRevision
    local exportBeforeDiagnostics = ForeverDB_Export
    SlashCmdList.FOREVERDB("geodiag")
    contains(table.concat(s.messages, "\n"), "local geography diagnostics (read-only; no reset or sync)")
    equal(f.DB.snapshotRevision, revisionBeforeDiagnostics)
    equal(ForeverDB_Export, exportBeforeDiagnostics)
    SlashCmdList.FOREVERDB("fork")
    equal(shown, "FOREVERDB_CONFIRM_INSTALLATION_FORK")
    equal(f.DB.installationId, oldId)
    equal(ForeverDB_ForkArchive[oldId], nil)
    StaticPopupDialogs[shown].OnAccept()
    assert(f.DB.installationId ~= oldId, "accepting confirmation starts a fresh identity")
    equal(ForeverDB_ForkArchive[oldId].snapshot.installationId, oldId)
end)

test("restored counters without their installation ID are held until an empty fork", function()
    local f = setup()
    ForeverDB_Saved = {
        schemaVersion = 9,
        updatedAt = 900,
        sources = {
            ["creature:111:8"] = {
                sourceType = "creature", sourceId = 111, sourceLevel = 8,
                name = "Restored mob", buckets = { mob = { observations = 8, items = {} } },
            },
        },
    }
    f:InitializeDatabase()
    equal(f.DB.installationRecoveryRequired, true)
    equal(f.DB.installationId, nil)
    equal(f:BuildExportSnapshot(), "")
    equal(f.DB.sources["creature:111:8"].buckets.mob.observations, 8)
    local ok, newId = f:ForkInstallation()
    equal(ok, true)
    assert(newId and newId ~= "", "confirmed fork creates a new identity")
    assert(next(ForeverDB_ForkArchive) ~= nil, "restored counters are retained in the local fork archive")
    equal(next(f.DB.sources), nil)
end)

test("synthetic observations without eligible interaction-zone evidence remain Unknown", function()
    local f = setup()
    local cases = {
        { "mob", "creature", 11, 4 },
        { "skinning", "creature", 12, 5 },
        { "herbalism", "gameobject", 13, 0 },
        { "mining", "gameobject", 14, 0 },
        { "fishing", "gameobject", 15, 0 },
    }
    for _, case in ipairs(cases) do
        f:RecordObservation(case[1], case[2], case[3], "Synthetic source", {
            [700] = { name = "Synthetic item", quantity = 2 },
        }, case[4], nil)
        local key = f:SourceKey(case[2], case[3], case[4])
        local bucket = f.DB.geographicStats.unknown.sources[key].buckets[case[1]]
        equal(f.DB.sources[key].buckets[case[1]].observations, 1)
        equal(bucket.observations, 1)
        equal(bucket.items["700"].quantity, 2)
        equal(bucket.locations, nil)
        contains(ForeverDB_Export, "Z|unknown|" .. case[2] .. "|" .. case[3])
    end
end)

test("creature loot on map 1420 records only a verified Tirisfal interaction zone", function()
    local f, s = setup()
    s.mapId = 1420
    s.zoneName = "Tirisfal Glades"
    s.mapName = "Tirisfal Glades"
    s.guid = "Creature-0-0-0-0-656160-0001"
    s.slots = { { id = 700, qty = 1 } }
    s:event("LOOT_READY")

    local zone = f.DB.geographicStats.interactionZone.zones["1420|Tirisfal Glades"]
    local bucket = zone.sources["creature:656160:0"].buckets.mob
    equal(bucket.observations, 1)
    equal(bucket.items["700"].quantity, 1)
    equal(bucket.locations, nil)
    equal(f.DB.geographicStats.unknown.sources["creature:656160:0"], nil)
    contains(ForeverDB_Export, "Z|interaction_zone|1420|Tirisfal Glades|creature|656160|0|mob|1|loot_event")
    assert(not ForeverDB_Export:find("1420|Tirisfal Glades|creature|656160|0|mob|.*40", 1),
        "interaction-zone records do not contain player coordinates")
end)

test("source-matched skinning records interaction-zone totals without source coordinates", function()
    local f, s = setup()
    s.guid = "Creature-0-0-0-0-300-0001"
    s.slots = { { id = 700, qty = 1 } }
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 8613)
    s:event("LOOT_READY")
    local bucket = f.DB.geographicStats.interactionZone.zones["42|Test Zone"]
        .sources["creature:300:0"].buckets.skinning
    equal(bucket.observations, 1)
    equal(bucket.locations, nil)
end)

test("loot interaction remains Unknown for alias conflict or map transition", function()
    local cases = {
        { name = "zone/map disagreement", configure = function(s)
            s.mapId = 1420; s.zoneName = "Crusader's Outpost"; s.mapName = "Tirisfal Glades"
        end },
        { name = "map transition", configure = function(s)
            s.afterLootSourceRead = function() s.mapId = 1430; s.zoneName = "Silverpine Forest"; s.mapName = "Silverpine Forest" end
        end },
    }
    for _, case in ipairs(cases) do
        local f, s = setup()
        s.mapId = 1420; s.zoneName = "Tirisfal Glades"; s.mapName = "Tirisfal Glades"
        s.guid = "Creature-0-0-0-0-656160-0001"
        if #s.slots == 0 then s.slots = { { id = 700, qty = 1 } } end
        case.configure(s)
        s:event("LOOT_READY")
        local unknown = f.DB.geographicStats.unknown.sources["creature:656160:0"]
        assert(unknown and unknown.buckets.mob.observations == 1,
            case.name .. " must fail closed to Unknown; unknown=" .. tostring(unknown)
                .. ", unresolved=" .. tostring(f.DB.diagnostics.unresolvedLootWindows))
        assert(next(f.DB.geographicStats.interactionZone.zones) == nil,
            case.name .. " unexpectedly created an interaction-zone bucket")
    end
end)

test("multiple loot source GUIDs remain unresolved instead of being guessed", function()
    local f, s = setup()
    s.mapId = 1420; s.zoneName = "Tirisfal Glades"; s.mapName = "Tirisfal Glades"
    s.slots = { { id = 700, qty = 1 }, { id = 701, qty = 1 } }
    s.lootSources = {
        "Creature-0-0-0-0-656160-0001",
        "Creature-0-0-0-0-656161-0001",
    }
    s:event("LOOT_READY")
    equal(f:GetDatabaseStats().sourceCount, 0)
    equal(f:GetDatabaseStats().unresolvedLootWindows, 1)
    assert(next(f.DB.geographicStats.interactionZone.zones) == nil)
    assert(next(f.DB.geographicStats.unknown.sources) == nil)
end)

test("invalid normalized coordinates make the interaction map unusable and leave loot Unknown", function()
    local f, s = setup()
    s.mapId = 1420; s.zoneName = "Tirisfal Glades"; s.mapName = "Tirisfal Glades"
    s.guid = "Creature-0-0-0-0-656160-0001"
    s.slots = { { id = 700, qty = 1 } }
    C_Map.GetPlayerMapPosition = function() return { x = 1.01, y = 0.5 } end
    s:event("LOOT_READY")
    equal(f.DB.geographicStats.unknown.sources["creature:656160:0"].buckets.mob.observations, 1)
    assert(next(f.DB.geographicStats.interactionZone.zones) == nil)
end)

test("mismatched gathering source remains Unknown instead of inheriting herb classification", function()
    local f, s = setup()
    s.guid = "GameObject-0-0-0-0-1618-0001"
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 2366)
    s.guid = "GameObject-0-0-0-0-1619-0001"
    s.slots = { { id = 2447, qty = 1 } }
    s:event("LOOT_READY")
    equal(f.DB.sources["gameobject:1619"].buckets.gameobject.observations, 1)
    assert(next(f.DB.geographicStats.interactionZone.zones) == nil)
    equal(f.DB.geographicStats.unknown.sources["gameobject:1619"].buckets.gameobject.observations, 1)
end)

test("expired gathering context cannot classify or geographically attribute later loot", function()
    local f, s = setup()
    s.guid = "GameObject-0-0-0-0-1618-0001"
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 2366)
    s.now = 113
    s.slots = { { id = 2447, qty = 1 } }
    s:event("LOOT_READY")
    equal(f.DB.sources["gameobject:1618"].buckets.gameobject.observations, 1)
    equal(f.DB.geographicStats.unknown.sources["gameobject:1618"].buckets.gameobject.observations, 1)
    assert(next(f.DB.geographicStats.interactionZone.zones) == nil)
end)

test("legacy herbalism totals are not backfilled; a new loot event is still explicitly classified", function()
    local f, s = setup()
    f.DB.sources["gameobject:1618"] = {
        sourceType = "gameobject", sourceId = 1618, sourceLevel = 0,
        buckets = { herbalism = { observations = 94, items = {}, locations = {} } },
    }
    s.guid = "GameObject-0-0-0-0-1618-0001"
    s.slots = { { id = 2447, qty = 1 } }
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "cast", 2366)
    s:event("LOOT_READY")
    equal(f.DB.sources["gameobject:1618"].buckets.herbalism.observations, 95)
    equal(f.DB.geographicStats.unknown.sources["gameobject:1618"], nil)
    equal(f.DB.geographicStats.interactionZone.zones["42|Test Zone"]
        .sources["gameobject:1618"].buckets.herbalism.observations, 1)
    f:PrintGeographyDiagnostics()
    contains(table.concat(s.messages, "\n"), "herbalism events: 95 unknown: 0 interaction-zone: 1 source-map: 0 player-context-only: 0 legacy/unclassified: 94")
end)

test("malformed geographic SavedVariables recover before global observation counters change", function()
    local f = setup()
    f.DB.geographicStats.unknown.sources = "invalid"
    f.DB.geographicStats.interactionZone.zones = false
    assert(f:RecordObservation("herbalism", "gameobject", 1618, "Herb", {
        [2447] = { name = "Peacebloom", quantity = 1 },
    }, 0, nil))
    equal(f.DB.sources["gameobject:1618"].buckets.herbalism.observations, 1)
    equal(f.DB.geographicStats.unknown.sources["gameobject:1618"].buckets.herbalism.observations, 1)
end)

test("geography diagnostics expose counts and candidate APIs without changing SavedVariables or export", function()
    local f, s = setup()
    s.guid = "Creature-0-0-0-0-7000-0001"
    UnitGUID = function(unit)
        return (unit == "target" or unit == "npc") and s.guid or nil
    end
    f:RecordObservation("mob", "creature", 7000, "Synthetic mob", {
        [700] = { name = "Synthetic item", quantity = 1 },
    }, 7, { mapId = 42, zoneName = "Fixture", x = 40, y = 50 })
    local beforeRevision = f.DB.snapshotRevision
    local beforeUpdatedAt = f.DB.updatedAt
    local beforeSaved = f.DB.sources["creature:7000:7"].buckets.mob.observations
    local beforeExport = ForeverDB_Export
    f:PrintGeographyDiagnostics()
    local report = table.concat(s.messages, "\n")
    contains(report, "revision:")
    contains(report, "mob events: 1 unknown: 1 interaction-zone: 0 source-map: 0 player-context-only: 1 legacy/unclassified: 0 no-location-context: 0")
    contains(report, "api candidate target recognized source guid: creature")
    contains(report, "candidate only; not source-map proof")
    equal(f.DB.snapshotRevision, beforeRevision)
    equal(f.DB.updatedAt, beforeUpdatedAt)
    equal(f.DB.sources["creature:7000:7"].buckets.mob.observations, beforeSaved)
    equal(ForeverDB_Export, beforeExport)
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

test("disenchant stale item-target candidate cannot leak into later disenchant", function()
    local f, s = setup("modern")
    s.cursorSpellId = nil
    s.spellCanTargetItem = true

    -- Generic item-target fallback captures a candidate for another spell.
    s:event("CURSOR_CHANGED")
    s:event("ITEM_LOCK_CHANGED", 0, 1)
    equal(f.PendingDisenchant.itemId, 9001)

    -- Cursor end must invalidate that candidate before a later Disenchant.
    s.spellCanTargetItem = false
    s:event("CURSOR_CHANGED")
    equal(f.PendingDisenchant, nil)
    equal(f.DisenchantCursorActiveAt, nil)

    s.cursorSpellId = 13262
    s:event("CURSOR_CHANGED")
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "disenchant-cast", 13262)
    equal(f:GetActiveDisenchant(), nil)

    -- Also cover a non-Disenchant item-target flow that completes while the
    -- generic cursor is still active.
    f, s = setup("modern")
    s.cursorSpellId = nil
    s.spellCanTargetItem = true
    s:event("CURSOR_CHANGED")
    s:event("ITEM_LOCK_CHANGED", 0, 1)
    equal(f.PendingDisenchant.itemId, 9001)

    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "enchant-cast", 7418)
    equal(f.PendingDisenchant, nil)
    equal(f.DisenchantCursorActiveAt, nil)

    s.cursorSpellId = 13262
    s.spellCanTargetItem = false
    s:event("CURSOR_CHANGED")
    s:event("UNIT_SPELLCAST_SUCCEEDED", "player", "disenchant-cast", 13262)
    equal(f:GetActiveDisenchant(), nil)
    equal(f:GetDatabaseStats().sourceCount, 0)

    contains(
        table.concat(s.messages, "\n"),
        "disenchant item-target candidate cleared"
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
