local _, FDB = ...

local gatherFrame

local MINING_SPELL_IDS = {
    [2575] = true,
}

local HERBALISM_SPELL_IDS = {
    [2366] = true,
}

local function getSpellName(spellId)
    if C_Spell and C_Spell.GetSpellName then
        return C_Spell.GetSpellName(spellId)
    end
    if GetSpellInfo then
        return GetSpellInfo(spellId)
    end
end

function FDB:SetPendingGatheringKind(kind, guid)
    self.PendingGathering = {
        kind = kind,
        guid = guid,
        at = GetTime and GetTime() or 0,
    }
end

function FDB:GetPendingGatheringKind(sourceGuid)
    local pending = self.PendingGathering
    if not pending then return nil end

    local current = GetTime and GetTime() or pending.at
    if current - (pending.at or 0) > 12 then
        self.PendingGathering = nil
        return nil
    end

    if pending.guid and sourceGuid and pending.guid ~= sourceGuid then
        local sourceType = self:ParseSourceGuid(sourceGuid)
        if pending.kind == "skinning" and sourceType == "creature" then
            return nil
        end
    end

    return pending.kind
end

function FDB:ConsumePendingGatheringKind(kind)
    local pending = self.PendingGathering
    if pending and pending.kind == kind then
        self.PendingGathering = nil
    end
end

function FDB:InitializeGatheringTracker()
    if gatherFrame then return end

    gatherFrame = CreateFrame("Frame")
    gatherFrame:RegisterEvent("UNIT_SPELLCAST_SUCCEEDED")

    gatherFrame:SetScript("OnEvent", function(_, _, unitTarget, _, spellId)
        if unitTarget ~= "player" then return end

        local spellName = getSpellName(spellId)
        local kind

        if MINING_SPELL_IDS[spellId] or spellName == "Mining" then
            kind = "mining"
        elseif HERBALISM_SPELL_IDS[spellId] or spellName == "Herb Gathering" then
            kind = "herbalism"
        end

        if not kind then return end

        local guid = UnitGUID("npc")
        local sourceType = FDB:ParseSourceGuid(guid)

        if sourceType ~= "gameobject" then
            guid = nil
        end

        FDB:SetPendingGatheringKind(kind, guid)
        FDB:Debug(kind, "interaction detected")
    end)
end
