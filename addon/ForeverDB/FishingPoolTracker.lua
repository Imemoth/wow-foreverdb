local _, FDB = ...

local poolFrame
local tooltipElapsed = 0

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

local function isSecretValue(value)
    if not issecretvalue then
        return false
    end

    local ok, secret = pcall(issecretvalue, value)
    return ok and secret or false
end

local function isReadableString(value)
    return type(value) == "string"
        and not isSecretValue(value)
end

local function getTooltipFirstLine(tooltip)
    if tooltip and tooltip.GetLeftLine then
        local line = tooltip:GetLeftLine(1)
        if line and line.GetText then
            return line:GetText()
        end
    end

    if tooltip and tooltip.GetName then
        local tooltipName = tooltip:GetName()

        if isReadableString(tooltipName) then
            local line = _G[tooltipName .. "TextLeft1"]
            if line and line.GetText then
                return line:GetText()
            end
        end
    end
end

local function isFishingPoolName(name)
    if not isReadableString(name) then
        return false
    end

    local lower = string.lower(name)

    for _, word in ipairs(POOL_WORDS) do
        if string.find(lower, word, 1, true) then
            return true
        end
    end

    return false
end

local function syntheticPoolId(name, mapId)
    local safeName =
        isReadableString(name)
        and name
        or "unknown pool"

    local seed =
        tostring(mapId or 0)
        .. "|"
        .. string.lower(safeName)

    local h = 5381
    local mod = 2147483647

    for i = 1, #seed do
        h = (h * 131 + string.byte(seed, i)) % mod
    end

    if h == 0 then h = 1 end
    return -h
end

local OBJECT_TOOLTIP_TYPE =
    Enum
    and Enum.TooltipDataType
    and Enum.TooltipDataType.Object
    or 4

local function getWorldCursorObjectGuid()
    if not (C_TooltipInfo and C_TooltipInfo.GetWorldCursor) then
        return nil, false
    end

    local ok, data =
        pcall(C_TooltipInfo.GetWorldCursor)

    if not ok or not data then
        return nil, false
    end

    local dataType = data.type

    if dataType ~= nil then
        if isSecretValue(dataType) then
            return nil, false
        end

        if dataType ~= OBJECT_TOOLTIP_TYPE then
            return nil, false
        end
    end

    local guid = data.guid

    if isReadableString(guid) then
        local sourceType = FDB:ParseSourceGuid(guid)

        if sourceType == "gameobject" then
            return guid, true
        end
    end

    -- The structured tooltip itself still identifies a world Object even
    -- when its GUID is absent or restricted. A readable pool name may still
    -- be used to build a short-lived synthetic source ID.
    return nil, dataType == OBJECT_TOOLTIP_TYPE
end

function FDB:RememberFishingPoolHover(name, worldCursorGuid)
    local restrictedName =
        type(name) == "string"
        and isSecretValue(name)

    if not restrictedName
        and not isFishingPoolName(name) then
        return
    end

    local guid = worldCursorGuid
    local sourceType, sourceId = self:ParseSourceGuid(guid)

    -- Forever 1.60.1 can expose world-tooltip text as a Secret Value on a
    -- tainted addon path. Such text cannot be compared or lowercased.
    -- If a real GameObject GUID is available, retain it only as a short-lived
    -- fishing-cast candidate and use a generic non-secret display name.
    if restrictedName
        and (sourceType ~= "gameobject" or not sourceId) then
        return
    end

    local location = self:GetProjectedInteractionLocation(15)
    local storedName =
        restrictedName
        and "Fishing Pool"
        or name

    if sourceType ~= "gameobject" or not sourceId then
        sourceId = syntheticPoolId(
            storedName,
            location and location.mapId
        )
        guid = nil
    end

    self.LastFishingPoolHover = {
        name = storedName,
        guid = guid,
        sourceId = sourceId,
        location = location,
        at = GetTime and GetTime() or 0,
        restrictedName = restrictedName,
    }

    local now = GetTime and GetTime() or 0
    local castAt = self.LastFishingCastAt

    if castAt and now - castAt <= 35 then
        self.ActiveFishingPool = {
            name = storedName,
            guid = guid,
            sourceId = sourceId,
            location =
                self:GetProjectedInteractionLocation(15)
                or location,
            at = castAt,
        }
    end

    self:Debug(
        restrictedName
            and "fishing pool hover (restricted tooltip name)"
            or "fishing pool hover",
        storedName,
        sourceId,
        location and location.x or "?",
        location and location.y or "?"
    )
end

function FDB:ArmFishingPoolForCast()
    local hover = self.LastFishingPoolHover
    local now = GetTime and GetTime() or 0

    self.LastFishingCastAt = now

    local maxHoverAge =
        hover and hover.restrictedName
        and 2
        or 8

    if hover
        and now - (hover.at or 0) <= maxHoverAge then
        self.ActiveFishingPool = {
            name = hover.name,
            guid = hover.guid,
            sourceId = hover.sourceId,
            location =
                self:GetProjectedInteractionLocation(15)
                or hover.location,
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
    self.LastFishingCastAt = nil
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
                local guid, isWorldObject =
                    getWorldCursorObjectGuid()

                if not isWorldObject then
                    return
                end

                local name = getTooltipFirstLine(tooltip)
                FDB:RememberFishingPoolHover(name, guid)
            end
        )

        -- World-object tooltips can change while the tooltip frame remains
        -- visible. A light throttle keeps the latest pool/location fresh,
        -- matching the behavior expected from gathering-style addons.
        GameTooltip:HookScript(
            "OnUpdate",
            function(tooltip, elapsed)
                tooltipElapsed =
                    tooltipElapsed + (tonumber(elapsed) or 0)

                if tooltipElapsed < 0.5 then
                    return
                end

                tooltipElapsed = 0

                local guid, isWorldObject =
                    getWorldCursorObjectGuid()

                if not isWorldObject then
                    return
                end

                local name = getTooltipFirstLine(tooltip)
                FDB:RememberFishingPoolHover(name, guid)
            end
        )
    end
end
