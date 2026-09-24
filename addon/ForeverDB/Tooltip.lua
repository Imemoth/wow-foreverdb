local _, FDB = ...

local SOURCE_LABELS = {
    mob = "Mob",
    skinning = "Skinning",
    mining = "Mining",
    herbalism = "Herbalism",
    chest = "Chest",
    fishing = "Fishing",
    gameobject = "Object",
    unknown = "Unknown",
}

local function sortedItems(bucket)
    local result = {}
    local observations = bucket and bucket.observations or 0
    if observations <= 0 then return result end

    for _, item in pairs(bucket.items or {}) do
        result[#result + 1] = {
            itemId = item.itemId,
            name = item.name,
            drops = item.drops or 0,
            rate = ((item.drops or 0) / observations) * 100,
            questDrops = item.questDrops or 0,
        }
    end

    table.sort(result, function(a, b)
        if a.rate == b.rate then
            return (a.name or tostring(a.itemId)) <
                (b.name or tostring(b.itemId))
        end
        return a.rate > b.rate
    end)

    return result
end

local function addBucket(tooltip, title, bucket)
    if not bucket or (bucket.observations or 0) <= 0 then return end

    tooltip:AddLine(title .. " - observed n=" .. tostring(bucket.observations))

    local items = sortedItems(bucket)
    local limit = math.min(#items, 5)

    for i = 1, limit do
        local item = items[i]
        local label = item.name or ("Item #" .. tostring(item.itemId))
        if item.questDrops > 0 then
            label = label .. " [Quest]"
        end

        tooltip:AddDoubleLine(
            label,
            string.format("%.1f%% (%d)", item.rate, item.drops)
        )
    end

    if #items > limit then
        tooltip:AddLine("+" .. tostring(#items - limit) .. " more observed items")
    end
end

local function wilsonLowerBound(successes, trials)
    if not trials or trials <= 0 then return 0 end

    local z = 1.96
    local p = successes / trials
    local z2 = z * z
    local denominator = 1 + z2 / trials
    local centre = p + z2 / (2 * trials)
    local margin = z * math.sqrt(
        (p * (1 - p) / trials) + (z2 / (4 * trials * trials))
    )

    return (centre - margin) / denominator
end

function FDB:InvalidateItemSourceIndex()
    self.ItemSourceIndex = nil
end

function FDB:BuildItemSourceIndex()
    local index = {}

    for _, source in pairs((self.DB and self.DB.sources) or {}) do
        for kind, bucket in pairs(source.buckets or {}) do
            local observations = bucket.observations or 0

            if observations > 0 then
                for _, item in pairs(bucket.items or {}) do
                    local itemId = tonumber(item.itemId)
                    if itemId then
                        local list = index[itemId]
                        if not list then
                            list = {}
                            index[itemId] = list
                        end

                        local drops = item.drops or 0
                        list[#list + 1] = {
                            sourceType = source.sourceType,
                            sourceId = source.sourceId,
                            sourceName = source.name,
                            kind = kind,
                            observations = observations,
                            drops = drops,
                            quantity = item.quantity or 0,
                            rate = drops / observations,
                            score = wilsonLowerBound(drops, observations),
                        }
                    end
                end
            end
        end
    end

    for _, list in pairs(index) do
        table.sort(list, function(a, b)
            if a.score == b.score then
                if a.rate == b.rate then
                    return a.observations > b.observations
                end
                return a.rate > b.rate
            end
            return a.score > b.score
        end)
    end

    self.ItemSourceIndex = index
    return index
end

function FDB:GetItemSources(itemId)
    itemId = tonumber(itemId)
    if not itemId then return {} end

    local index = self.ItemSourceIndex or self:BuildItemSourceIndex()
    return index[itemId] or {}
end

local function sourceDisplayName(source)
    if source.kind == "fishing" then
        return "Fishing"
    end

    local name = source.sourceName
    if not name or name == "" then
        if source.sourceType == "creature" then
            name = "Creature #" .. tostring(source.sourceId)
        else
            name = "Object #" .. tostring(source.sourceId)
        end
    end

    local kind = SOURCE_LABELS[source.kind] or source.kind or "Source"
    return name .. " [" .. kind .. "]"
end

function FDB:PrintItemSources(itemId, limit)
    local sources = self:GetItemSources(itemId)
    limit = limit or 20

    print("|cff7dd3fcForeverDB|r item", itemId, "- observed sources:", #sources)

    if #sources == 0 then
        print("No local observations yet.")
        return
    end

    for i = 1, math.min(#sources, limit) do
        local source = sources[i]
        print(
            i .. ".",
            sourceDisplayName(source),
            string.format("%.1f%%", source.rate * 100),
            "n=" .. tostring(source.observations),
            "drops=" .. tostring(source.drops)
        )
    end
end

local function resolveItemId(tooltip, data)
    if data then
        if type(data.id) == "number" and data.id > 0 then
            return data.id
        end

        if type(data.hyperlink) == "string" then
            local id = tonumber(data.hyperlink:match("item:(%d+)"))
            if id then return id end
        end
    end

    if tooltip and tooltip.GetItem then
        local _, link = tooltip:GetItem()
        if type(link) == "string" then
            return tonumber(link:match("item:(%d+)"))
        end
    end

    return nil
end

local function enrichItemTooltip(tooltip, data)
    if not FDB.DB then return end

    local itemId = resolveItemId(tooltip, data)
    if not itemId then return end

    local sources = FDB:GetItemSources(itemId)
    if #sources == 0 then return end

    local limit = IsAltKeyDown and IsAltKeyDown() and 5 or 3
    limit = math.min(limit, #sources)

    tooltip:AddLine(" ")
    tooltip:AddLine("ForeverDB - local sources")

    for i = 1, limit do
        local source = sources[i]
        tooltip:AddDoubleLine(
            sourceDisplayName(source),
            string.format("%.1f%%  n=%d", source.rate * 100, source.observations)
        )
    end

    if #sources > limit then
        if limit < 5 then
            tooltip:AddLine("Hold Alt: show top 5")
        else
            tooltip:AddLine("+" .. tostring(#sources - limit) .. " more local sources")
        end
    end
end

local function enrichUnitTooltip(tooltip, data)
    if not FDB.DB or not data or not data.guid then return end

    local sourceType, sourceId = FDB:ParseSourceGuid(data.guid)
    if sourceType ~= "creature" or not sourceId then return end

    local source = FDB.DB.sources["creature:" .. tostring(sourceId)]
    if not source then return end

    tooltip:AddLine(" ")
    tooltip:AddLine("ForeverDB - local observations")
    addBucket(tooltip, "Loot", source.buckets and source.buckets.mob)
    addBucket(tooltip, "Skinning", source.buckets and source.buckets.skinning)
end

function FDB:InitializeTooltip()
    local modern = TooltipDataProcessor
        and TooltipDataProcessor.AddTooltipPostCall
        and Enum
        and Enum.TooltipDataType

    if modern then
        if Enum.TooltipDataType.Unit then
            TooltipDataProcessor.AddTooltipPostCall(
                Enum.TooltipDataType.Unit,
                enrichUnitTooltip
            )
        end

        if Enum.TooltipDataType.Item then
            TooltipDataProcessor.AddTooltipPostCall(
                Enum.TooltipDataType.Item,
                enrichItemTooltip
            )
        end

        return
    end

    if GameTooltip and GameTooltip.HookScript then
        GameTooltip:HookScript("OnTooltipSetUnit", function(tooltip)
            local _, unit = tooltip:GetUnit()
            if not unit then return end
            enrichUnitTooltip(tooltip, { guid = UnitGUID(unit) })
        end)

        GameTooltip:HookScript("OnTooltipSetItem", function(tooltip)
            enrichItemTooltip(tooltip, nil)
        end)
    end
end
