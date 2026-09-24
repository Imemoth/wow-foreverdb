local _, FDB = ...

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
    if TooltipDataProcessor
        and TooltipDataProcessor.AddTooltipPostCall
        and Enum
        and Enum.TooltipDataType
        and Enum.TooltipDataType.Unit then

        TooltipDataProcessor.AddTooltipPostCall(
            Enum.TooltipDataType.Unit,
            enrichUnitTooltip
        )
        return
    end

    if GameTooltip and GameTooltip.HookScript then
        GameTooltip:HookScript("OnTooltipSetUnit", function(tooltip)
            local _, unit = tooltip:GetUnit()
            if not unit then return end
            enrichUnitTooltip(tooltip, { guid = UnitGUID(unit) })
        end)
    end
end
