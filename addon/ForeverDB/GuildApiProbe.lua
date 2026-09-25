local _, FDB = ...

local PREFIX = "|cff7dd3fcForeverDB|r"
local probeFrame
local probePending = false
local probeGeneration = 0
local tradeSkillProbePending = false
local tradeSkillGeneration = 0
local tradeSkillsToRecollapse = {}

local function availability(label, value)
    local ok = type(value) == "function"
    print(PREFIX, "guildapi:", label, ok and "|cff53c793YES|r" or "|cffd46a6aNO|r")
    return ok
end

local function namespaceAvailability(label, namespace, key)
    local ok =
        type(namespace) == "table"
        and type(namespace[key]) == "function"

    print(PREFIX, "guildapi:", label, ok and "|cff53c793YES|r" or "|cffd46a6aNO|r")
    return ok
end

local function safeCall(label, func, ...)
    if type(func) ~= "function" then
        return false
    end

    local result = { pcall(func, ...) }
    local ok = table.remove(result, 1)

    if not ok then
        print(PREFIX, "guildapi:", label, "|cffd46a6aERROR|r", tostring(result[1]))
        return false
    end

    return true, unpack(result)
end

local function printOwnProfessions()
    if type(GetProfessions) ~= "function"
        or type(GetProfessionInfo) ~= "function" then
        print(PREFIX, "guildapi: own professions: API unavailable")
        return
    end

    local ok, profession1, profession2, archaeology, fishing, cooking, firstAid =
        pcall(GetProfessions)

    if not ok then
        print(PREFIX, "guildapi: own professions: ERROR", tostring(profession1))
        return
    end

    local professionIndexes = {
        profession1,
        profession2,
        archaeology,
        fishing,
        cooking,
        firstAid,
    }

    local found = 0

    for index = 1, 6 do
        local professionIndex = professionIndexes[index]

        if professionIndex then
            local info = { pcall(GetProfessionInfo, professionIndex) }
            local infoOk = table.remove(info, 1)

            if infoOk then
                local name = info[1]
                local skillLevel = info[3]
                local maxSkillLevel = info[4]
                local skillLine = info[7]

                print(
                    PREFIX,
                    "guildapi: profession:",
                    tostring(name or "?"),
                    tostring(skillLevel or "?") .. "/" .. tostring(maxSkillLevel or "?"),
                    "skillLine=" .. tostring(skillLine or "?")
                )
                found = found + 1
            else
                print(PREFIX, "guildapi: GetProfessionInfo ERROR", tostring(info[1]))
            end
        end
    end

    if found == 0 then
        print(PREFIX, "guildapi: own professions: none returned")
    end
end

local function printRosterSnapshot(label)
    if type(GetNumGuildMembers) ~= "function" then
        print(PREFIX, "guildapi:", label, "roster count API unavailable")
        return
    end

    local ok, total, online = safeCall(
        "GetNumGuildMembers",
        GetNumGuildMembers
    )

    if not ok then
        return
    end

    total = tonumber(total) or 0
    online = tonumber(online) or 0

    print(
        PREFIX,
        "guildapi:",
        label,
        "guild members=" .. tostring(total),
        "online=" .. tostring(online)
    )

    if total <= 0 or type(GetGuildRosterInfo) ~= "function" then
        return
    end

    local sampleCount = math.min(total, 3)

    for index = 1, sampleCount do
        local result = { pcall(GetGuildRosterInfo, index) }
        local memberOk = table.remove(result, 1)

        if memberOk then
            local name = result[1]
            local rank = result[2]
            local level = result[4]
            local class = result[5]
            local zone = result[6]
            local isOnline = result[9]
            local classFile = result[11]
            local guid = result[17]

            print(
                PREFIX,
                "guildapi: member[" .. tostring(index) .. "]:",
                tostring(name or "?"),
                "lvl=" .. tostring(level or "?"),
                "class=" .. tostring(classFile or class or "?"),
                "rank=" .. tostring(rank or "?"),
                "online=" .. tostring(isOnline and true or false),
                "zone=" .. tostring(zone or "?"),
                "guid=" .. tostring(guid or "?")
            )
        else
            print(
                PREFIX,
                "guildapi: GetGuildRosterInfo(" .. tostring(index) .. ") ERROR",
                tostring(result[1])
            )
        end
    end
end

local function printGuildTradeSkillSnapshot(label, memberOnly)
    if type(GetNumGuildTradeSkill) ~= "function"
        or type(GetGuildTradeSkillInfo) ~= "function" then
        print(PREFIX, "guildapi:", label, "guild tradeskill rows: API unavailable")
        return 0
    end

    local ok, count = safeCall(
        "GetNumGuildTradeSkill",
        GetNumGuildTradeSkill
    )

    if not ok then
        return 0
    end

    count = tonumber(count) or 0
    print(
        PREFIX,
        "guildapi:",
        label,
        "guild tradeskill rows=" .. tostring(count)
    )

    if count <= 0 then
        print(
            PREFIX,
            "guildapi: zero rows can mean unsupported API OR an unpopulated guild-profession cache"
        )
        return 0
    end

    local shown = 0
    local memberRows = 0
    local currentHeader = "?"

    for index = 1, count do
        local result = { pcall(GetGuildTradeSkillInfo, index) }
        local rowOk = table.remove(result, 1)

        if rowOk then
            local skillId = result[1]
            local isCollapsed = result[2]
            local headerName = result[4]
            local numOnline = result[5]
            local numVisible = result[6]
            local numPlayers = result[7]
            local playerName = result[8]
            local online = result[11]
            local zone = result[12]
            local skill = result[13]

            if headerName then
                currentHeader = tostring(headerName)

                if not memberOnly and shown < 10 then
                    print(
                        PREFIX,
                        "guildapi: tradeskill[" .. tostring(index) .. "]:",
                        "header=" .. currentHeader,
                        "skillID=" .. tostring(skillId or "?"),
                        "collapsed=" .. tostring(isCollapsed and true or false),
                        "players=" .. tostring(numPlayers or "?"),
                        "visible=" .. tostring(numVisible or "?"),
                        "online=" .. tostring(numOnline or "?")
                    )
                    shown = shown + 1
                end
            elseif playerName then
                memberRows = memberRows + 1

                if shown < 12 then
                    print(
                        PREFIX,
                        "guildapi: tradeskill-member[" .. tostring(index) .. "]:",
                        tostring(playerName),
                        "profession=" .. currentHeader,
                        "skillID=" .. tostring(skillId or "?"),
                        "skill=" .. tostring(skill or "?"),
                        "online=" .. tostring(online and true or false),
                        "zone=" .. tostring(zone or "?")
                    )
                    shown = shown + 1
                end
            end
        else
            print(
                PREFIX,
                "guildapi: GetGuildTradeSkillInfo(" .. tostring(index) .. ") ERROR",
                tostring(result[1])
            )
        end
    end

    print(
        PREFIX,
        "guildapi:",
        label,
        "guild tradeskill member rows=" .. tostring(memberRows)
    )

    return memberRows
end

local function finishGuildTradeSkillProbe(reason)
    if not tradeSkillProbePending then
        return
    end

    tradeSkillProbePending = false

    if probeFrame then
        probeFrame:UnregisterEvent("GUILD_TRADESKILL_UPDATE")
    end

    print(PREFIX, "guildapi: tradeskill refresh:", reason)
    local memberRows =
        printGuildTradeSkillSnapshot("expanded", true)

    for _, skillId in ipairs(tradeSkillsToRecollapse) do
        if type(CollapseGuildTradeSkillHeader) == "function" then
            pcall(CollapseGuildTradeSkillHeader, skillId)
        end
    end

    tradeSkillsToRecollapse = {}

    if memberRows > 0 then
        print(
            PREFIX,
            "guildapi: guild member profession rows PASS; recipe probe is the next gate"
        )
    else
        print(
            PREFIX,
            "guildapi: no member profession rows after expansion; recipe/member query needs separate probing"
        )
    end

    print(PREFIX, "guildapi: probe complete; nothing was saved or uploaded")
end

local function startGuildTradeSkillProbe()
    print(PREFIX, "guildapi: starting expanded guild tradeskill probe")

    if type(QueryGuildRecipes) == "function" then
        local ok, err = pcall(QueryGuildRecipes)
        print(
            PREFIX,
            "guildapi: QueryGuildRecipes request=" .. tostring(ok),
            ok and "" or tostring(err)
        )
    end

    if type(ExpandGuildTradeSkillHeader) ~= "function"
        or type(GetNumGuildTradeSkill) ~= "function"
        or type(GetGuildTradeSkillInfo) ~= "function" then
        print(PREFIX, "guildapi: header expansion API unavailable")
        print(PREFIX, "guildapi: probe complete; nothing was saved or uploaded")
        return
    end

    tradeSkillsToRecollapse = {}

    local count = tonumber(GetNumGuildTradeSkill()) or 0

    for index = 1, count do
        local result = { pcall(GetGuildTradeSkillInfo, index) }
        local ok = table.remove(result, 1)

        if ok then
            local skillId = result[1]
            local isCollapsed = result[2]
            local headerName = result[4]

            if headerName
                and skillId
                and isCollapsed then
                local expanded =
                    pcall(
                        ExpandGuildTradeSkillHeader,
                        skillId
                    )

                if expanded then
                    tradeSkillsToRecollapse[#tradeSkillsToRecollapse + 1] =
                        skillId
                end
            end
        end
    end

    print(
        PREFIX,
        "guildapi: expanded profession headers=" ..
        tostring(#tradeSkillsToRecollapse)
    )

    tradeSkillGeneration = tradeSkillGeneration + 1
    local generation = tradeSkillGeneration
    tradeSkillProbePending = true

    if probeFrame then
        probeFrame:RegisterEvent("GUILD_TRADESKILL_UPDATE")
    end

    if C_Timer and C_Timer.After then
        C_Timer.After(
            2,
            function()
                if tradeSkillProbePending
                    and generation == tradeSkillGeneration then
                    finishGuildTradeSkillProbe(
                        "timeout; reading expanded cache"
                    )
                end
            end
        )
    else
        finishGuildTradeSkillProbe("timer API unavailable")
    end
end

local function finishProbe(reason)
    if not probePending then
        return
    end

    probePending = false

    if probeFrame then
        probeFrame:UnregisterEvent("GUILD_ROSTER_UPDATE")
    end

    print(PREFIX, "guildapi: roster refresh:", reason)
    printRosterSnapshot("refreshed")
    printGuildTradeSkillSnapshot("collapsed", false)
    startGuildTradeSkillProbe()
end

function FDB:InitializeGuildApiProbe()
    if probeFrame then
        return
    end

    probeFrame = CreateFrame("Frame")
    probeFrame:SetScript(
        "OnEvent",
        function(_, event)
            if event == "GUILD_ROSTER_UPDATE" and probePending then
                finishProbe("GUILD_ROSTER_UPDATE received")
            elseif event == "GUILD_TRADESKILL_UPDATE"
                and tradeSkillProbePending then
                finishGuildTradeSkillProbe(
                    "GUILD_TRADESKILL_UPDATE received"
                )
            end
        end
    )
end

function FDB:RunGuildApiProbe()
    self:InitializeGuildApiProbe()

    print(PREFIX, "guildapi: === Forever Guildbook capability probe ===")
    print(PREFIX, "guildapi: addon=" .. tostring(self.VERSION), "schema=" .. tostring(self.SCHEMA_VERSION))
    print(PREFIX, "guildapi: this probe does NOT persist or upload guild data")

    availability("IsInGuild", IsInGuild)
    availability("GetGuildInfo", GetGuildInfo)
    availability("GetNumGuildMembers", GetNumGuildMembers)
    availability("GetGuildRosterInfo", GetGuildRosterInfo)
    availability("GetGuildRosterLastOnline", GetGuildRosterLastOnline)
    availability("GuildRoster (legacy)", GuildRoster)
    namespaceAvailability("C_GuildInfo.GuildRoster", C_GuildInfo, "GuildRoster")

    availability("GetProfessions", GetProfessions)
    availability("GetProfessionInfo", GetProfessionInfo)
    availability("GetNumGuildTradeSkill", GetNumGuildTradeSkill)
    availability("GetGuildTradeSkillInfo", GetGuildTradeSkillInfo)
    availability("QueryGuildRecipes", QueryGuildRecipes)
    availability("ExpandGuildTradeSkillHeader", ExpandGuildTradeSkillHeader)
    availability("CollapseGuildTradeSkillHeader", CollapseGuildTradeSkillHeader)
    availability("GetGuildMemberRecipes", GetGuildMemberRecipes)
    availability("GetGuildRecipeMember", GetGuildRecipeMember)
    availability("CanViewGuildRecipes", CanViewGuildRecipes)
    namespaceAvailability(
        "C_GuildInfo.QueryGuildMemberRecipes",
        C_GuildInfo,
        "QueryGuildMemberRecipes"
    )
    namespaceAvailability(
        "C_GuildInfo.QueryGuildMembersForRecipe",
        C_GuildInfo,
        "QueryGuildMembersForRecipe"
    )

    printOwnProfessions()

    local inGuild = false
    if type(IsInGuild) == "function" then
        local ok, value = pcall(IsInGuild)
        inGuild = ok and value and true or false
    end

    print(PREFIX, "guildapi: player in guild=" .. tostring(inGuild))

    if type(GetGuildInfo) == "function" then
        local ok, guildName, guildRankName, guildRankIndex =
            pcall(GetGuildInfo, "player")

        if ok then
            print(
                PREFIX,
                "guildapi: guild:",
                tostring(guildName or "?"),
                "rank=" .. tostring(guildRankName or "?"),
                "rankIndex=" .. tostring(guildRankIndex or "?")
            )
        else
            print(PREFIX, "guildapi: GetGuildInfo ERROR", tostring(guildName))
        end
    end

    printRosterSnapshot("cached")
    printGuildTradeSkillSnapshot("collapsed", false)

    if not inGuild then
        print(PREFIX, "guildapi: roster refresh skipped because the character is not in a guild")
        print(PREFIX, "guildapi: probe complete; nothing was saved or uploaded")
        return
    end

    probeGeneration = probeGeneration + 1
    local generation = probeGeneration
    probePending = true
    probeFrame:RegisterEvent("GUILD_ROSTER_UPDATE")

    local requested = false

    if type(C_GuildInfo) == "table"
        and type(C_GuildInfo.GuildRoster) == "function" then
        requested = pcall(C_GuildInfo.GuildRoster)
    elseif type(GuildRoster) == "function" then
        requested = pcall(GuildRoster)
    end

    print(
        PREFIX,
        "guildapi: roster refresh request=" .. tostring(requested),
        "waiting up to 12s for GUILD_ROSTER_UPDATE"
    )

    if C_Timer and C_Timer.After then
        C_Timer.After(
            12,
            function()
                if probePending and generation == probeGeneration then
                    finishProbe("timeout; using current cached roster")
                end
            end
        )
    end
end
