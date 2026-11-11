local _, FDB = ...

local gatherFrame
local activeCast
local GATHERING_WINDOW_SECONDS = 12
local CORRELATED_LOOT_WINDOW_SECONDS = 4

local GATHERING_SPELLS = {
    [2575] = "mining",
    [2366] = "herbalism",
}

local function getSpellName(spellId)
    if C_Spell and C_Spell.GetSpellName then
        return C_Spell.GetSpellName(spellId)
    end
    if GetSpellInfo then
        return GetSpellInfo(spellId)
    end
end

local function currentTime()
    return GetTime and GetTime() or 0
end

local function pack(...)
    return { n = select("#", ...), ... }
end

local function sourceGuid()
    local guid = UnitGUID and UnitGUID("npc")
    local sourceType = FDB:ParseSourceGuid(guid)
    return sourceType == "gameobject" and guid or nil
end

local function readSpell(args)
    for index = 2, args.n or #args do
        local spellId = tonumber(args[index])
        local kind = spellId and GATHERING_SPELLS[spellId]
        if kind then return kind, spellId, index end
    end

    -- Some older clients expose the localized spell name and rank rather than
    -- the numeric ID. Support only exact API spell-name matches.
    for _, spellId in ipairs({ 2575, 2366 }) do
        local name = getSpellName(spellId)
        for index = 2, args.n or #args do
            if type(args[index]) == "string" and args[index] == name then
                return GATHERING_SPELLS[spellId], spellId, nil
            end
        end
    end
    return nil
end

local function castGuidFrom(args, spellIndex)
    if not spellIndex or spellIndex <= 2 then return nil end
    local candidate = args[spellIndex - 1]
    -- WoW cast GUIDs use the Cast- prefix. A target name or spell name is not
    -- a cast identity and must never be promoted into one.
    if type(candidate) == "string" and candidate:match("^Cast%-") then
        return candidate
    end
    return nil
end

local function validSourceGuid(guid)
    if not guid then return nil end
    local sourceType, sourceId = FDB:ParseSourceGuid(guid)
    return (sourceType == "gameobject" or sourceType == "creature")
        and sourceId and guid or nil
end

local function location()
    return FDB:GetCurrentLocation()
end

local function clearPending()
    activeCast = nil
    FDB.PendingGathering = nil
end

local function setPending(kind, guid, metadata)
    FDB:SetPendingGatheringKind(kind, guid, metadata)
end

local function onSent(unit, ...)
    if unit ~= "player" then return end
    local overlap = activeCast ~= nil or FDB.PendingGathering ~= nil
    -- Any new player cast invalidates the earlier correlation window. If the
    -- new cast is itself gathering, keep only a blocked marker so its success
    -- can retain legacy classification without inheriting ambiguous identity.
    clearPending()

    local args = pack(unit, ...)
    local kind, spellId, spellIndex = readSpell(args)
    if not kind then return end

    activeCast = {
        kind = kind,
        spellId = spellId,
        castGUID = castGuidFrom(args, spellIndex),
        sentAt = currentTime(),
        sentLocation = location(),
        sourceGuid = validSourceGuid(sourceGuid()),
        blocked = overlap,
    }
end

local function onSucceeded(unit, ...)
    if unit ~= "player" then return end

    local args = pack(unit, ...)
    local kind, spellId, spellIndex = readSpell(args)
    if not kind then
        -- An unrelated player spell cannot leave an old gather eligible.
        clearPending()
        return
    end

    local now = currentTime()
    local succeededCastGuid = castGuidFrom(args, spellIndex)
    local sent = activeCast
    local matchedSent = sent ~= nil
        and not sent.blocked
        and sent.kind == kind
        and sent.spellId == spellId
        and now >= (sent.sentAt or now)
        and now - (sent.sentAt or now) <= GATHERING_WINDOW_SECONDS
    if matchedSent then
        if sent.castGUID ~= nil or succeededCastGuid ~= nil then
            matchedSent = sent.castGUID ~= nil
                and succeededCastGuid ~= nil
                and sent.castGUID == succeededCastGuid
        end
    end

    local successLocation = location()
    local atSuccessGuid = validSourceGuid(sourceGuid())
    local sourceConflict = false
    if matchedSent then
        if sent.sourceGuid and atSuccessGuid and sent.sourceGuid ~= atSuccessGuid then
            matchedSent = false
            sourceConflict = true
        end
        local matchedSourceGuid
        if not sourceConflict then
            matchedSourceGuid = sent.sourceGuid or atSuccessGuid
        end
        setPending(kind, matchedSourceGuid, {
            location = successLocation,
            sentLocation = sent.sentLocation,
            succeededLocation = successLocation,
            sentAt = sent.sentAt,
            succeededAt = now,
            castGUID = succeededCastGuid,
            spellId = spellId,
            correlated = matchedSent,
            correlationReason = not matchedSent and "cast_or_source_mismatch" or nil,
        })
    else
        -- Preserve legacy event counting when SENT is unavailable, but the
        -- reduced evidence is never enough for correlated geographic credit.
        setPending(kind, atSuccessGuid, {
            location = successLocation,
            succeededLocation = successLocation,
            succeededAt = now,
            spellId = spellId,
            correlated = false,
            correlationReason = sent and "sent_success_mismatch" or "sent_event_unavailable",
        })
    end

    FDB:Debug(kind, "interaction detected", "spell", spellId,
        "source", atSuccessGuid or "awaiting loot source",
        "cast-loot eligible", matchedSent and "yes" or "no")
    activeCast = nil
end

local function onFailed(unit, ...)
    if unit ~= "player" then return end
    local args = pack(unit, ...)
    local failedCastGuid
    for index = 2, args.n or #args do
        if type(args[index]) == "string" then
            failedCastGuid = args[index]
        end
    end
    if not activeCast or not failedCastGuid or not activeCast.castGUID
        or activeCast.castGUID == failedCastGuid then
        clearPending()
    end
end

function FDB:SetPendingGatheringKind(kind, guid, metadata)
    metadata = metadata or {}
    self.PendingGathering = {
        kind = kind,
        guid = validSourceGuid(guid),
        sourceLevel = metadata.sourceLevel,
        location = metadata.location,
        sentLocation = metadata.sentLocation,
        succeededLocation = metadata.succeededLocation,
        sentAt = metadata.sentAt,
        succeededAt = metadata.succeededAt,
        castGUID = metadata.castGUID,
        spellId = metadata.spellId,
        correlated = metadata.correlated == true,
        correlationReason = metadata.correlationReason,
        at = currentTime(),
    }
end

function FDB:GetPendingGathering()
    local pending = self.PendingGathering
    if not pending then return nil end

    local current = currentTime()
    if current < (pending.at or current)
        or current - (pending.at or current) > GATHERING_WINDOW_SECONDS then
        self:Debug(pending.kind, "pending gathering expired before loot")
        self.PendingGathering = nil
        return nil
    end
    return pending
end

function FDB:GetPendingGatheringKind(sourceGuid)
    local pending = self:GetPendingGathering()
    if not pending then return nil end
    if pending.guid and sourceGuid and pending.guid ~= sourceGuid then return nil end
    if pending.guid and not sourceGuid then return nil end
    return pending.kind
end

function FDB:ConsumePendingGatheringKind(kind)
    local pending = self.PendingGathering
    if pending and pending.kind == kind then clearPending() end
end

function FDB:InitializeGatheringTracker()
    if gatherFrame then return end

    gatherFrame = CreateFrame("Frame")
    for _, event in ipairs({
        "UNIT_SPELLCAST_SENT", "UNIT_SPELLCAST_SUCCEEDED",
        "UNIT_SPELLCAST_FAILED", "UNIT_SPELLCAST_INTERRUPTED",
    }) do
        pcall(gatherFrame.RegisterEvent, gatherFrame, event)
    end
    gatherFrame:SetScript("OnEvent", function(_, event, unit, ...)
        if event == "UNIT_SPELLCAST_SENT" then
            onSent(unit, ...)
        elseif event == "UNIT_SPELLCAST_SUCCEEDED" then
            onSucceeded(unit, ...)
        elseif event == "UNIT_SPELLCAST_FAILED"
            or event == "UNIT_SPELLCAST_INTERRUPTED" then
            onFailed(unit, ...)
        end
    end)
end

FDB.GATHERING_CORRELATED_LOOT_WINDOW_SECONDS = CORRELATED_LOOT_WINDOW_SECONDS
