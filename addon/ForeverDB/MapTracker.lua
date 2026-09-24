local _, FDB = ...

function FDB:CaptureMapMetadata(mapId)
    if not self.DB
        or not mapId
        or mapId == 0
        or not C_Map then
        return
    end

    self.DB.maps = self.DB.maps or {}

    if self.DB.maps[tostring(mapId)] then
        return
    end

    local info =
        C_Map.GetMapInfo
        and C_Map.GetMapInfo(mapId)
        or nil

    local mapArtId =
        C_Map.GetMapArtID
        and C_Map.GetMapArtID(mapId)
        or nil

    local record = {
        mapId = mapId,
        name = info and info.name or nil,
        parentMapId =
            info and info.parentMapID or 0,
        mapArtId = mapArtId or 0,
        layers = {},
    }

    if C_Map.GetMapArtLayers
        and C_Map.GetMapArtLayerTextures then
        local layers =
            C_Map.GetMapArtLayers(mapId)

        if layers
            and #layers == 1
            and type(layers[1]) == "table"
            and not layers[1].layerWidth
            and type(layers[1][1]) == "table" then
            layers = layers[1]
        end

        for index, layer in ipairs(layers or {}) do
            local textures =
                C_Map.GetMapArtLayerTextures(
                    mapId,
                    index
                )

            if textures
                and #textures == 1
                and type(textures[1]) == "table" then
                textures = textures[1]
            end

            local textureRefs = {}
            for _, textureRef in ipairs(textures or {}) do
                textureRefs[#textureRefs + 1] =
                    tostring(textureRef)
            end

            record.layers[index] = {
                index = index,
                layerWidth =
                    tonumber(layer.layerWidth) or 0,
                layerHeight =
                    tonumber(layer.layerHeight) or 0,
                tileWidth =
                    tonumber(layer.tileWidth) or 0,
                tileHeight =
                    tonumber(layer.tileHeight) or 0,
                minScale =
                    tonumber(layer.minScale) or 0,
                maxScale =
                    tonumber(layer.maxScale) or 0,
                additionalZoomSteps =
                    tonumber(layer.additionalZoomSteps) or 0,
                textureRefs = textureRefs,
            }
        end
    end

    self.DB.maps[tostring(mapId)] = record

    self:Debug(
        "map metadata",
        mapId,
        record.name or "",
        "art",
        record.mapArtId,
        "layers",
        #record.layers
    )
end
