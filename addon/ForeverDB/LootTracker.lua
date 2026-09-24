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
    for _, word in ipairs(CHEST_WORDS) do
        if string.find(lower, word, 1, true) then
            return "chest"
        end
    end
    return "gameobject"
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

    local sourceGuid = getSourceGuidFromLoot() or getFallbackGuid()
    local sourceType, sourceId = self:ParseSourceGuid(sourceGuid)

    if not sourceType or not sourceId then
        self:RegisterUnresolvedLootWindow()
        self:Debug("loot unresolved; slots:", GetNumLootItems())
        return
    end

    local sourceName = resolveSourceName(sourceGuid, sourceType)
    local kind = self:GetLootKind(sourceType, sourceGuid, sourceName)
    local items = collectItems()

    self:RecordObservation(
        kind,
        sourceType,
        sourceId,
        sourceName,
        items
    )

    local itemKinds = 0
    local questKinds = 0
    for _, item in pairs(items) do
        itemKinds = itemKinds + 1
        if item.isQuestItem then questKinds = questKinds + 1 end
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
        questKinds
    )

    self:ConsumePendingGatheringKind(kind)
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
