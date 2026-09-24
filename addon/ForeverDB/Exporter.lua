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

local function questIdsCsv(item)
    local ids = {}
    for id in pairs(item.questIds or {}) do
        ids[#ids + 1] = tostring(id)
    end
    table.sort(ids)
    return table.concat(ids, ",")
end

local function stringListCsv(values)
    local result = {}

    for _, value in ipairs(values or {}) do
        result[#result + 1] = tostring(value)
    end

    return table.concat(result, ",")
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

    for _, mapKey in ipairs(sortedKeys(self.DB.maps or {})) do
        local map = self.DB.maps[mapKey]

        lines[#lines + 1] = table.concat({
            "M",
            tostring(map.mapId or mapKey),
            encode(map.name),
            tostring(map.parentMapId or 0),
            tostring(map.mapArtId or 0),
        }, "|")

        for index, layer in ipairs(map.layers or {}) do
            lines[#lines + 1] = table.concat({
                "A",
                tostring(map.mapId or mapKey),
                tostring(index),
                tostring(layer.layerWidth or 0),
                tostring(layer.layerHeight or 0),
                tostring(layer.tileWidth or 0),
                tostring(layer.tileHeight or 0),
                tostring(layer.minScale or 0),
                tostring(layer.maxScale or 0),
                tostring(layer.additionalZoomSteps or 0),
                encode(stringListCsv(layer.textureRefs)),
            }, "|")
        end
    end

    for _, sourceKey in ipairs(sortedKeys(self.DB.sources)) do
        local source = self.DB.sources[sourceKey]

        lines[#lines + 1] = table.concat({
            "S",
            source.sourceType,
            tostring(source.sourceId),
            tostring(source.sourceLevel or 0),
            encode(source.name),
        }, "|")

        for _, kind in ipairs(sortedKeys(source.buckets)) do
            local bucket = source.buckets[kind]

            lines[#lines + 1] = table.concat({
                "B",
                source.sourceType,
                tostring(source.sourceId),
                tostring(source.sourceLevel or 0),
                kind,
                tostring(bucket.observations or 0),
            }, "|")

            for _, locationKey in ipairs(sortedKeys(bucket.locations or {})) do
                local location = bucket.locations[locationKey]

                lines[#lines + 1] = table.concat({
                    "L",
                    source.sourceType,
                    tostring(source.sourceId),
                    tostring(source.sourceLevel or 0),
                    kind,
                    tostring(location.mapId or 0),
                    encode(location.zoneName),
                    encode(location.subZoneName),
                    tostring(location.x or ""),
                    tostring(location.y or ""),
                    tostring(location.observations or 0),
                }, "|")
            end

            for _, itemKey in ipairs(sortedKeys(bucket.items)) do
                local item = bucket.items[itemKey]

                lines[#lines + 1] = table.concat({
                    "I",
                    source.sourceType,
                    tostring(source.sourceId),
                    tostring(source.sourceLevel or 0),
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
