local _, FDB = ...

local function encode(value)
    local s = tostring(value or "")
    s = s:gsub("%%", "%%25")
    s = s:gsub("|", "%%7C")
    s = s:gsub("\r", "%%0D")
    s = s:gsub("\n", "%%0A")
    s = s:gsub(",", "%%2C")
    return s
end

local function sortedKeys(source)
    local keys = {}
    for key in pairs(source or {}) do
        keys[#keys + 1] = key
    end
    table.sort(keys, function(a, b)
        return tostring(a) < tostring(b)
    end)
    return keys
end

local function levelCountsCsv(bucket)
    local values = {}
    for level, count in pairs(bucket.levels or {}) do
        values[#values + 1] = tostring(level) .. "=" .. tostring(count)
    end
    table.sort(values)
    return table.concat(values, ",")
end

local function questIdsCsv(item)
    local ids = {}
    for id in pairs(item.questIds or {}) do
        ids[#ids + 1] = tostring(id)
    end
    table.sort(ids)
    return table.concat(ids, ",")
end

function FDB:BuildExportSnapshot()
    if not self.DB then
        ForeverDB_Export = ""
        return ForeverDB_Export
    end

    self:EnsureInstallationId()

    local lines = {
        table.concat({
            "H",
            tostring(self.SCHEMA_VERSION),
            self.VERSION,
            self.DB.installationId,
            tostring(self.DB.updatedAt or 0),
        }, "|")
    }

    for _, sourceKey in ipairs(sortedKeys(self.DB.sources)) do
        local source = self.DB.sources[sourceKey]

        lines[#lines + 1] = table.concat({
            "S",
            source.sourceType,
            tostring(source.sourceId),
            encode(source.name),
        }, "|")

        for _, kind in ipairs(sortedKeys(source.buckets)) do
            local bucket = source.buckets[kind]

            lines[#lines + 1] = table.concat({
                "B",
                source.sourceType,
                tostring(source.sourceId),
                kind,
                tostring(bucket.observations or 0),
                encode(levelCountsCsv(bucket)),
            }, "|")

            for _, itemKey in ipairs(sortedKeys(bucket.items)) do
                local item = bucket.items[itemKey]

                lines[#lines + 1] = table.concat({
                    "I",
                    source.sourceType,
                    tostring(source.sourceId),
                    kind,
                    tostring(item.itemId or itemKey),
                    encode(item.name),
                    tostring(item.drops or 0),
                    tostring(item.quantity or 0),
                    tostring(item.questDrops or 0),
                    encode(questIdsCsv(item)),
                }, "|")
            end
        end
    end

    ForeverDB_Export = table.concat(lines, "\n")
    return ForeverDB_Export
end
