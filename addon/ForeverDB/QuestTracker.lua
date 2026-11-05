local _, FDB = ...

-- Quest Tracker V1 is local-first. Quest history is kept in ForeverDB_Saved,
-- per character. It intentionally adds NO schema-9 export records or RPCs.
-- Quest-related loot retains the existing schema-9 I record and questDrops.
local frame
local pendingOffer
local pendingTurnIn
local MAX_QUESTS_PER_CHARACTER = 500
local MAX_OBJECTIVES = 16
local MAX_REWARDS = 24

local function isSecret(value)
    if type(issecretvalue) ~= "function" then return false end
    local ok, secret = pcall(issecretvalue, value)
    return not ok or secret == true
end

local function safeString(value, limit)
    if isSecret(value) or type(value) ~= "string" or value == "" then
        return nil
    end
    return value:sub(1, limit or 240)
end

local function safeId(value)
    if isSecret(value) or type(value) ~= "number"
        or value ~= value or value <= 0 or value > 2147483647 then
        return nil
    end
    return math.floor(value)
end

local function safeAmount(value)
    if isSecret(value) or type(value) ~= "number"
        or value ~= value or value < 0 or value > 2147483647 then
        return nil
    end
    return math.floor(value)
end

local function call(fn, ...)
    if type(fn) ~= "function" then return nil end
    local ok, a, b, c, d, e, f = pcall(fn, ...)
    if not ok then return nil end
    return a, b, c, d, e, f
end

local function timestamp()
    return safeAmount(call(GetServerTime)) or (type(time) == "function" and time()) or 0
end

local function elapsed()
    return safeAmount(call(GetTime)) or 0
end

local function characterGuid()
    return safeString(call(UnitGUID, "player"), 128)
end

local function questFromDialog()
    return safeId(call(GetQuestID))
end

local function captureGiver()
    -- Only the quest dialog's npc unit is trustworthy. Do NOT infer the
    -- questgiver from the player's unrelated combat target.
    local guid = safeString(call(UnitGUID, "npc"), 128)
    local kind, id
    if guid and type(FDB.ParseSourceGuid) == "function" then
        kind, id = FDB:ParseSourceGuid(guid)
    end
    local name = safeString(call(UnitName, "npc"), 160)
    local location
    if type(FDB.GetCurrentLocation) == "function" then
        location = call(FDB.GetCurrentLocation, FDB)
    end
    return {
        sourceType = kind,
        sourceId = safeId(id),
        name = name,
        location = type(location) == "table" and location or nil,
    }
end

local function ensureCharacter()
    if not FDB.DB then return nil end
    local guid = characterGuid()
    if not guid then return nil end
    FDB.DB.questJournal = FDB.DB.questJournal or {}
    local journal = FDB.DB.questJournal
    journal[guid] = journal[guid] or { entries = {} }
    journal[guid].entries = journal[guid].entries or {}
    return journal[guid]
end

local function prune(journal)
    local count, oldestKey, oldestAt = 0, nil, math.huge
    for key, record in pairs(journal.entries) do
        count = count + 1
        if record.status ~= "active" then
            local at = record.completedAt or record.abandonedAt or record.acceptedAt or 0
            if at < oldestAt then
                oldestKey, oldestAt = key, at
            end
        end
    end
    if count > MAX_QUESTS_PER_CHARACTER and oldestKey then
        journal.entries[oldestKey] = nil
    end
end

local function ensureQuest(id)
    local journal = ensureCharacter()
    if not journal or not id then return nil, nil end
    local key = tostring(id)
    local record = journal.entries[key]
    if not record then
        record = { questId = id, status = "unknown" }
        journal.entries[key] = record
        prune(journal)
    end
    journal.lastQuestId = id
    return record, journal
end

local function getTitle(id)
    if C_QuestLog and type(C_QuestLog.GetTitleForQuestID) == "function" then
        local title = safeString(call(C_QuestLog.GetTitleForQuestID, id), 180)
        if title then return title end
    end
    if type(GetQuestLogIndexByID) == "function"
        and type(GetQuestLogTitle) == "function" then
        local index = safeId(call(GetQuestLogIndexByID, id))
        if index then
            local title = safeString(call(GetQuestLogTitle, index), 180)
            if title then return title end
        end
    end
    return nil
end

local function updateObjectives(record)
    if not record or not C_QuestLog
        or type(C_QuestLog.GetQuestObjectives) ~= "function" then
        return
    end
    local objectives = call(C_QuestLog.GetQuestObjectives, record.questId)
    if type(objectives) ~= "table" then return end
    local result = {}
    local required = {}
    for i = 1, math.min(#objectives, MAX_OBJECTIVES) do
        local objective = objectives[i]
        if type(objective) == "table" then
            local text = safeString(objective.text, 220)
            local kind = safeString(objective.type, 40)
            local objectId = safeId(objective.objectID)
            if text then
                result[#result + 1] = {
                    text = text,
                    kind = kind,
                    finished = objective.finished == true,
                }
            end
            if kind == "item" and objectId then
                required[tostring(objectId)] = true
            end
        end
    end
    record.objectives = result
    -- Replace only after obtaining a real objective list; no guessed item IDs.
    record.requiredItemIds = required
end

local function rewardItems(rewardType, numFn)
    local result = {}
    local count = safeAmount(call(numFn))
    if not count then return nil end
    for index = 1, math.min(count, MAX_REWARDS) do
        local name, _, quantity, _, _, itemId =
            call(GetQuestItemInfo, rewardType, index)
        local link = safeString(call(GetQuestItemLink, rewardType, index), 512)
        if not safeId(itemId) and link then
            itemId = tonumber(link:match("item:(%d+)"))
        end
        name = safeString(name, 180)
        itemId = safeId(itemId)
        if name or itemId then
            result[#result + 1] = {
                itemId = itemId,
                name = name,
                quantity = safeAmount(quantity) or 1,
            }
        end
    end
    return result
end

local function rewardPreview()
    return {
        guaranteed = rewardItems("reward", GetNumQuestRewards),
        choices = rewardItems("choice", GetNumQuestChoices),
        offeredXP = safeAmount(call(GetRewardXP)),
        offeredMoney = safeAmount(call(GetRewardMoney)),
    }
end

local function markChanged()
    if FDB.DB then FDB.DB.updatedAt = timestamp() end
end

function FDB:QuestDetail()
    local id = questFromDialog()
    if not id then return end
    pendingOffer = {
        id = id,
        at = elapsed(),
        title = safeString(call(GetTitleText), 180),
        objectiveText = safeString(call(GetObjectiveText), 500),
        description = safeString(call(GetQuestText), 1800),
        giver = captureGiver(),
    }
end

function FDB:QuestAccepted(arg1, arg2)
    -- Forever/Retail: questID. Legacy Classic: questLogIndex, questID.
    local id = safeId(arg2) or safeId(arg1)
    if not id then return end
    local record = ensureQuest(id)
    if not record then return end
    if record.status ~= "active" then
        record.acceptedAt = timestamp()
        record.completedAt = nil
        record.abandonedAt = nil
        record.turnIn = nil
        record.rewards = nil
        -- A repeatable quest may have a different giver/objectives this time.
        -- Never reuse evidence from a prior completion.
        record.accept = nil
        record.objectiveText = nil
        record.description = nil
        record.objectives = nil
        record.requiredItemIds = nil
        record.title = nil
        record.status = "active"
    end
    local offer = pendingOffer
    if offer and offer.id == id and elapsed() - offer.at < 180 then
        record.accept = offer.giver
        record.title = offer.title or record.title
        record.objectiveText = offer.objectiveText or record.objectiveText
        record.description = offer.description or record.description
        pendingOffer = nil
    end
    record.title = record.title or getTitle(id)
    updateObjectives(record)
    markChanged()
end

function FDB:QuestCompleteDialog()
    local id = questFromDialog()
    if not id then return end
    pendingTurnIn = {
        id = id,
        at = elapsed(),
        giver = captureGiver(),
        rewards = rewardPreview(),
    }
end

function FDB:QuestTurnedIn(questId, xpReward, moneyReward)
    local id = safeId(questId)
    if not id then return end
    local record = ensureQuest(id)
    if not record then return end
    local preview = pendingTurnIn
    if preview and preview.id == id and elapsed() - preview.at < 180 then
        record.turnIn = preview.giver
        record.rewards = preview.rewards
        pendingTurnIn = nil
    else
        -- Auto-completed quests may have no reward dialog/giver.
        record.turnIn = nil
        record.rewards = record.rewards or {}
    end
    record.rewards = record.rewards or {}
    record.rewards.grantedXP = safeAmount(xpReward)
    record.rewards.grantedMoney = safeAmount(moneyReward)
    record.title = record.title or getTitle(id)
    record.completedAt = timestamp()
    record.abandonedAt = nil
    record.status = "completed"
    markChanged()
end

function FDB:QuestRemoved(id)
    id = safeId(id)
    local journal = ensureCharacter()
    local record = journal and journal.entries[tostring(id)] or nil
    if not record or record.status ~= "active" then return end
    -- Removal is not proof of turn-in; completion is only QUEST_TURNED_IN.
    record.status = "removed"
    record.abandonedAt = timestamp()
    markChanged()
end

function FDB:RefreshTrackedQuestObjectives()
    local journal = ensureCharacter()
    if not journal then return end
    for _, record in pairs(journal.entries) do
        if record.status == "active" then
            updateObjectives(record)
        end
    end
end

function FDB:IdentifyQuestLoot(itemId, directFlag, directQuestId)
    local id = safeId(itemId)
    local linkedId = safeId(directQuestId)
    if linkedId then return true, linkedId end
    if directFlag == true then return true, nil end
    if not id then return false, nil end
    local journal = ensureCharacter()
    if not journal then return false, nil end
    -- Only positive objectID evidence from an ACTIVE item objective counts.
    -- Never infer an item ID from translated objective text or an NPC name.
    for _, record in pairs(journal.entries) do
        if record.status == "active" and record.requiredItemIds
            and record.requiredItemIds[tostring(id)] then
            return true, record.questId
        end
    end
    return false, nil
end

function FDB:PrintTrackedQuest(argument)
    local journal = ensureCharacter()
    if not journal then
        print("ForeverDB: quest history unavailable until player login")
        return
    end
    local id = safeId(tonumber(argument)) or journal.lastQuestId
    local record = id and journal.entries[tostring(id)] or nil
    if not record then
        print("ForeverDB: no local quest record; /fdb quest <questID>")
        return
    end
    print("ForeverDB: quest", record.questId, record.title or "(title unavailable)", record.status)
    local function printPlace(label, place)
        if not place then return end
        local loc = place.location or {}
        print("ForeverDB:", label,
            place.name or "(no questgiver)",
            place.sourceId or "?",
            loc.zoneName or "?",
            loc.x or "?", loc.y or "?")
    end
    printPlace("accepted at", record.accept)
    printPlace("turned in at", record.turnIn)
    if record.description then
        print("ForeverDB: description", record.description:sub(1, 300))
    end
    if record.objectiveText then
        print("ForeverDB: goal", record.objectiveText)
    end
    for _, objective in ipairs(record.objectives or {}) do
        print("ForeverDB: objective", objective.text)
    end
    local rewards = record.rewards or {}
    for _, name in ipairs({"guaranteed", "choices"}) do
        for _, item in ipairs(rewards[name] or {}) do
            print("ForeverDB: reward", name, item.name or "?", item.itemId or "?", item.quantity)
        end
    end
    print("ForeverDB: actual XP/money", rewards.grantedXP or "?", rewards.grantedMoney or "?")
end

function FDB:InitializeQuestTracker()
    if frame then return end
    frame = CreateFrame("Frame")
    for _, event in ipairs({
        "QUEST_DETAIL", "QUEST_ACCEPTED", "QUEST_COMPLETE",
        "QUEST_TURNED_IN", "QUEST_REMOVED", "QUEST_LOG_UPDATE",
    }) do
        frame:RegisterEvent(event)
    end
    frame:SetScript("OnEvent", function(_, event, ...)
        if event == "QUEST_DETAIL" then
            FDB:QuestDetail()
        elseif event == "QUEST_ACCEPTED" then
            FDB:QuestAccepted(...)
        elseif event == "QUEST_COMPLETE" then
            FDB:QuestCompleteDialog()
        elseif event == "QUEST_TURNED_IN" then
            FDB:QuestTurnedIn(...)
        elseif event == "QUEST_REMOVED" then
            FDB:QuestRemoved(...)
        elseif event == "QUEST_LOG_UPDATE" then
            FDB:RefreshTrackedQuestObjectives()
        end
    end)
end
