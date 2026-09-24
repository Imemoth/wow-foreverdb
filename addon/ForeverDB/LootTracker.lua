local _, FDB = ...

local lootFrame
local lootWindowCaptured = false

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
    if not GetLootSourceInfo then return nil end

    for slot = 1, GetNumLootItems() do
        local sourceInfo = { GetLootSourceInfo(slot) }

        for i = 1, #sourceInfo, 2 do
            local guid = sourceInfo[i]
            local sourceType, sourceId = FDB:ParseSourceGuid(guid)

            if sourceType and sourceId then
                return guid
            end
        end
    end

    return nil
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

            if isQuestItem then
                observed.isQuestItem = true
                if questId and questId > 0 then
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
        sourceGuid =
            getSourceGuidFromLoot()
            or getFallbackGuid()

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

        local pending =
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

    local items = collectItems()

    self:RecordObservation(
        kind,
        sourceType,
        sourceId,
        sourceName,
        items,
        observedLevel,
        location
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
    lootFrame:RegisterEvent("LOOT_CLOSED")

    lootFrame:SetScript("OnEvent", function(_, event)
        if event == "LOOT_READY" then
            FDB:CaptureLootWindow()
        elseif event == "LOOT_CLOSED" then
            lootWindowCaptured = false
        end
    end)
end
