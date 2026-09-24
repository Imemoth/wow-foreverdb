local _, FDB = ...

local skinFrame

local SKINNING_SPELL_NAME = PROFESSIONS_SKINNING or "Skinning"

function FDB:InitializeSkinningTracker()
    if skinFrame then return end

    skinFrame = CreateFrame("Frame")
    skinFrame:RegisterEvent("UNIT_SPELLCAST_SUCCEEDED")

    skinFrame:SetScript("OnEvent", function(_, _, unitTarget, _, spellId)
        if unitTarget ~= "player" then return end

        local spellName = C_Spell and C_Spell.GetSpellName and C_Spell.GetSpellName(spellId)
        if not spellName and GetSpellInfo then
            spellName = GetSpellInfo(spellId)
        end

        if spellName == SKINNING_SPELL_NAME or spellName == "Skinning" then
            FDB.ActiveLootMode = "skinning"
            FDB:Debug("skinning detected")
        end
    end)
end
