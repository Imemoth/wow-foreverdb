local _, FDB = ...

local skinFrame

local KNOWN_SKINNING_SPELLS = {
    [8613] = true,
    [8617] = true,
    [8618] = true,
    [10768] = true,
}

local function getSpellName(spellId)
    if C_Spell and C_Spell.GetSpellName then
        return C_Spell.GetSpellName(spellId)
    end
    if GetSpellInfo then
        return GetSpellInfo(spellId)
    end
end

function FDB:IsSkinningSpell(spellId)
    if KNOWN_SKINNING_SPELLS[spellId] then return true end
    return getSpellName(spellId) == "Skinning"
end

function FDB:InitializeSkinningTracker()
    if skinFrame then return end

    skinFrame = CreateFrame("Frame")
    skinFrame:RegisterEvent("UNIT_SPELLCAST_SUCCEEDED")

    skinFrame:SetScript("OnEvent", function(_, _, unitTarget, _, spellId)
        if unitTarget ~= "player" or not FDB:IsSkinningSpell(spellId) then
            return
        end

        local guid = UnitGUID("target")
        local sourceType, sourceId = FDB:ParseSourceGuid(guid)

        if sourceType ~= "creature" or not sourceId then return end

        FDB:SetPendingGatheringKind("skinning", guid)
        FDB:Debug("skinning detected for", sourceId)
    end)
end
