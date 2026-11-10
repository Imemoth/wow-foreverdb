local _, FDB = ...

local MOD32 = 4294967296

local function now()
    if GetServerTime then return GetServerTime() end
    return time()
end

local function hashPart(seed, salt)
    local h = (5381 + salt) % MOD32
    for i = 1, #seed do
        h = (h * 131 + string.byte(seed, i) + salt) % MOD32
    end
    return string.format("%08x", h)
end

local function createInstallationId()
    local seed = table.concat({
        tostring(now()),
        tostring(GetTimePreciseSec and GetTimePreciseSec() or GetTime()),
        tostring(debugprofilestop and debugprofilestop() or 0),
        tostring(UnitGUID and UnitGUID("player") or ""),
        tostring({}),
        FDB.VERSION,
    }, "|")

    return hashPart(seed, 17)
        .. hashPart(seed, 97)
        .. hashPart(seed, 193)
        .. hashPart(seed, 389)
end

function FDB:SourceKey(sourceType, sourceId, sourceLevel)
    if sourceType == "creature" then
        return tostring(sourceType)
            .. ":" .. tostring(sourceId)
            .. ":" .. tostring(tonumber(sourceLevel) or 0)
    end

    return tostring(sourceType) .. ":" .. tostring(sourceId)
end

local function newDatabase()
    return {
        schemaVersion = FDB.SCHEMA_VERSION,
        addonVersion = FDB.VERSION,
        installationId = createInstallationId(),
        createdAt = now(),
        updatedAt = now(),
        snapshotRevision = 1,
        sources = {},
        maps = {},
        guilds = {},
        geographicStats = {
            unknown = { sources = {} },
            interactionZone = { zones = {} },
        },
        diagnostics = {
            unresolvedLootWindows = 0,
        },
    }
end

function FDB:ParseSourceGuid(guid)
    if type(guid) ~= "string" then return nil end

    local guidType, _, _, _, _, objectId = strsplit("-", guid)

    if guidType == "Creature" or guidType == "Vehicle" then
        return "creature", tonumber(objectId)
    end

    if guidType == "GameObject" then
        return "gameobject", tonumber(objectId)
    end

    if guidType == "Item" then
        return "item", nil
    end

    return nil
end

function FDB:GetSourceNameFromGuid(guid)
    if type(guid) ~= "string" then return nil end

    if UnitNameFromGUID then
        local name = UnitNameFromGUID(guid)
        if name and name ~= "" and name ~= UNKNOWNOBJECT then
            return name
        end
    end

    return nil
end

function FDB:EnsureInstallationId()
    if not self.DB then return nil end

    if type(self.DB.installationId) ~= "string" or self.DB.installationId == "" then
        local hasHistoricalRows = next(self.DB.sources or {}) ~= nil
            or next(self.DB.guilds or {}) ~= nil
            or next((self.DB.geographicStats and self.DB.geographicStats.unknown
                and self.DB.geographicStats.unknown.sources) or {}) ~= nil
            or type(self.DB.guildbookCapture) == "table"
        if hasHistoricalRows then
            self.DB.installationRecoveryRequired = true
            return nil
        end
        self.DB.installationId = createInstallationId()
    end

    return self.DB.installationId
end

local function migrateV1(db)
    if type(db.sources) == "table" then return end

    db.sources = {}

    for npcKey, mob in pairs(db.mobs or {}) do
        local npcId = tonumber(mob.npcId) or tonumber(npcKey)
        if npcId then
            local key = FDB:SourceKey("creature", npcId, 0)
            db.sources[key] = {
                sourceType = "creature",
                sourceId = npcId,
                sourceLevel = 0,
                name = mob.name,
                firstSeenAt = mob.firstSeenAt or now(),
                lastSeenAt = mob.lastSeenAt or now(),
                buckets = {
                    mob = mob.normal or { observations = 0, items = {} },
                    skinning = mob.skinning or { observations = 0, items = {} },
                },
            }
        end
    end

    db.mobs = nil
end

local function migrateCreatureLevelKeys(db)
    local migrated = {}

    for oldKey, source in pairs(db.sources or {}) do
        if source.sourceType == "creature" then
            local level = tonumber(source.sourceLevel) or 0
            source.sourceLevel = level

            -- Pre-schema-5 records were aggregated across levels. They remain
            -- as level 0 (unknown) because their item counts cannot be split
            -- retrospectively without inventing data.
            local newKey = FDB:SourceKey("creature", source.sourceId, level)
            migrated[newKey] = source
        else
            migrated[oldKey] = source
        end
    end

    db.sources = migrated
end

local function mergeItem(target, oldItem)
    target.drops = (target.drops or 0) + (oldItem.drops or 0)
    target.quantity = (target.quantity or 0) + (oldItem.quantity or 0)
    target.questDrops = (target.questDrops or 0) + (oldItem.questDrops or 0)
    target.questIds = target.questIds or {}

    for questId in pairs(oldItem.questIds or {}) do
        target.questIds[questId] = true
    end
end

local function mergeBucket(target, old)
    target.observations =
        (target.observations or 0) + (old.observations or 0)
    target.items = target.items or {}

    for itemKey, oldItem in pairs(old.items or {}) do
        local item = target.items[itemKey]

        if not item then
            item = {
                itemId = oldItem.itemId,
                name = oldItem.name,
                drops = 0,
                quantity = 0,
                questDrops = 0,
                questIds = {},
            }
            target.items[itemKey] = item
        end

        if oldItem.name and oldItem.name ~= "" then
            item.name = oldItem.name
        end

        mergeItem(item, oldItem)
    end
end

local function migrateFishingZoneSources(db)
    local historicalKey = FDB:SourceKey("fishing", 0, 0)
    local historical = db.sources[historicalKey]

    for key, source in pairs(db.sources or {}) do
        if source.sourceType == "gameobject" then
            local lower = string.lower(source.name or "")
            local isBobber =
                string.find(lower, "fishing bobber", 1, true)
                or string.find(lower, "bobber", 1, true)

            local oldFishing = source.buckets and source.buckets.fishing
            local oldGeneric = source.buckets and source.buckets.gameobject

            if isBobber and (oldFishing or oldGeneric) then
                if not historical then
                    historical = {
                        sourceType = "fishing",
                        sourceId = 0,
                        sourceLevel = 0,
                        name = "Unknown zone (historical)",
                        firstSeenAt = source.firstSeenAt or now(),
                        lastSeenAt = source.lastSeenAt or now(),
                        buckets = {
                            fishing = {
                                observations = 0,
                                items = {},
                            },
                        },
                    }
                    db.sources[historicalKey] = historical
                end

                historical.buckets = historical.buckets or {}
                historical.buckets.fishing =
                    historical.buckets.fishing
                    or { observations = 0, items = {} }

                if oldFishing then
                    mergeBucket(historical.buckets.fishing, oldFishing)
                end

                if oldGeneric then
                    mergeBucket(historical.buckets.fishing, oldGeneric)
                end

                source.buckets.fishing = nil
                source.buckets.gameobject = nil

                local hasBuckets = false
                for _ in pairs(source.buckets or {}) do
                    hasBuckets = true
                    break
                end

                if not hasBuckets then
                    db.sources[key] = nil
                end
            end
        end
    end
end

function FDB:InitializeDatabase()
    if type(ForeverDB_Saved) ~= "table" then
        ForeverDB_Saved = newDatabase()
    end

    local db = ForeverDB_Saved
    migrateV1(db)
    migrateCreatureLevelKeys(db)
    migrateFishingZoneSources(db)

    db.schemaVersion = FDB.SCHEMA_VERSION
    db.addonVersion = FDB.VERSION
    db.createdAt = db.createdAt or now()
    db.updatedAt = db.updatedAt or now()
    db.sources = db.sources or {}
    db.maps = db.maps or {}
    db.guilds = db.guilds or {}
    db.diagnostics = db.diagnostics or {}
    db.diagnostics.unresolvedLootWindows = db.diagnostics.unresolvedLootWindows or 0
    db.snapshotRevision = math.max(1, math.floor(tonumber(db.snapshotRevision) or 1))
    if type(db.geographicStats) ~= "table" then db.geographicStats = {} end
    if type(db.geographicStats.unknown) ~= "table" then
        db.geographicStats.unknown = {}
    end
    if type(db.geographicStats.unknown.sources) ~= "table" then
        db.geographicStats.unknown.sources = {}
    end
    if type(db.geographicStats.interactionZone) ~= "table" then
        db.geographicStats.interactionZone = {}
    end
    if type(db.geographicStats.interactionZone.zones) ~= "table" then
        db.geographicStats.interactionZone.zones = {}
    end

    self.DB = db
    self:EnsureInstallationId()
end

function FDB:PrepareForSave()
    if not self.DB then return end
    self:TouchSnapshot()
    self.DB.addonVersion = self.VERSION
    self.DB.schemaVersion = self.SCHEMA_VERSION
    self:EnsureInstallationId()
    self:BuildExportSnapshot()
end

-- A revision distinguishes snapshots whose second-resolution timestamps match.
-- It changes only when the exported snapshot changes; building/exporting is pure.
function FDB:TouchSnapshot()
    if not self.DB then return end
    self.DB.snapshotRevision = math.max(1, math.floor(tonumber(self.DB.snapshotRevision) or 1)) + 1
    self.DB.updatedAt = now()
    self.DB.addonVersion = self.VERSION
    self.DB.schemaVersion = self.SCHEMA_VERSION
    self:EnsureInstallationId()
    if self.BuildExportSnapshot then self:BuildExportSnapshot() end
end

local function ensureGeoBucket(db, source, kind)
    if type(db.geographicStats) ~= "table" then db.geographicStats = {} end
    if type(db.geographicStats.unknown) ~= "table" then
        db.geographicStats.unknown = {}
    end
    if type(db.geographicStats.unknown.sources) ~= "table" then
        db.geographicStats.unknown.sources = {}
    end
    local unknownSources = db.geographicStats.unknown.sources
    local sourceKey = FDB:SourceKey(source.sourceType, source.sourceId, source.sourceLevel)
    local geoSource = unknownSources[sourceKey]
    if type(geoSource) ~= "table" then
        geoSource = {
            sourceType = source.sourceType,
            sourceId = source.sourceId,
            sourceLevel = source.sourceLevel or 0,
            name = source.name,
            attribution = "source_map_unverified",
            buckets = {},
        }
        unknownSources[sourceKey] = geoSource
    end
    if type(geoSource.buckets) ~= "table" then geoSource.buckets = {} end
    local bucket = geoSource.buckets[kind]
    if type(bucket) ~= "table" then
        bucket = { observations = 0, items = {} }
        geoSource.buckets[kind] = bucket
    end
    bucket.observations = tonumber(bucket.observations) or 0
    if type(bucket.items) ~= "table" then bucket.items = {} end
    return geoSource, bucket
end

local function incrementGeographicItems(bucket, observedItems)
    for itemId, observed in pairs(observedItems or {}) do
        local key = tostring(itemId)
        local item = bucket.items[key]
        if type(item) ~= "table" then
            item = { itemId = tonumber(itemId), drops = 0, quantity = 0, questDrops = 0, questIds = {} }
            bucket.items[key] = item
        end
        item.itemId = item.itemId or tonumber(itemId)
        item.drops = tonumber(item.drops) or 0
        item.quantity = tonumber(item.quantity) or 0
        item.questDrops = tonumber(item.questDrops) or 0
        if type(item.questIds) ~= "table" then item.questIds = {} end
        if observed.name and observed.name ~= "" then item.name = observed.name end
        item.drops = item.drops + 1
        item.quantity = item.quantity + (tonumber(observed.quantity) or 1)
        if observed.isQuestItem then
            item.questDrops = item.questDrops + 1
            if observed.questId and observed.questId > 0 then
                item.questIds[tostring(observed.questId)] = true
            end
        end
    end
end

local function addUnknownObservation(db, source, kind, observedItems)
    local geoSource, bucket = ensureGeoBucket(db, source, kind)
    bucket.observations = bucket.observations + 1
    incrementGeographicItems(bucket, observedItems)
end

local function addInteractionZoneObservation(db, source, kind, observedItems, attribution)
    if type(attribution) ~= "table"
        or attribution.class ~= "verified_interaction_zone"
        or attribution.evidence ~= "loot_event" then
        return false
    end
    local mapId = tonumber(attribution and attribution.mapId)
    local zoneName = attribution and attribution.zoneName
    if not mapId or mapId <= 0 or type(zoneName) ~= "string" or zoneName == "" then
        return false
    end

    if type(db.geographicStats) ~= "table" then db.geographicStats = {} end
    local interactionZone = db.geographicStats.interactionZone
    if type(interactionZone) ~= "table" then
        interactionZone = { zones = {} }
        db.geographicStats.interactionZone = interactionZone
    end
    if type(interactionZone.zones) ~= "table" then
        interactionZone.zones = {}
    end
    local zoneKey = tostring(mapId) .. "|" .. zoneName
    local zone = interactionZone.zones[zoneKey]
    if type(zone) ~= "table" then
        zone = {
            mapId = mapId,
            zoneName = zoneName,
            evidence = "verified_interaction_zone",
            sources = {},
        }
        interactionZone.zones[zoneKey] = zone
    end

    local sourceKey = FDB:SourceKey(source.sourceType, source.sourceId, source.sourceLevel)
    if type(zone.sources) ~= "table" then zone.sources = {} end
    local geoSource = zone.sources[sourceKey]
    if type(geoSource) ~= "table" then
        geoSource = {
            sourceType = source.sourceType,
            sourceId = source.sourceId,
            sourceLevel = source.sourceLevel or 0,
            name = source.name,
            attribution = "verified_interaction_zone",
            buckets = {},
        }
        zone.sources[sourceKey] = geoSource
    end

    if type(geoSource.buckets) ~= "table" then geoSource.buckets = {} end
    local bucket = geoSource.buckets[kind]
    if type(bucket) ~= "table" then
        bucket = { observations = 0, items = {} }
        geoSource.buckets[kind] = bucket
    end
    bucket.observations = tonumber(bucket.observations) or 0
    if type(bucket.items) ~= "table" then bucket.items = {} end
    bucket.observations = bucket.observations + 1
    incrementGeographicItems(bucket, observedItems)
    return true
end

function FDB:ForkInstallation()
    if not self.DB then return false end
    local old = self.DB
    local oldId = self:EnsureInstallationId()
        or ("missing-install-" .. createInstallationId())
    ForeverDB_ForkArchive = ForeverDB_ForkArchive or {}
    if ForeverDB_ForkArchive[oldId] then return false, "installation already archived" end
    ForeverDB_ForkArchive[oldId] = { archivedAt = now(), snapshot = old }
    local fresh = newDatabase()
    fresh.maps = old.maps or {}
    fresh.diagnostics = old.diagnostics or { unresolvedLootWindows = 0 }
    self.DB = fresh
    ForeverDB_Saved = fresh
    self:BuildExportSnapshot()
    return true, fresh.installationId
end

function FDB:GetOrCreateSource(sourceType, sourceId, sourceLevel, name)
    if not self.DB or not sourceType or not sourceId then return nil end

    local normalizedLevel = sourceType == "creature"
        and (tonumber(sourceLevel) or 0)
        or 0

    local key = self:SourceKey(sourceType, sourceId, normalizedLevel)
    local source = self.DB.sources[key]

    if not source then
        source = {
            sourceType = sourceType,
            sourceId = sourceId,
            sourceLevel = normalizedLevel,
            name = name,
            firstSeenAt = now(),
            lastSeenAt = now(),
            buckets = {},
        }
        self.DB.sources[key] = source
    end

    if name and name ~= "" then
        source.name = name
    end

    source.lastSeenAt = now()
    source.buckets = source.buckets or {}
    return source
end

function FDB:RecordObservation(kind, sourceType, sourceId, sourceName, observedItems, observedLevel, location, attribution)
    local source = self:GetOrCreateSource(
        sourceType,
        sourceId,
        observedLevel,
        sourceName
    )
    if not source or not kind then return false end

    local bucket = source.buckets[kind]
    if not bucket then
        bucket = { observations = 0, items = {} }
        source.buckets[kind] = bucket
    end

    bucket.observations = (bucket.observations or 0) + 1
    bucket.items = bucket.items or {}
    bucket.locations = bucket.locations or {}

    if location and location.mapId then
        if self.CaptureMapMetadata then
            self:CaptureMapMetadata(location.mapId)
        end

        local locationKey = table.concat({
            tostring(location.mapId),
            tostring(location.subZoneName or ""),
            tostring(location.x or ""),
            tostring(location.y or ""),
        }, "|")

        local savedLocation = bucket.locations[locationKey]
        if not savedLocation then
            savedLocation = {
                mapId = location.mapId,
                zoneName = location.zoneName,
                subZoneName = location.subZoneName,
                x = location.x,
                y = location.y,
                observations = 0,
            }
            bucket.locations[locationKey] = savedLocation
        end

        savedLocation.observations =
            (savedLocation.observations or 0) + 1
    end

    local itemKinds = 0
    local questItemKinds = 0
    local totalQuantity = 0

    for itemId, observed in pairs(observedItems or {}) do
        itemKinds = itemKinds + 1

        local quantity = tonumber(observed.quantity) or 1
        totalQuantity = totalQuantity + quantity

        if observed.isQuestItem then
            questItemKinds = questItemKinds + 1
        end

        local key = tostring(itemId)
        local item = bucket.items[key]

        if not item then
            item = {
                itemId = tonumber(itemId),
                name = observed.name,
                drops = 0,
                quantity = 0,
                questDrops = 0,
                questIds = {},
            }
            bucket.items[key] = item
        end

        if observed.name and observed.name ~= "" then
            item.name = observed.name
        end

        item.drops = (item.drops or 0) + 1
        item.quantity = (item.quantity or 0) + quantity
        item.questIds = item.questIds or {}

        if observed.isQuestItem then
            item.questDrops = (item.questDrops or 0) + 1
            if observed.questId and observed.questId > 0 then
                item.questIds[tostring(observed.questId)] = true
            end
        end
    end

    local timestamp = now()
    if not addInteractionZoneObservation(self.DB, source, kind, observedItems, attribution) then
        addUnknownObservation(self.DB, source, kind, observedItems)
    end
    self.DB.lastObservation = {
        timestamp = timestamp,
        kind = kind,
        sourceType = sourceType,
        sourceId = sourceId,
        sourceLevel = source.sourceLevel,
        sourceName = source.name,
        itemKinds = itemKinds,
        questItemKinds = questItemKinds,
        totalQuantity = totalQuantity,
        location = location,
    }

    if self.InvalidateItemSourceIndex then
        self:InvalidateItemSourceIndex()
    end

    self:TouchSnapshot()

    return true
end

function FDB:RegisterUnresolvedLootWindow()
    if not self.DB then return end
    self.DB.diagnostics.unresolvedLootWindows =
        (self.DB.diagnostics.unresolvedLootWindows or 0) + 1
end

function FDB:GetDatabaseStats()
    local stats = {
        sourceCount = 0,
        unresolvedLootWindows = 0,
        byKind = {},
    }

    if not self.DB then return stats end

    for _, source in pairs(self.DB.sources or {}) do
        stats.sourceCount = stats.sourceCount + 1
        for kind, bucket in pairs(source.buckets or {}) do
            stats.byKind[kind] =
                (stats.byKind[kind] or 0) + (bucket.observations or 0)
        end
    end

    stats.unresolvedLootWindows =
        (self.DB.diagnostics and self.DB.diagnostics.unresolvedLootWindows) or 0

    return stats
end
