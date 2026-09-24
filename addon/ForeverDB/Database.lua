local _, FDB = ...

local function now()
    return time()
end

local function newDatabase()
    return {
        schemaVersion = FDB.SCHEMA_VERSION,
        addonVersion = FDB.VERSION,
        installationId = nil,
        createdAt = now(),
        updatedAt = now(),
        mobs = {},
        sessions = {},
        pendingBatches = {},
    }
end

local function randomHex(length)
    local out = {}
    for i = 1, length do
        out[i] = string.format("%x", math.random(0, 15))
    end
    return table.concat(out)
end

function FDB:InitializeDatabase()
    if type(ForeverDB_Saved) ~= "table" then
        ForeverDB_Saved = newDatabase()
    end

    local db = ForeverDB_Saved
    db.schemaVersion = db.schemaVersion or FDB.SCHEMA_VERSION
    db.addonVersion = FDB.VERSION
    db.createdAt = db.createdAt or now()
    db.updatedAt = now()
    db.mobs = db.mobs or {}
    db.sessions = db.sessions or {}
    db.pendingBatches = db.pendingBatches or {}

    if not db.installationId then
        math.randomseed(now() + math.floor(GetTime() * 1000))
        db.installationId = randomHex(32)
    end

    self.DB = db
end

function FDB:PrepareForSave()
    if not self.DB then return end
    self.DB.updatedAt = now()
    self.DB.addonVersion = self.VERSION
    self.DB.schemaVersion = self.SCHEMA_VERSION
end

function FDB:GetOrCreateMob(npcId, name)
    if not self.DB or not npcId then return nil end

    local key = tostring(npcId)
    local mob = self.DB.mobs[key]
    if not mob then
        mob = {
            npcId = npcId,
            name = name,
            normal = { observations = 0, items = {} },
            skinning = { observations = 0, items = {} },
            firstSeenAt = now(),
            lastSeenAt = now(),
        }
        self.DB.mobs[key] = mob
    end

    if name and name ~= "" then mob.name = name end
    mob.lastSeenAt = now()
    return mob
end

function FDB:RecordItem(mode, npcId, mobName, itemId, quantity)
    local mob = self:GetOrCreateMob(npcId, mobName)
    if not mob or not itemId then return end

    local bucket = mob[mode]
    if not bucket then return end

    local key = tostring(itemId)
    local item = bucket.items[key]
    if not item then
        item = { itemId = itemId, drops = 0, quantity = 0 }
        bucket.items[key] = item
    end

    item.drops = item.drops + 1
    item.quantity = item.quantity + (quantity or 1)
end
