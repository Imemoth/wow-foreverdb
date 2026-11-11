local _, FDB = ...

local lootFrame
local lootWindowCaptured = false
local lootWindowOpenedAt
local recentGatheringSources = {}
local GATHERING_INSTANCE_DEDUP_SECONDS = 600
local CORRELATED_GATHERING_LOOT_WINDOW_SECONDS = 4

local CHEST_WORDS = {
    "chest",
    "coffer",
    "footlocker",
    "strongbox",
    "cache",
    "treasure",
    "crate",
    "trunk",
}


local function isGatheringKind(kind)
    return kind == "herbalism"
        or kind == "mining"
        or kind == "skinning"
end

local function pruneRecentGatheringSources(current)
    for guid, capturedAt in pairs(recentGatheringSources) do
        if current - capturedAt > GATHERING_INSTANCE_DEDUP_SECONDS then
            recentGatheringSources[guid] = nil
        end
    end
end

local function wasGatheringSourceCaptured(sourceGuid, kind)
    if not sourceGuid or not isGatheringKind(kind) then
        return false
    end

    local current = GetTime and GetTime() or 0
    pruneRecentGatheringSources(current)

    local capturedAt = recentGatheringSources[sourceGuid]
    return capturedAt ~= nil
        and current - capturedAt <= GATHERING_INSTANCE_DEDUP_SECONDS
end

local function markGatheringSourceCaptured(sourceGuid, kind)
    if not sourceGuid or not isGatheringKind(kind) then
        return
    end

    local current = GetTime and GetTime() or 0
    pruneRecentGatheringSources(current)
    recentGatheringSources[sourceGuid] = current
end

local function itemIdFromLink(link)
    if type(link) ~= "string" then return nil end
    return tonumber(link:match("item:(%d+)"))
end

local function classifyGameObject(name)
    local lower = string.lower(name or "")

    if string.find(lower, "fishing bobber", 1, true)
        or string.find(lower, "bobber", 1, true) then
        return "fishing"
    end

    for _, word in ipairs(CHEST_WORDS) do
        if string.find(lower, word, 1, true) then
            return "chest"
        end
    end
    return "gameobject"
end


local function fallbackZoneId(name)
    local h = 5381
    local mod = 2147483647

    for i = 1, #(name or "") do
        h = (h * 131 + string.byte(name, i)) % mod
    end

    if h == 0 then h = 1 end
    return -h
end

local function getFishingZoneSource()
    local mapId
    local zoneName

    if C_Map and C_Map.GetBestMapForUnit then
        mapId = C_Map.GetBestMapForUnit("player")

        if mapId and C_Map.GetMapInfo then
            local info = C_Map.GetMapInfo(mapId)
            if info and info.name and info.name ~= "" then
                zoneName = info.name
            end
        end
    end

    if not zoneName or zoneName == "" then
        if GetZoneText then
            zoneName = GetZoneText()
        end
    end

    if (not zoneName or zoneName == "") and GetRealZoneText then
        zoneName = GetRealZoneText()
    end

    if not zoneName or zoneName == "" then
        zoneName = "Unknown zone"
    end

    if not mapId then
        mapId = fallbackZoneId(zoneName)
    end

    return "fishing", mapId, zoneName
end

local function getSourceGuidFromLoot()
    if not GetLootSourceInfo then return nil, false, false end

    local sources = {}
    local hasUnrecognized = false

    for slot = 1, GetNumLootItems() do
        local sourceInfo = { GetLootSourceInfo(slot) }

        for i = 1, #sourceInfo, 2 do
            local guid = sourceInfo[i]
            local sourceType, sourceId = FDB:ParseSourceGuid(guid)

            if sourceType and sourceId then
                sources[guid] = true
            elseif guid ~= nil then
                hasUnrecognized = true
            end
        end
    end

    local guid
    local count = 0
    for candidate in pairs(sources) do
        guid = candidate
        count = count + 1
    end
    return count == 1 and guid or nil, count > 1 or hasUnrecognized, count == 1 and not hasUnrecognized
end

local function safeCall(fn, ...)
    if type(fn) ~= "function" then return nil end
    local ok, value = pcall(fn, ...)
    return ok and value or nil
end

local function getLootInteractionZone()
    if not (C_Map and C_Map.GetBestMapForUnit and C_Map.GetMapInfo
        and C_Map.GetPlayerMapPosition) then
        return nil
    end

    local mapId = safeCall(C_Map.GetBestMapForUnit, "player")
    if type(mapId) ~= "number" or mapId <= 0 then return nil end

    local mapInfo = safeCall(C_Map.GetMapInfo, mapId)
    if type(mapInfo) ~= "table"
        or tonumber(mapInfo.mapID) ~= mapId
        or type(mapInfo.name) ~= "string"
        or mapInfo.name == ""
        or type(mapInfo.mapType) ~= "number"
        or type(mapInfo.parentMapID) ~= "number"
        or mapInfo.parentMapID <= 0 then
        return nil
    end

    local zoneMapType = Enum and Enum.UIMapType and Enum.UIMapType.Zone or 3
    if mapInfo.mapType ~= zoneMapType then return nil end
    local parentInfo = safeCall(C_Map.GetMapInfo, mapInfo.parentMapID)
    if type(parentInfo) ~= "table"
        or tonumber(parentInfo.mapID) ~= mapInfo.parentMapID
        or type(parentInfo.name) ~= "string"
        or parentInfo.name == "" then
        return nil
    end

    local zoneName = safeCall(GetZoneText)
    if type(zoneName) ~= "string" or zoneName == "" or zoneName ~= mapInfo.name then
        return nil
    end

    -- Confirm this is a usable coordinate map without retaining the player's
    -- point as a source location.
    local position = safeCall(C_Map.GetPlayerMapPosition, mapId, "player")
    if position == nil then return nil end
    local x, y
    local ok, getter = pcall(function() return position.GetXY end)
    if ok and type(getter) == "function" then
        ok, x, y = pcall(getter, position)
    else
        ok, x, y = pcall(function() return position.x, position.y end)
    end
    if not ok or type(x) ~= "number" or type(y) ~= "number"
        or x < 0 or x > 1 or y < 0 or y > 1 then
        return nil
    end

    return { mapId = mapId, zoneName = zoneName }
end

local function sameInteractionZone(first, second)
    return first ~= nil and second ~= nil
        and first.mapId == second.mapId
        and first.zoneName == second.zoneName
end

local function resolveLootInteractionZone(sourceGuid, directSource, ambiguousSource,
    before, after, pending, captureStartedAt, stalePending, openedAt)
    local capturedAt = GetTime and GetTime() or captureStartedAt
    if not directSource or ambiguousSource or not sourceGuid
        or stalePending
        or not sameInteractionZone(before, after)
        or not capturedAt or capturedAt < captureStartedAt then
        return nil
    end

    if pending then
        if pending.guid and pending.guid ~= sourceGuid then return nil end
        local pendingLocation = pending.location
        if not pendingLocation
            or tonumber(pendingLocation.mapId) ~= before.mapId
            or pendingLocation.zoneName ~= before.zoneName then
            return nil
        end

        if pending.guid then
            return {
                class = "verified_interaction_zone",
                mapId = before.mapId,
                zoneName = before.zoneName,
                evidence = "loot_event",
            }
        end

        local sentLocation = pending.sentLocation
        local succeededLocation = pending.succeededLocation
        local succeededAt = tonumber(pending.succeededAt)
        if not pending.correlated
            or not sentLocation
            or not succeededLocation
            or not succeededAt
            or capturedAt < succeededAt
            or capturedAt - succeededAt > CORRELATED_GATHERING_LOOT_WINDOW_SECONDS
            or (openedAt ~= nil and (openedAt < succeededAt
                or openedAt - succeededAt > CORRELATED_GATHERING_LOOT_WINDOW_SECONDS))
            or tonumber(sentLocation.mapId) ~= before.mapId
            or sentLocation.zoneName ~= before.zoneName
            or tonumber(succeededLocation.mapId) ~= before.mapId
            or succeededLocation.zoneName ~= before.zoneName then
            return nil
        end

        return {
            class = "correlated_interaction_zone",
            mapId = before.mapId,
            zoneName = before.zoneName,
            evidence = "cast_loot_correlation",
        }
    end

    return {
        class = "verified_interaction_zone",
        mapId = before.mapId,
        zoneName = before.zoneName,
        evidence = "loot_event",
    }
end

local function getFallbackGuid()
    local npcGuid = UnitGUID and UnitGUID("npc")
    local npcType, npcId = FDB:ParseSourceGuid(npcGuid)
    if npcType == "gameobject" and npcId then
        return npcGuid
    end

    local targetGuid = UnitGUID and UnitGUID("target")
    local targetType, targetId = FDB:ParseSourceGuid(targetGuid)
    if targetType == "creature" and targetId then
        if not UnitIsDeadOrGhost or UnitIsDeadOrGhost("target") then
            return targetGuid
        end
    end

    return nil
end

local function resolveSourceName(guid, sourceType)
    local name = FDB:GetSourceNameFromGuid(guid)
    if name and name ~= "" then return name end

    if sourceType == "creature" then
        if UnitGUID("target") == guid then
            return UnitName("target")
        end
    elseif sourceType == "gameobject" then
        if UnitGUID("npc") == guid then
            return UnitName("npc")
        end
    end

    return nil
end

local function quantizeCoordinate(value)
    if not value then return nil end

    local percent = value * 100
    return math.floor(percent * 2 + 0.5) / 2
end

local function getCurrentLocation()
    local mapId
    local zoneName
    local subZoneName
    local x
    local y

    if C_Map and C_Map.GetBestMapForUnit then
        mapId = C_Map.GetBestMapForUnit("player")
    end

    if GetZoneText then
        zoneName = GetZoneText()
    end

    if GetSubZoneText then
        subZoneName = GetSubZoneText()
    end

    if (not zoneName or zoneName == "") and mapId and C_Map and C_Map.GetMapInfo then
        local info = C_Map.GetMapInfo(mapId)
        if info and info.name and info.name ~= "" then
            zoneName = info.name
        end
    end

    if mapId and C_Map and C_Map.GetPlayerMapPosition then
        local position = C_Map.GetPlayerMapPosition(mapId, "player")
        if position then
            local px
            local py

            if position.GetXY then
                px, py = position:GetXY()
            else
                px = position.x
                py = position.y
            end

            if px and py and px >= 0 and py >= 0 then
                x = quantizeCoordinate(px)
                y = quantizeCoordinate(py)
            end
        end
    end

    if not mapId and (not zoneName or zoneName == "") then
        return nil
    end

    return {
        mapId = mapId or 0,
        zoneName = zoneName or "Unknown zone",
        subZoneName = subZoneName or "",
        x = x,
        y = y,
    }
end

local function collectItems()
    local items = {}

    for slot = 1, GetNumLootItems() do
        local link = GetLootSlotLink(slot)
        local itemId = itemIdFromLink(link)

        if itemId then
            local _, itemName, quantity, _, _, _, isQuestItem, questId =
                GetLootSlotInfo(slot)

            local observed = items[itemId]
            if not observed then
                observed = {
                    itemId = itemId,
                    name = itemName,
                    quantity = 0,
                    isQuestItem = false,
                    questId = nil,
                }
                items[itemId] = observed
            end

            observed.quantity =
                observed.quantity + (tonumber(quantity) or 1)

            if itemName and itemName ~= "" then
                observed.name = itemName
            end

            local questFlag = isQuestItem and true or false
            local trackedId
            if FDB.IdentifyQuestLoot then
                questFlag, trackedId = FDB:IdentifyQuestLoot(
                    itemId, questFlag, questId
                )
            end
            if questFlag then
                observed.isQuestItem = true
                if trackedId and trackedId > 0 then
                    observed.questId = trackedId
                elseif type(questId) == "number" and questId > 0 then
                    observed.questId = questId
                end
            end
        end
    end

    return items
end

function FDB:GetLootKind(sourceType, sourceGuid, sourceName)
    local pending = self:GetPendingGatheringKind(sourceGuid)

    if sourceType == "creature" then
        if pending == "skinning" then
            return "skinning"
        end
        return "mob"
    end

    if sourceType == "gameobject" then
        if pending == "mining" or pending == "herbalism" then
            return pending
        end
        return classifyGameObject(sourceName)
    end

    return "unknown"
end

function FDB:CaptureLootWindow()
    if lootWindowCaptured then return end
    lootWindowCaptured = true

    local sourceGuid
    local sourceType
    local sourceId
    local sourceName
    local kind
    local location
    local observedLevel
    local directSource = false
    local ambiguousSource = false
    local interactionZoneBefore
    local pending
    local originalSourceType
    local originalSourceId
    local captureStartedAt = GetTime and GetTime() or 0
    local pendingBefore = self.PendingGathering
    local stalePending = pendingBefore ~= nil
        and captureStartedAt - (tonumber(pendingBefore.at) or captureStartedAt) > 12

    local disenchant =
        self.GetActiveDisenchant
        and self:GetActiveDisenchant()

    if disenchant then
        sourceType = "item"
        sourceId = disenchant.itemId
        sourceName =
            disenchant.name
            or ("Item " .. tostring(disenchant.itemId))
        kind = "disenchant"
    else
        interactionZoneBefore = getLootInteractionZone()
        local lootSourceGuid
        lootSourceGuid, ambiguousSource, directSource = getSourceGuidFromLoot()
        sourceGuid = lootSourceGuid
        if not sourceGuid and not ambiguousSource then
            sourceGuid = getFallbackGuid()
        end

        sourceType, sourceId =
            self:ParseSourceGuid(sourceGuid)

        if not sourceType or not sourceId then
            self:RegisterUnresolvedLootWindow()
            self:Debug(
                "loot unresolved; slots:",
                GetNumLootItems()
            )
            return
        end
        originalSourceType, originalSourceId = sourceType, sourceId

        sourceName =
            resolveSourceName(
                sourceGuid,
                sourceType
            )

        kind =
            self:GetLootKind(
                sourceType,
                sourceGuid,
                sourceName
            )

        local pool =
            self.GetActiveFishingPool
            and self:GetActiveFishingPool()

        if pool
            and sourceType == "gameobject" then
            kind = "fishing_pool"
            sourceType = "gameobject"
            sourceId = pool.sourceId
            sourceName = pool.name
            location =
                pool.location
                or self:GetProjectedInteractionLocation(15)
        elseif kind == "fishing" then
            sourceType, sourceId, sourceName =
                getFishingZoneSource()
        end

        pending =
            self.GetPendingGathering
            and self:GetPendingGathering()

        if not location then
            location =
                pending and pending.location
                or self:GetCurrentLocation()
        end

        if sourceType == "creature" then
            if UnitGUID("target") == sourceGuid
                and UnitLevel then
                local level = UnitLevel("target")
                if level and level > 0 then
                    observedLevel = level
                end
            end

            if not observedLevel
                and pending
                and pending.sourceLevel then
                observedLevel = pending.sourceLevel
            end
        end
    end

    if wasGatheringSourceCaptured(sourceGuid, kind) then
        self:Debug(
            kind,
            "duplicate gathering source skipped",
            sourceGuid
        )
        self:ConsumePendingGatheringKind(kind)
        return
    end

    local items = collectItems()
    local interactionZoneAfter = getLootInteractionZone()
    local interactionAttribution
    if sourceType == originalSourceType and sourceId == originalSourceId then
        interactionAttribution = resolveLootInteractionZone(
            sourceGuid, directSource, ambiguousSource,
            interactionZoneBefore, interactionZoneAfter,
            pending, captureStartedAt, stalePending, lootWindowOpenedAt
        )
    end

    self:RecordObservation(
        kind,
        sourceType,
        sourceId,
        sourceName,
        items,
        observedLevel,
        location,
        interactionAttribution
    )

    local itemKinds = 0
    local questKinds = 0

    for _, item in pairs(items) do
        itemKinds = itemKinds + 1
        if item.isQuestItem then
            questKinds = questKinds + 1
        end
    end

    self:Debug(
        "captured",
        kind,
        sourceType,
        sourceId,
        sourceName or "",
        "items",
        itemKinds,
        "quest",
        questKinds,
        "level",
        observedLevel or "?"
    )

    markGatheringSourceCaptured(sourceGuid, kind)
    self:ConsumePendingGatheringKind(kind)

    if kind == "fishing_pool"
        and self.ConsumeActiveFishingPool then
        self:ConsumeActiveFishingPool()
    elseif kind == "disenchant"
        and self.ConsumeActiveDisenchant then
        self:ConsumeActiveDisenchant()
    end
end

function FDB:InitializeLootTracker()
    if lootFrame then return end

    lootFrame = CreateFrame("Frame")
    lootFrame:RegisterEvent("LOOT_READY")
    lootFrame:RegisterEvent("LOOT_OPENED")
    lootFrame:RegisterEvent("LOOT_CLOSED")

    lootFrame:SetScript("OnEvent", function(_, event)
        if event == "LOOT_OPENED" then
            -- LOOT_OPENED can precede populated source/slot data. Treat it as
            -- the start of the same bounded interaction window and capture on
            -- LOOT_READY, when loot-source APIs are available.
            lootWindowOpenedAt = GetTime and GetTime() or 0
        elseif event == "LOOT_READY" then
            FDB:CaptureLootWindow()
        elseif event == "LOOT_CLOSED" then
            lootWindowCaptured = false
            lootWindowOpenedAt = nil
        end
    end)
end
