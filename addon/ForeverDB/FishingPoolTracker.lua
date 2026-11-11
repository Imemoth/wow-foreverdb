local _, FDB = ...

local poolFrame
local tooltipElapsed = 0
local FISHING_CORRELATION_WINDOW_SECONDS = 5

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

local function fishingSpellFromEvent(...)
    for index = 1, select("#", ...) do
        local value = select(index, ...)
        if type(value) == "number" and isFishingSpell(value) then
            return true
        elseif type(value) == "string" and value == "Fishing" then
            return true
        end
    end
    return false
end

local function getFishingCastGuid(value)
    if type(value) ~= "string" then return nil end
    if issecretvalue then
        local ok, secret = pcall(issecretvalue, value)
        if not ok or secret then return nil end
    end
    -- Older client event tuples can place the spell name in the argument
    -- position used by newer CastGUID-based APIs. Only retain a real token.
    local ok, isCastGuid = pcall(string.match, value, "^Cast%-")
    return ok and isCastGuid and value or nil
end

local function getFishingInteractionZone()
    if not (C_Map and C_Map.GetBestMapForUnit and C_Map.GetMapInfo
        and C_Map.GetPlayerMapPosition) then
        return nil
    end

    local ok, mapId = pcall(C_Map.GetBestMapForUnit, "player")
    if not ok or type(mapId) ~= "number" or mapId <= 0 then return nil end

    local infoOk, info = pcall(C_Map.GetMapInfo, mapId)
    if not infoOk or type(info) ~= "table"
        or tonumber(info.mapID) ~= mapId
        or type(info.name) ~= "string" or info.name == ""
        or type(info.mapType) ~= "number"
        or type(info.parentMapID) ~= "number" or info.parentMapID <= 0 then
        return nil
    end

    local zoneType = Enum and Enum.UIMapType and Enum.UIMapType.Zone or 3
    if info.mapType ~= zoneType then return nil end
    local parentOk, parent = pcall(C_Map.GetMapInfo, info.parentMapID)
    if not parentOk or type(parent) ~= "table"
        or tonumber(parent.mapID) ~= info.parentMapID
        or type(parent.name) ~= "string" or parent.name == "" then
        return nil
    end

    local zoneOk, zoneName = pcall(GetZoneText)
    if not zoneOk or zoneName ~= info.name then return nil end

    -- This validates that the map is usable at the interaction, but the
    -- player's coordinates are deliberately neither retained nor attributed.
    local positionOk, position = pcall(C_Map.GetPlayerMapPosition, mapId, "player")
    if not positionOk or not position then return nil end
    local x, y
    local getterOk, getter = pcall(function() return position.GetXY end)
    if getterOk and type(getter) == "function" then
        positionOk, x, y = pcall(getter, position)
    else
        positionOk, x, y = pcall(function() return position.x, position.y end)
    end
    if not positionOk or type(x) ~= "number" or type(y) ~= "number"
        or x < 0 or x > 1 or y < 0 or y > 1 then
        return nil
    end

    return { mapId = mapId, zoneName = zoneName }
end

function FDB:GetPendingFishingCorrelation()
    local pending = self.PendingFishingCorrelation
    if not pending then return nil end
    local now = GetTime and GetTime() or pending.stoppedAt or pending.startedAt
    if pending.state ~= "completed"
        or not pending.zone
        or not pending.stoppedAt
        or now - pending.stoppedAt > FISHING_CORRELATION_WINDOW_SECONDS then
        self.PendingFishingCorrelation = nil
        return nil
    end
    return pending
end

function FDB:ConsumePendingFishingCorrelation()
    self.PendingFishingCorrelation = nil
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
    poolFrame:RegisterEvent("UNIT_SPELLCAST_START")
    poolFrame:RegisterEvent("UNIT_SPELLCAST_CHANNEL_START")
    poolFrame:RegisterEvent("UNIT_SPELLCAST_CHANNEL_STOP")
    poolFrame:RegisterEvent("UNIT_SPELLCAST_FAILED")
    poolFrame:RegisterEvent("UNIT_SPELLCAST_INTERRUPTED")

    poolFrame:SetScript(
        "OnEvent",
        function(_, event, unitTarget, castGuid, spellId, ...)
            if unitTarget ~= "player" then
                return
            end

            local fishingSpell = fishingSpellFromEvent(castGuid, spellId, ...)
            local eventCastGuid = getFishingCastGuid(castGuid)
            local pending = FDB.PendingFishingCorrelation

            if event == "UNIT_SPELLCAST_CHANNEL_START" then
                if not fishingSpell then
                    FDB.PendingFishingCorrelation = nil
                    return
                end

                -- A second distinct operation before the first catch makes
                -- the association ambiguous. Do not choose either cast.
                if pending then
                    if pending.castGuid and eventCastGuid == pending.castGuid
                        and pending.state == "casting" then
                        return -- duplicate start event for this same cast
                    end
                    FDB.PendingFishingCorrelation = nil
                    return
                end

                FDB.PendingFishingCorrelation = {
                    state = "casting",
                    castGuid = eventCastGuid,
                    startedAt = GetTime and GetTime() or 0,
                    zone = getFishingInteractionZone(),
                }
                return
            end

            if event == "UNIT_SPELLCAST_CHANNEL_STOP" then
                if pending and pending.state == "completed"
                    and pending.castGuid and pending.castGuid == eventCastGuid then
                    return -- duplicate stop notification for the same channel
                end
                if not fishingSpell
                    and (not pending or not pending.castGuid
                        or pending.castGuid ~= eventCastGuid) then
                    FDB.PendingFishingCorrelation = nil
                    return
                end
                if not pending or pending.state ~= "casting"
                    or (pending.castGuid and eventCastGuid ~= pending.castGuid)
                    or (not pending.castGuid and eventCastGuid ~= nil) then
                    FDB.PendingFishingCorrelation = nil
                    return
                end
                pending.stoppedAt = GetTime and GetTime() or 0
                if pending.stoppedAt < pending.startedAt then
                    FDB.PendingFishingCorrelation = nil
                    return
                end
                pending.state = "completed"
                local stoppedZone = getFishingInteractionZone()
                if not pending.zone or not stoppedZone
                    or pending.zone.mapId ~= stoppedZone.mapId
                    or pending.zone.zoneName ~= stoppedZone.zoneName then
                    pending.zone = nil
                end
                return
            end

            if event == "UNIT_SPELLCAST_FAILED"
                or event == "UNIT_SPELLCAST_INTERRUPTED" then
                if fishingSpell then FDB.PendingFishingCorrelation = nil end
                return
            end

            if event == "UNIT_SPELLCAST_START" and not fishingSpell then
                -- Any intervening player cast can make a later loot window
                -- unrelated to the completed fishing channel.
                FDB.PendingFishingCorrelation = nil
                return
            end

            if event == "UNIT_SPELLCAST_SUCCEEDED" and fishingSpell then
                FDB:ArmFishingPoolForCast()
            end
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
