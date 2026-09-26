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
        sources = {},
        maps = {},
        guilds = {},
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
    db.updatedAt = now()
    db.sources = db.sources or {}
    db.maps = db.maps or {}
    db.guilds = db.guilds or {}
    db.diagnostics = db.diagnostics or {}
    db.diagnostics.unresolvedLootWindows = db.diagnostics.unresolvedLootWindows or 0

    self.DB = db
    self:EnsureInstallationId()
end

function FDB:PrepareForSave()
    if not self.DB then return end
    self.DB.updatedAt = now()
    self.DB.addonVersion = self.VERSION
    self.DB.schemaVersion = self.SCHEMA_VERSION
    self:EnsureInstallationId()
    self:BuildExportSnapshot()
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

function FDB:RecordObservation(kind, sourceType, sourceId, sourceName, observedItems, observedLevel, location)
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
    self.DB.updatedAt = timestamp
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

    if self.BuildExportSnapshot then
        self:BuildExportSnapshot()
    end

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
