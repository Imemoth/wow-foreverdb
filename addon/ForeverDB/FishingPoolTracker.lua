local _, FDB = ...

local poolFrame

local POOL_WORDS = {
    "school",
    "pool",
    "wreckage",
    "oil spill",
    "pure water",
    "floating debris",
    "floating wreckage",
    "waterlogged wreckage",
    "elemental water",
}

local FISHING_SPELL_IDS = {
    [7620] = true,
    [7731] = true,
    [7732] = true,
    [18248] = true,
}

local function getSpellName(spellId)
    if C_Spell and C_Spell.GetSpellName then
        return C_Spell.GetSpellName(spellId)
    end
    if GetSpellInfo then
        return GetSpellInfo(spellId)
    end
end

local function isFishingSpell(spellId)
    if FISHING_SPELL_IDS[spellId] then
        return true
    end

    return getSpellName(spellId) == "Fishing"
end

local function getTooltipFirstLine(tooltip)
    if tooltip and tooltip.GetLeftLine then
        local line = tooltip:GetLeftLine(1)
        if line and line.GetText then
            return line:GetText()
        end
    end

    if tooltip and tooltip.GetName then
        local name = tooltip:GetName()
        local line = name and _G[name .. "TextLeft1"]
        if line and line.GetText then
            return line:GetText()
        end
    end
end

local function isFishingPoolName(name)
    local lower = string.lower(name or "")

    for _, word in ipairs(POOL_WORDS) do
        if string.find(lower, word, 1, true) then
            return true
        end
    end

    return false
end

local function syntheticPoolId(name, mapId)
    local seed =
        tostring(mapId or 0)
        .. "|"
        .. string.lower(name or "unknown pool")

    local h = 5381
    local mod = 2147483647

    for i = 1, #seed do
        h = (h * 131 + string.byte(seed, i)) % mod
    end

    if h == 0 then h = 1 end
    return -h
end

local function getWorldCursorGuid()
    if C_TooltipInfo and C_TooltipInfo.GetWorldCursor then
        local data = C_TooltipInfo.GetWorldCursor()
        if data and data.guid then
            return data.guid
        end
    end

    local guid = UnitGUID and UnitGUID("npc")
    local sourceType = FDB:ParseSourceGuid(guid)

    if sourceType == "gameobject" then
        return guid
    end
end

function FDB:RememberFishingPoolHover(name)
    if not isFishingPoolName(name) then return end

    local guid = getWorldCursorGuid()
    local sourceType, sourceId = self:ParseSourceGuid(guid)
    local location = self:GetProjectedInteractionLocation(15)

    if sourceType ~= "gameobject" or not sourceId then
        sourceId = syntheticPoolId(
            name,
            location and location.mapId
        )
        guid = nil
    end

    self.LastFishingPoolHover = {
        name = name,
        guid = guid,
        sourceId = sourceId,
        location = location,
        at = GetTime and GetTime() or 0,
    }

    self:Debug(
        "fishing pool hover",
        name,
        sourceId,
        location and location.x or "?",
        location and location.y or "?"
    )
end

function FDB:ArmFishingPoolForCast()
    local hover = self.LastFishingPoolHover
    local now = GetTime and GetTime() or 0

    if hover
        and now - (hover.at or 0) <= 8 then
        self.ActiveFishingPool = {
            name = hover.name,
            guid = hover.guid,
            sourceId = hover.sourceId,
            location = hover.location,
            at = now,
        }
    else
        self.ActiveFishingPool = nil
    end
end

function FDB:GetActiveFishingPool()
    local pool = self.ActiveFishingPool
    if not pool then return nil end

    local now = GetTime and GetTime() or pool.at
    if now - (pool.at or 0) > 35 then
        self.ActiveFishingPool = nil
        return nil
    end

    return pool
end

function FDB:ConsumeActiveFishingPool()
    self.ActiveFishingPool = nil
end

function FDB:InitializeFishingPoolTracker()
    if poolFrame then return end

    poolFrame = CreateFrame("Frame")
    poolFrame:RegisterEvent("UNIT_SPELLCAST_SUCCEEDED")

    poolFrame:SetScript(
        "OnEvent",
        function(_, _, unitTarget, _, spellId)
            if unitTarget ~= "player"
                or not isFishingSpell(spellId) then
                return
            end

            FDB:ArmFishingPoolForCast()
        end
    )

    if GameTooltip and GameTooltip.HookScript then
        GameTooltip:HookScript(
            "OnShow",
            function(tooltip)
                local name = getTooltipFirstLine(tooltip)
                if name and name ~= "" then
                    FDB:RememberFishingPoolHover(name)
                end
            end
        )
    end
end
