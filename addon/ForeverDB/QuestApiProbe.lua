local _, FDB = ...

-- Read-only compatibility probe for the Forever client's quest APIs.
-- This module deliberately does not persist anything: its only job is to
-- tell us which modern/legacy APIs are available and print a small snapshot
-- of the current quest log so the real Quest Tracker can be designed against
-- observed client behavior instead of guessed Retail/Classic contracts.

local PREFIX = "|cff7dd3fcForeverDB|r"
local probeFrame
local completedQueryPending = false
local completedQueryGeneration = 0

local function availability(label, value)
    local ok = type(value) == "function"
    print(PREFIX, "questapi:", label, ok and "|cff53c793YES|r" or "|cffd46a6aNO|r")
    return ok
end

local function namespaceAvailability(label, namespace, key)
    local ok = type(namespace) == "table" and type(namespace[key]) == "function"
    print(PREFIX, "questapi:", label, ok and "|cff53c793YES|r" or "|cffd46a6aNO|r")
    return ok
end

local function safeCall(label, func, ...)
    if type(func) ~= "function" then
        return false
    end

    local result = { pcall(func, ...) }
    local ok = table.remove(result, 1)

    if not ok then
        print(PREFIX, "questapi:", label, "|cffd46a6aERROR|r", tostring(result[1]))
        return false
    end

    return true, unpack(result)
end

local function countTruthyKeys(tbl)
    if type(tbl) ~= "table" then
        return 0
    end

    local count = 0
    for _, value in pairs(tbl) do
        if value then
            count = count + 1
        end
    end
    return count
end

local function printObjectiveText(prefix, text, finished)
    if type(text) ~= "string" or text == "" then
        text = "?"
    end

    print(
        PREFIX,
        "questapi:",
        prefix,
        finished and "|cff53c793DONE|r" or "|cffffcc66OPEN|r",
        text
    )
end

local function printModernObjectives(questID)
    if not (C_QuestLog and type(C_QuestLog.GetQuestObjectives) == "function") then
        return
    end

    local ok, objectives = safeCall(
        "C_QuestLog.GetQuestObjectives",
        C_QuestLog.GetQuestObjectives,
        questID
    )

    if not ok or type(objectives) ~= "table" then
        return
    end

    for index = 1, math.min(#objectives, 3) do
        local objective = objectives[index]
        if type(objective) == "table" then
            printObjectiveText(
                "objective[" .. tostring(index) .. "]:",
                objective.text,
                objective.finished and true or false
            )
        end
    end
end

local function printLegacyObjectives(questLogIndex)
    if type(GetNumQuestLeaderBoards) ~= "function"
        or type(GetQuestLogLeaderBoard) ~= "function" then
        return
    end

    local ok, count = safeCall(
        "GetNumQuestLeaderBoards",
        GetNumQuestLeaderBoards,
        questLogIndex
    )

    count = ok and tonumber(count) or 0
    if count <= 0 then
        return
    end

    for objectiveIndex = 1, math.min(count, 3) do
        local result = {
            pcall(
                GetQuestLogLeaderBoard,
                objectiveIndex,
                questLogIndex
            )
        }
        local objectiveOk = table.remove(result, 1)

        if objectiveOk then
            printObjectiveText(
                "objective[" .. tostring(objectiveIndex) .. "]:",
                result[1],
                result[3] and true or false
            )
        else
            print(
                PREFIX,
                "questapi:",
                "GetQuestLogLeaderBoard(" .. tostring(objectiveIndex) .. ")",
                "|cffd46a6aERROR|r",
                tostring(result[1])
            )
        end
    end
end

local function printModernQuestLog()
    if not (C_QuestLog
        and type(C_QuestLog.GetNumQuestLogEntries) == "function"
        and type(C_QuestLog.GetInfo) == "function") then
        return false
    end

    local ok, count = safeCall(
        "C_QuestLog.GetNumQuestLogEntries",
        C_QuestLog.GetNumQuestLogEntries
    )

    count = ok and tonumber(count) or 0
    print(PREFIX, "questapi:", "active log entries=" .. tostring(count), "path=modern")

    local shown = 0
    for index = 1, count do
        local infoOk, info = safeCall(
            "C_QuestLog.GetInfo",
            C_QuestLog.GetInfo,
            index
        )

        if infoOk and type(info) == "table" and not info.isHeader then
            shown = shown + 1
            local questID = tonumber(info.questID) or 0
            local complete

            if questID > 0
                and type(C_QuestLog.IsComplete) == "function" then
                local completeOk, value = safeCall(
                    "C_QuestLog.IsComplete",
                    C_QuestLog.IsComplete,
                    questID
                )
                if completeOk then
                    complete = value
                end
            end

            print(
                PREFIX,
                "questapi:",
                "quest[" .. tostring(index) .. "]:",
                tostring(info.title or "?"),
                "id=" .. tostring(questID > 0 and questID or "?"),
                "lvl=" .. tostring(info.level or "?"),
                "complete=" .. tostring(complete == true)
            )

            if questID > 0 then
                printModernObjectives(questID)
            end

            if shown >= 15 then
                break
            end
        end
    end

    return true
end

local function printLegacyQuestLog()
    if type(GetNumQuestLogEntries) ~= "function"
        or type(GetQuestLogTitle) ~= "function" then
        print(PREFIX, "questapi: active quest log snapshot unavailable")
        return false
    end

    local ok, count = safeCall(
        "GetNumQuestLogEntries",
        GetNumQuestLogEntries
    )

    count = ok and tonumber(count) or 0
    print(PREFIX, "questapi:", "active log entries=" .. tostring(count), "path=legacy")

    local shown = 0
    for index = 1, count do
        local result = { pcall(GetQuestLogTitle, index) }
        local titleOk = table.remove(result, 1)

        if titleOk then
            local title = result[1]
            local level = result[2]
            local isHeader = result[4]
            local isComplete = result[6]
            local questID = result[8]

            if not isHeader then
                shown = shown + 1
                print(
                    PREFIX,
                    "questapi:",
                    "quest[" .. tostring(index) .. "]:",
                    tostring(title or "?"),
                    "id=" .. tostring(questID or "?"),
                    "lvl=" .. tostring(level or "?"),
                    "complete=" .. tostring(isComplete == 1 or isComplete == true)
                )

                printLegacyObjectives(index)

                if shown >= 15 then
                    break
                end
            end
        else
            print(
                PREFIX,
                "questapi:",
                "GetQuestLogTitle(" .. tostring(index) .. ")",
                "|cffd46a6aERROR|r",
                tostring(result[1])
            )
        end
    end

    return true
end

local function printCompletedSnapshot(label)
    if type(GetQuestsCompleted) ~= "function" then
        return false
    end

    local ok, completed = safeCall(
        "GetQuestsCompleted",
        GetQuestsCompleted
    )

    if not ok then
        return false
    end

    if type(completed) ~= "table" then
        print(PREFIX, "questapi:", label, "completed quest table unavailable")
        return false
    end

    print(
        PREFIX,
        "questapi:",
        label,
        "completed quest ids=" .. tostring(countTruthyKeys(completed))
    )
    return true
end

local function finishCompletedQuery(reason, generation)
    if not completedQueryPending then
        return
    end

    if generation and generation ~= completedQueryGeneration then
        return
    end

    completedQueryPending = false

    if probeFrame then
        pcall(probeFrame.UnregisterEvent, probeFrame, "QUEST_QUERY_COMPLETE")
    end

    print(PREFIX, "questapi: completed-query:", reason)
    printCompletedSnapshot("completed snapshot:")
    print(PREFIX, "questapi: probe complete; nothing was saved or uploaded")
end

local function probeCompletedQuests()
    if C_QuestLog and type(C_QuestLog.GetAllCompletedQuestIDs) == "function" then
        local ok, ids = safeCall(
            "C_QuestLog.GetAllCompletedQuestIDs",
            C_QuestLog.GetAllCompletedQuestIDs
        )

        if ok and type(ids) == "table" then
            print(
                PREFIX,
                "questapi:",
                "completed snapshot:",
                "completed quest ids=" .. tostring(#ids),
                "path=modern"
            )
        end

        print(PREFIX, "questapi: probe complete; nothing was saved or uploaded")
        return
    end

    if type(QueryQuestsCompleted) ~= "function"
        or type(GetQuestsCompleted) ~= "function" then
        print(PREFIX, "questapi: completed quest enumeration unavailable")
        print(PREFIX, "questapi: probe complete; nothing was saved or uploaded")
        return
    end

    completedQueryGeneration = completedQueryGeneration + 1
    local generation = completedQueryGeneration
    completedQueryPending = true

    if probeFrame then
        local registered = pcall(
            probeFrame.RegisterEvent,
            probeFrame,
            "QUEST_QUERY_COMPLETE"
        )

        if not registered then
            print(PREFIX, "questapi: QUEST_QUERY_COMPLETE registration unavailable; using timeout snapshot")
        end
    end

    local ok, err = pcall(QueryQuestsCompleted)
    if not ok then
        completedQueryPending = false
        print(PREFIX, "questapi: QueryQuestsCompleted |cffd46a6aERROR|r", tostring(err))
        printCompletedSnapshot("best-effort snapshot:")
        print(PREFIX, "questapi: probe complete; nothing was saved or uploaded")
        return
    end

    print(PREFIX, "questapi: QueryQuestsCompleted request=OK")

    if C_Timer and C_Timer.After then
        C_Timer.After(
            2,
            function()
                finishCompletedQuery(
                    "timeout; reading current completion cache",
                    generation
                )
            end
        )
    else
        finishCompletedQuery(
            "timer API unavailable; reading current completion cache",
            generation
        )
    end
end

function FDB:RunQuestApiProbe()
    print(PREFIX, "questapi: read-only compatibility probe")
    print(
        PREFIX,
        "questapi:",
        "zone=" .. tostring(type(GetZoneText) == "function" and GetZoneText() or "?"),
        "subzone=" .. tostring(type(GetSubZoneText) == "function" and GetSubZoneText() or "?")
    )

    namespaceAvailability("C_QuestLog.GetNumQuestLogEntries", C_QuestLog, "GetNumQuestLogEntries")
    namespaceAvailability("C_QuestLog.GetInfo", C_QuestLog, "GetInfo")
    namespaceAvailability("C_QuestLog.GetQuestObjectives", C_QuestLog, "GetQuestObjectives")
    namespaceAvailability("C_QuestLog.IsComplete", C_QuestLog, "IsComplete")
    namespaceAvailability("C_QuestLog.IsQuestFlaggedCompleted", C_QuestLog, "IsQuestFlaggedCompleted")
    namespaceAvailability("C_QuestLog.GetAllCompletedQuestIDs", C_QuestLog, "GetAllCompletedQuestIDs")

    availability("GetNumQuestLogEntries", GetNumQuestLogEntries)
    availability("GetQuestLogTitle", GetQuestLogTitle)
    availability("GetNumQuestLeaderBoards", GetNumQuestLeaderBoards)
    availability("GetQuestLogLeaderBoard", GetQuestLogLeaderBoard)
    availability("GetQuestLogIndexByID", GetQuestLogIndexByID)
    availability("GetQuestID", GetQuestID)
    availability("IsQuestFlaggedCompleted", IsQuestFlaggedCompleted)
    availability("QueryQuestsCompleted", QueryQuestsCompleted)
    availability("GetQuestsCompleted", GetQuestsCompleted)

    print(PREFIX, "questapi: active quest snapshot")
    if not printModernQuestLog() then
        printLegacyQuestLog()
    end

    probeCompletedQuests()
end

function FDB:InitializeQuestApiProbe()
    if probeFrame then
        return
    end

    probeFrame = CreateFrame("Frame")
    probeFrame:SetScript(
        "OnEvent",
        function(_, event)
            if event == "QUEST_QUERY_COMPLETE" then
                finishCompletedQuery(
                    "QUEST_QUERY_COMPLETE received",
                    completedQueryGeneration
                )
            end
        end
    )
end
