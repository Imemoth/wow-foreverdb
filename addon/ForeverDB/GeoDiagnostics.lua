local _, FDB = ...

local COLLECTOR_KINDS = {
    "mob", "skinning", "herbalism", "mining", "fishing", "fishing_pool",
}

local function safeSourceType(guid)
    if issecretvalue then
        local secretOk, secret = pcall(issecretvalue, guid)
        if secretOk and secret then return nil end
    end
    if type(guid) ~= "string" then return nil end
    local ok, sourceType = pcall(function()
        return FDB:ParseSourceGuid(guid)
    end)
    return ok and sourceType or nil
end

local function safeMapForUnit(unit)
    if not (C_Map and C_Map.GetBestMapForUnit) then return nil end
    local ok, mapId = pcall(C_Map.GetBestMapForUnit, unit)
    if ok and type(mapId) == "number" and mapId > 0 then return mapId end
    return nil
end

local function worldCursorEvidence()
    if not (C_TooltipInfo and C_TooltipInfo.GetWorldCursor) then
        return "API unavailable"
    end
    local ok, isObject, guid = pcall(function()
        local data = C_TooltipInfo.GetWorldCursor()
        if not data then return false, nil end
        local dataType = data.type
        if issecretvalue then
            local secretOk, secret = pcall(issecretvalue, dataType)
            if secretOk and secret then return false, nil end
        end
        local objectType = Enum and Enum.TooltipDataType and Enum.TooltipDataType.Object or 4
        if dataType ~= nil and dataType ~= objectType then return false, nil end
        return true, data.guid
    end)
    if not ok or not isObject then return "no readable object candidate" end
    if safeSourceType(guid) == "gameobject" then
        return "readable gameobject GUID candidate"
    end
    return "object candidate; no readable gameobject GUID"
end

local function bucketObservationTotals(sources, kind)
    local total = 0
    for _, source in pairs(sources or {}) do
        local bucket = source.buckets and source.buckets[kind]
        total = total + (bucket and tonumber(bucket.observations) or 0)
    end
    return total
end

local function bucketLocationTotals(sources, kind)
    local total = 0
    for _, source in pairs(sources or {}) do
        local bucket = source.buckets and source.buckets[kind]
        for _, location in pairs(bucket and bucket.locations or {}) do
            total = total + (tonumber(location.observations) or 0)
        end
    end
    return total
end

function FDB:PrintGeographyDiagnostics()
    local db = self.DB
    if not db then
        print("ForeverDB geography diagnostics: database unavailable")
        return
    end

    local globalSources = db.sources or {}
    local unknownSources = db.geographicStats
        and db.geographicStats.unknown
        and db.geographicStats.unknown.sources or {}

    print("ForeverDB local geography diagnostics (read-only; no reset or sync)")
    print("revision:", tonumber(db.snapshotRevision) or 1,
        "updatedAt:", tonumber(db.updatedAt) or 0,
        "saved schema:", tonumber(db.schemaVersion) or 0)
    print("evidence classes are conservative: source-map verified=0; interaction-context is not source attribution")

    for _, kind in ipairs(COLLECTOR_KINDS) do
        local observations = bucketObservationTotals(globalSources, kind)
        if observations > 0 then
            local unknown = bucketObservationTotals(unknownSources, kind)
            local interaction = math.min(unknown, bucketLocationTotals(globalSources, kind))
            local noContext = math.max(0, unknown - interaction)
            print(kind,
                "events:", observations,
                "unknown:", unknown,
                "source-map:", 0,
                "player-context-only:", interaction,
                "no-location-context:", noContext)
        end
    end

    -- This probe prints only API availability, source type and candidate map IDs.
    -- Unit identity, coordinates, names and tooltip text are never displayed or saved.
    local units = { "player", "target", "npc", "mouseover" }
    for _, unit in ipairs(units) do
        local guid
        if UnitGUID then
            local ok, value = pcall(UnitGUID, unit)
            if ok then guid = value end
        end
        local sourceType = safeSourceType(guid)
        local candidateMap = safeMapForUnit(unit)
        print("api candidate", unit,
            "recognized source guid:", sourceType or "no",
            "unit map:", candidateMap or "unavailable",
            "(candidate only; not source-map proof)")
    end

    print("world-cursor evidence:", worldCursorEvidence(),
        "(GUID and tooltip text are not displayed; candidate only)")
end
