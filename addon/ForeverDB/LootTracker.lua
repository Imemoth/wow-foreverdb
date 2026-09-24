local _, FDB = ...

local lootFrame

local function npcIdFromGuid(guid)
    if type(guid) ~= "string" then return nil end
    local unitType, _, _, _, _, npcId = strsplit("-", guid)
    if unitType ~= "Creature" and unitType ~= "Vehicle" then return nil end
    return tonumber(npcId)
end

local function itemIdFromLink(link)
    if type(link) ~= "string" then return nil end
    return tonumber(link:match("item:(%d+)"))
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
            FDB.ActiveLootMode = nil
        end
    end)
end

function FDB:CaptureLootWindow()
    local mode = self.ActiveLootMode == "skinning" and "skinning" or "normal"
    local seenSources = {}

    for slot = 1, GetNumLootItems() do
        local link = GetLootSlotLink(slot)
        local itemId = itemIdFromLink(link)

        if itemId then
            local _, _, quantity = GetLootSlotInfo(slot)
            local sourceInfo = { GetLootSourceInfo(slot) }

            for i = 1, #sourceInfo, 2 do
                local guid = sourceInfo[i]
                local sourceQuantity = tonumber(sourceInfo[i + 1]) or quantity or 1
                local npcId = npcIdFromGuid(guid)

                if npcId then
                    seenSources[guid] = npcId
                    self:RecordItem(mode, npcId, nil, itemId, sourceQuantity)
                end
            end
        end
    end

    -- Observation counting is deliberately conservative for the alpha.
    -- We only increment sources that Forever exposes through loot-source data.
    for _, npcId in pairs(seenSources) do
        local mob = self:GetOrCreateMob(npcId)
        if mob and mob[mode] then
            mob[mode].observations = mob[mode].observations + 1
        end
    end

    self:Debug("captured", mode, "loot window")
end
