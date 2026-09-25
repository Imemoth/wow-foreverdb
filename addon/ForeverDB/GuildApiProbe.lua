local _, FDB = ...

local PREFIX = "|cff7dd3fcForeverDB|r"
local probeFrame
local probePending = false
local probeGeneration = 0

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

    local call = { pcall(GetProfessions) }
    local ok = table.remove(call, 1)

    if not ok then
        print(PREFIX, "guildapi: own professions: ERROR", tostring(call[1]))
        return
    end

    local found = 0

    for _, professionIndex in ipairs(call) do
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

local function printGuildTradeSkillSnapshot()
    if type(GetNumGuildTradeSkill) ~= "function"
        or type(GetGuildTradeSkillInfo) ~= "function" then
        print(PREFIX, "guildapi: guild tradeskill rows: API unavailable")
        return
    end

    local ok, count = safeCall(
        "GetNumGuildTradeSkill",
        GetNumGuildTradeSkill
    )

    if not ok then
        return
    end

    count = tonumber(count) or 0
    print(PREFIX, "guildapi: guild tradeskill rows=" .. tostring(count))

    if count <= 0 then
        print(
            PREFIX,
            "guildapi: zero rows can mean unsupported API OR an unpopulated guild-profession cache"
        )
        return
    end

    local shown = 0

    for index = 1, math.min(count, 12) do
        local result = { pcall(GetGuildTradeSkillInfo, index) }
        local rowOk = table.remove(result, 1)

        if rowOk then
            local skillId = result[1]
            local headerName = result[4]
            local playerName = result[8]
            local online = result[11]
            local skill = result[13]

            if headerName or playerName then
                print(
                    PREFIX,
                    "guildapi: tradeskill[" .. tostring(index) .. "]:",
                    headerName and ("header=" .. tostring(headerName)) or ("player=" .. tostring(playerName)),
                    "skillID=" .. tostring(skillId or "?"),
                    playerName and ("skill=" .. tostring(skill or "?")) or "",
                    playerName and ("online=" .. tostring(online and true or false)) or ""
                )
                shown = shown + 1
            end
        else
            print(
                PREFIX,
                "guildapi: GetGuildTradeSkillInfo(" .. tostring(index) .. ") ERROR",
                tostring(result[1])
            )
        end

        if shown >= 5 then
            break
        end
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
    printGuildTradeSkillSnapshot()
    print(PREFIX, "guildapi: probe complete; nothing was saved or uploaded")
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
    printGuildTradeSkillSnapshot()

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
