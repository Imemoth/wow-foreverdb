local _, FDB = ...

local function quantizeCoordinate(value)
    if value == nil then return nil end

    local percent = value * 100
    return math.floor(percent * 2 + 0.5) / 2
end

local function readVector(position)
    if not position then return nil, nil end

    if position.GetXY then
        return position:GetXY()
    end

    return position.x, position.y
end

function FDB:GetCurrentLocation()
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

    if (not zoneName or zoneName == "")
        and mapId
        and C_Map
        and C_Map.GetMapInfo then
        local info = C_Map.GetMapInfo(mapId)
        if info and info.name and info.name ~= "" then
            zoneName = info.name
        end
    end

    if mapId
        and C_Map
        and C_Map.GetPlayerMapPosition then
        local position =
            C_Map.GetPlayerMapPosition(mapId, "player")

        local px, py = readVector(position)

        if px and py and px >= 0 and py >= 0 then
            x = quantizeCoordinate(px)
            y = quantizeCoordinate(py)
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

function FDB:GetProjectedInteractionLocation(distanceYards)
    local location = self:GetCurrentLocation()

    if not location
        or not location.mapId
        or location.mapId == 0
        or not location.x
        or not location.y then
        return location
    end

    if not C_Map
        or not C_Map.GetWorldPosFromMapPos
        or not C_Map.GetMapPosFromWorldPos
        or not GetPlayerFacing then
        return location
    end

    local facing = GetPlayerFacing()
    if not facing then return location end

    local mapPosition = {
        x = location.x / 100,
        y = location.y / 100,
    }

    local continentId, worldPosition =
        C_Map.GetWorldPosFromMapPos(
            location.mapId,
            mapPosition
        )

    if not continentId or not worldPosition then
        return location
    end

    local wx, wy = readVector(worldPosition)
    if not wx or not wy then return location end

    local distance = tonumber(distanceYards) or 0

    -- WoW facing is 0=north and increases counter-clockwise.
    -- World coordinates are inverted relative to the normalized map axes,
    -- therefore north/west add to world Y/X respectively.
    local projectedWorld = {
        x = wx + math.sin(facing) * distance,
        y = wy + math.cos(facing) * distance,
    }

    local projectedMapId, projectedPosition =
        C_Map.GetMapPosFromWorldPos(
            continentId,
            projectedWorld,
            location.mapId
        )

    if projectedMapId ~= location.mapId
        or not projectedPosition then
        return location
    end

    local px, py = readVector(projectedPosition)

    if not px
        or not py
        or px < 0
        or py < 0
        or px > 1
        or py > 1 then
        return location
    end

    location.x = quantizeCoordinate(px)
    location.y = quantizeCoordinate(py)
    return location
end
