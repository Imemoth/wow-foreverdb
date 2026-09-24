local _, FDB = ...

local disenchantFrame

local DISENCHANT_SPELL_ID = 13262

local function itemIdFromLink(link)
    if type(link) ~= "string" then return nil end
    return tonumber(link:match("item:(%d+)"))
end

local function getContainerItemLink(bag, slot)
    if C_Container and C_Container.GetContainerItemLink then
        return C_Container.GetContainerItemLink(bag, slot)
    end

    if GetContainerItemLink then
        return GetContainerItemLink(bag, slot)
    end
end

local function getDisenchantCursor()
    if not GetCursorInfo then return false end

    local cursorType, _, _, spellId =
        GetCursorInfo()

    return cursorType == "spell"
        and tonumber(spellId) == DISENCHANT_SPELL_ID
end

function FDB:RememberDisenchantTarget(bag, slot)
    local now = GetTime and GetTime() or 0
    local activeAt = self.DisenchantCursorActiveAt

    if not activeAt or now - activeAt > 10 then
        return
    end

    local link = getContainerItemLink(bag, slot)
    local itemId = itemIdFromLink(link)

    if not itemId then return end

    local name
    if GetItemInfo then
        name = GetItemInfo(link or itemId)
    end

    self.PendingDisenchant = {
        itemId = itemId,
        name = name,
        link = link,
        at = now,
    }

    self:Debug(
        "disenchant target",
        itemId,
        name or ""
    )
end

function FDB:ArmDisenchant()
    local pending = self.PendingDisenchant
    if not pending then return end

    local now = GetTime and GetTime() or 0
    if now - (pending.at or 0) > 12 then
        self.PendingDisenchant = nil
        return
    end

    pending.at = now
    self.ActiveDisenchant = pending
    self.PendingDisenchant = nil
    self.DisenchantCursorActiveAt = nil
end

function FDB:GetActiveDisenchant()
    local pending = self.ActiveDisenchant
    if not pending then return nil end

    local now = GetTime and GetTime() or pending.at
    if now - (pending.at or 0) > 20 then
        self.ActiveDisenchant = nil
        return nil
    end

    return pending
end

function FDB:ConsumeActiveDisenchant()
    self.ActiveDisenchant = nil
end

local function hookContainerUse()
    if not hooksecurefunc then return end

    if C_Container and C_Container.UseContainerItem then
        hooksecurefunc(
            C_Container,
            "UseContainerItem",
            function(bag, slot)
                FDB:RememberDisenchantTarget(
                    bag,
                    slot
                )
            end
        )
        return
    end

    if UseContainerItem then
        hooksecurefunc(
            "UseContainerItem",
            function(bag, slot)
                FDB:RememberDisenchantTarget(
                    bag,
                    slot
                )
            end
        )
    end
end

function FDB:InitializeDisenchantTracker()
    if disenchantFrame then return end

    disenchantFrame = CreateFrame("Frame")
    disenchantFrame:RegisterEvent("CURSOR_CHANGED")
    disenchantFrame:RegisterEvent("UNIT_SPELLCAST_SUCCEEDED")
    disenchantFrame:RegisterEvent("UNIT_SPELLCAST_INTERRUPTED")
    disenchantFrame:RegisterEvent("UNIT_SPELLCAST_FAILED")

    disenchantFrame:SetScript(
        "OnEvent",
        function(_, event, unitTarget, _, spellId)
            if event == "CURSOR_CHANGED" then
                if getDisenchantCursor() then
                    FDB.DisenchantCursorActiveAt =
                        GetTime and GetTime() or 0
                end
                return
            end

            if unitTarget ~= "player"
                or tonumber(spellId) ~= DISENCHANT_SPELL_ID then
                return
            end

            if event == "UNIT_SPELLCAST_SUCCEEDED" then
                FDB:ArmDisenchant()
            else
                FDB.PendingDisenchant = nil
                FDB.ActiveDisenchant = nil
                FDB.DisenchantCursorActiveAt = nil
            end
        end
    )

    hookContainerUse()
end
