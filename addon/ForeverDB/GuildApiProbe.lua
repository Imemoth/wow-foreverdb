local _, FDB = ...

local PREFIX = "|cff7dd3fcForeverDB|r"
local probeFrame
local probePending = false
local probeGeneration = 0
local tradeSkillProbePending = false
local tradeSkillGeneration = 0
local tradeSkillsToRecollapse = {}
local recipeProbePending = false
local recipeProbeGeneration = 0
local recipeTarget
local reverseRecipeQueryPending = false
local legacyRecipeFallbackPending = false

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

local function firstNumber(func)
    if type(func) ~= "function" then
        return 0
    end

    -- Some WoW APIs return multiple values. Passing such a call directly to
    -- tonumber() forwards the second return value as tonumber's optional base,
    -- which can produce "base out of range". Capture only the first return.
    local ok, value = pcall(func)

    if not ok then
        return 0
    end

    return tonumber(value) or 0
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

    local count = firstNumber(GetNumGuildTradeSkill)
    local collapsedSkillIds = {}

    -- First snapshot the collapsed headers. Expanding a header mutates the
    -- guild tradeskill list, so expanding while iterating its indexes skips
    -- later headers.
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
                collapsedSkillIds[#collapsedSkillIds + 1] =
                    skillId
            end
        end
    end

    for _, skillId in ipairs(collapsedSkillIds) do
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

local function normalizeGuildName(name)
    if type(name) ~= "string" then
        return ""
    end

    local short =
        name:match("^([^%-]+)")
        or name

    return string.lower(short)
end

local function findGuildMemberGuid(memberName)
    if type(GetNumGuildMembers) ~= "function"
        or type(GetGuildRosterInfo) ~= "function" then
        return nil
    end

    local wanted = normalizeGuildName(memberName)
    local total = firstNumber(GetNumGuildMembers)
    local prefixMatches = {}

    for index = 1, total do
        local result = { pcall(GetGuildRosterInfo, index) }
        local ok = table.remove(result, 1)

        if ok then
            local rosterName = result[1]
            local guid = result[17]

            if type(rosterName) == "string"
                and type(guid) == "string" then
                local normalized =
                    normalizeGuildName(rosterName)

                if normalized == wanted then
                    return guid, rosterName
                end

                if wanted ~= ""
                    and normalized:find(
                        wanted,
                        1,
                        true
                    ) == 1 then
                    prefixMatches[#prefixMatches + 1] = {
                        guid = guid,
                        name = rosterName,
                    }
                end
            end
        end
    end

    if #prefixMatches == 1 then
        return prefixMatches[1].guid,
            prefixMatches[1].name
    end

    if #prefixMatches > 1 then
        return nil, nil, "ambiguous"
    end
end

local function findGuildMemberNameByGuid(guid)
    if type(guid) ~= "string"
        or type(GetNumGuildMembers) ~= "function"
        or type(GetGuildRosterInfo) ~= "function" then
        return nil
    end

    local total = firstNumber(GetNumGuildMembers)

    for index = 1, total do
        local result = { pcall(GetGuildRosterInfo, index) }
        local ok = table.remove(result, 1)

        if ok
            and result[17] == guid
            and type(result[1]) == "string" then
            return result[1]
        end
    end
end

local function describeCallResult(label, result)
    local ok = table.remove(result, 1)

    if not ok then
        print(
            PREFIX,
            "guildrecipe:",
            label,
            "ERROR",
            tostring(result[1])
        )
        return false
    end

    if #result == 0 then
        print(
            PREFIX,
            "guildrecipe:",
            label,
            "OK (no return values)"
        )
        return true
    end

    local values = {}

    for index = 1, math.min(#result, 8) do
        values[#values + 1] =
            tostring(result[index])
    end

    print(
        PREFIX,
        "guildrecipe:",
        label,
        "OK returns=" .. tostring(#result),
        table.concat(values, ", ")
    )

    return true
end

local SECONDARY_RECIPE_SKILL_LINES = {
    [129] = "First Aid",
    [185] = "Cooking",
    [356] = "Fishing",
}

local function getSecondaryProfessionName(skillLineID)
    return SECONDARY_RECIPE_SKILL_LINES[
        tonumber(skillLineID)
    ]
end

local function finishLegacyGuildRecipeFallback()
    if not legacyRecipeFallbackPending
        or not recipeTarget then
        return
    end

    legacyRecipeFallbackPending = false
    recipeProbePending = false

    local skillLineID = recipeTarget.skillLineID
    local canView

    if type(CanViewGuildRecipes) == "function" then
        local result = { pcall(CanViewGuildRecipes, skillLineID) }
        local ok = table.remove(result, 1)

        if ok then
            canView = result[1]
            print(
                PREFIX,
                "guildrecipe: CanViewGuildRecipes(" ..
                tostring(skillLineID) ..
                ")=" ..
                tostring(canView and true or false)
            )
        else
            print(
                PREFIX,
                "guildrecipe: CanViewGuildRecipes ERROR",
                tostring(result[1])
            )
        end
    end

    if canView
        and type(ViewGuildRecipes) == "function" then
        local result = {
            pcall(
                ViewGuildRecipes,
                skillLineID
            )
        }

        describeCallResult(
            "ViewGuildRecipes",
            result
        )
    else
        local secondaryName =
            getSecondaryProfessionName(
                skillLineID
            )

        if secondaryName then
            print(
                PREFIX,
                "guildrecipe: RESULT:",
                secondaryName,
                "is not exposed through Forever's guild recipe cache for this character/session"
            )
            print(
                PREFIX,
                "guildrecipe: character-local profession data still works, but guild-wide secondary-profession recipe discovery is not proven"
            )
        else
            print(
                PREFIX,
                "guildrecipe: ViewGuildRecipes skipped; guild recipe cache is not viewable for this primary skillLine"
            )
            print(
                PREFIX,
                "guildrecipe: test a known crafting member/profession to distinguish cache/permission limits from API incompatibility"
            )
        end
    end

    print(
        PREFIX,
        "guildrecipe: legacy fallback complete"
    )
end

local function startLegacyGuildRecipeFallback()
    if not recipeTarget then
        return
    end

    print(
        PREFIX,
        "guildrecipe: modern member query did not raise TRADE_SKILL_SHOW; trying legacy guild recipe APIs"
    )

    legacyRecipeFallbackPending = true

    local memberName =
        recipeTarget.rosterName
        or recipeTarget.name

    if type(GetGuildMemberRecipes) == "function" then
        local result = {
            pcall(
                GetGuildMemberRecipes,
                memberName,
                recipeTarget.skillLineID
            )
        }

        describeCallResult(
            "GetGuildMemberRecipes(" ..
            tostring(memberName) ..
            ", " ..
            tostring(recipeTarget.skillLineID) ..
            ")",
            result
        )
    else
        print(
            PREFIX,
            "guildrecipe: GetGuildMemberRecipes unavailable"
        )
    end

    if type(QueryGuildRecipes) == "function" then
        local result = { pcall(QueryGuildRecipes) }

        describeCallResult(
            "QueryGuildRecipes",
            result
        )
    end

    if C_Timer and C_Timer.After then
        C_Timer.After(
            1,
            finishLegacyGuildRecipeFallback
        )
    else
        finishLegacyGuildRecipeFallback()
    end
end

local function finishReverseRecipeQuery(reason)
    if not reverseRecipeQueryPending then
        return
    end

    reverseRecipeQueryPending = false
    recipeProbePending = false
    legacyRecipeFallbackPending = false

    if probeFrame then
        probeFrame:UnregisterEvent("GUILD_RECIPE_KNOWN_BY_MEMBERS")
        probeFrame:UnregisterEvent("TRADE_SKILL_SHOW")
    end

    print(PREFIX, "guildrecipe: reverse query:", reason)

    if type(GetGuildRecipeInfoPostQuery) ~= "function"
        or type(GetGuildRecipeMember) ~= "function" then
        print(PREFIX, "guildrecipe: post-query API unavailable")
        return
    end

    local info = { pcall(GetGuildRecipeInfoPostQuery) }
    local ok = table.remove(info, 1)

    if not ok then
        print(PREFIX, "guildrecipe: GetGuildRecipeInfoPostQuery ERROR", tostring(info[1]))
        return
    end

    local professionID = info[1]
    local recipeID = info[2]
    local numMembers = tonumber(info[3]) or 0

    print(
        PREFIX,
        "guildrecipe: PASS",
        "profession=" .. tostring(professionID or "?"),
        "recipe=" .. tostring(recipeID or "?"),
        "crafters=" .. tostring(numMembers)
    )

    for index = 1, math.min(numMembers, 10) do
        local member = { pcall(GetGuildRecipeMember, index) }
        local memberOk = table.remove(member, 1)

        if memberOk then
            print(
                PREFIX,
                "guildrecipe: crafter[" .. tostring(index) .. "]:",
                tostring(member[1] or "?"),
                "online=" .. tostring(member[2] and true or false)
            )
        else
            print(
                PREFIX,
                "guildrecipe: GetGuildRecipeMember(" .. tostring(index) .. ") ERROR",
                tostring(member[1])
            )
        end
    end

    print(PREFIX, "guildrecipe: probe complete; nothing was saved or uploaded")
end

local function handleMemberTradeSkillShow()
    if not recipeProbePending
        or not recipeTarget then
        return
    end

    if probeFrame then
        probeFrame:UnregisterEvent("TRADE_SKILL_SHOW")
    end

    print(
        PREFIX,
        "guildrecipe: TRADE_SKILL_SHOW received for",
        recipeTarget.name,
        "skillLine=" .. tostring(recipeTarget.skillLineID)
    )

    if not (C_TradeSkillUI
        and type(C_TradeSkillUI.GetAllRecipeIDs) == "function"
        and type(C_TradeSkillUI.GetRecipeInfo) == "function") then
        print(PREFIX, "guildrecipe: C_TradeSkillUI recipe APIs unavailable")
        recipeProbePending = false
        return
    end

    local ok, recipeIDs =
        pcall(C_TradeSkillUI.GetAllRecipeIDs)

    if not ok or type(recipeIDs) ~= "table" then
        print(PREFIX, "guildrecipe: GetAllRecipeIDs ERROR", tostring(recipeIDs))
        recipeProbePending = false
        return
    end

    local learned = {}
    local total = 0

    for _, recipeID in ipairs(recipeIDs) do
        total = total + 1

        local infoOk, info =
            pcall(
                C_TradeSkillUI.GetRecipeInfo,
                recipeID
            )

        if infoOk and type(info) == "table" then
            if info.learned then
                learned[#learned + 1] = {
                    id = recipeID,
                    name = info.name or "?",
                }
            end
        end
    end

    print(
        PREFIX,
        "guildrecipe: recipes total=" .. tostring(total),
        "learned-by-target=" .. tostring(#learned)
    )

    for index = 1, math.min(#learned, 5) do
        print(
            PREFIX,
            "guildrecipe: learned[" .. tostring(index) .. "]:",
            tostring(learned[index].id),
            tostring(learned[index].name)
        )
    end

    if #learned == 0 then
        print(PREFIX, "guildrecipe: no learned recipe found; reverse crafter query skipped")
        recipeProbePending = false
        return
    end

    if not (C_GuildInfo
        and type(C_GuildInfo.QueryGuildMembersForRecipe) == "function") then
        print(PREFIX, "guildrecipe: QueryGuildMembersForRecipe unavailable")
        recipeProbePending = false
        return
    end

    local selected = learned[1]

    recipeTarget.recipeID = selected.id
    recipeTarget.recipeName = selected.name

    reverseRecipeQueryPending = true

    if probeFrame then
        probeFrame:RegisterEvent("GUILD_RECIPE_KNOWN_BY_MEMBERS")
    end

    local queryOk, updatedRecipeID =
        pcall(
            C_GuildInfo.QueryGuildMembersForRecipe,
            recipeTarget.skillLineID,
            selected.id
        )

    print(
        PREFIX,
        "guildrecipe: reverse crafter query request=" .. tostring(queryOk),
        "recipe=" .. tostring(selected.id),
        "updatedRecipe=" .. tostring(updatedRecipeID or "?")
    )

    if not queryOk then
        reverseRecipeQueryPending = false
        recipeProbePending = false
        if probeFrame then
            probeFrame:UnregisterEvent("GUILD_RECIPE_KNOWN_BY_MEMBERS")
        end
        return
    end

    local generation = recipeProbeGeneration

    if C_Timer and C_Timer.After then
        C_Timer.After(
            5,
            function()
                if reverseRecipeQueryPending
                    and generation == recipeProbeGeneration then
                    finishReverseRecipeQuery(
                        "timeout; GUILD_RECIPE_KNOWN_BY_MEMBERS not received"
                    )
                end
            end
        )
    end
end

local PROFESSION_ALIASES = {
    alch = "alchemy",
    bs = "blacksmithing",
    ench = "enchanting",
    eng = "engineering",
    herb = "herbalism",
    lw = "leatherworking",
    mine = "mining",
    skin = "skinning",
    tailor = "tailoring",
    cook = "cooking",
    fish = "fishing",
    fa = "first aid",
    firstaid = "first aid",
}

-- Forever's guild tradeskill roster only exposes the primary/guild-visible
-- profession headers. Secondary professions such as Cooking/Fishing/First Aid
-- are still exposed by GetProfessions/GetProfessionInfo and can be queried
-- directly by skillLineID.
local FOREVER_SECONDARY_SKILL_LINES = {
    ["cooking"] = 185,
    ["fishing"] = 356,
    ["first aid"] = 129,
}

local function resolveGuildSkillLine(value)
    if value == nil then
        return nil
    end

    local numeric = tonumber(value)
    if numeric then
        return numeric
    end

    local wanted =
        string.lower(
            tostring(value)
        )

    wanted =
        PROFESSION_ALIASES[wanted]
        or wanted

    -- Prefer the live Forever client values for the logged-in character.
    -- This is important for secondary professions because they do not appear
    -- in the guild tradeskill header list.
    if type(GetProfessions) == "function"
        and type(GetProfessionInfo) == "function" then
        local professions = { GetProfessions() }

        for index = 1, 6 do
            local professionIndex =
                professions[index]

            if professionIndex then
                local info = { pcall(GetProfessionInfo, professionIndex) }
                local ok = table.remove(info, 1)

                if ok then
                    local professionName = info[1]
                    local skillLineID = info[7]

                    if type(professionName) == "string"
                        and skillLineID
                        and string.lower(professionName) == wanted then
                        return tonumber(skillLineID), professionName
                    end
                end
            end
        end
    end

    local secondarySkillLine =
        FOREVER_SECONDARY_SKILL_LINES[wanted]

    if secondarySkillLine then
        local displayName =
            wanted:gsub(
                "^%l",
                string.upper
            )

        return secondarySkillLine, displayName
    end

    if type(GetNumGuildTradeSkill) ~= "function"
        or type(GetGuildTradeSkillInfo) ~= "function" then
        return nil
    end

    local count =
        firstNumber(GetNumGuildTradeSkill)

    for index = 1, count do
        local result = { pcall(GetGuildTradeSkillInfo, index) }
        local ok = table.remove(result, 1)

        if ok then
            local skillId = result[1]
            local headerName = result[4]

            if skillId
                and type(headerName) == "string"
                and string.lower(headerName) == wanted then
                return tonumber(skillId), headerName
            end
        end
    end
end

function FDB:PrintGuildRecipeHelp()
    print(PREFIX, "recipe usage:")
    print(PREFIX, "/fdb recipe <profession>  - current character")
    print(PREFIX, "/fdb recipe <member> <profession>")
    print(PREFIX, "profession may be a name, alias or skillLineID")
    print(PREFIX, "aliases: alch, bs, ench, eng, herb, lw, mine, skin, tailor, cook, fish, fa")
    print(PREFIX, "secondary: Cooking=185, Fishing=356, First Aid=129")

    if type(GetNumGuildTradeSkill) == "function"
        and type(GetGuildTradeSkillInfo) == "function" then
        local count =
            firstNumber(GetNumGuildTradeSkill)

        local names = {}

        for index = 1, count do
            local result = { pcall(GetGuildTradeSkillInfo, index) }
            local ok = table.remove(result, 1)

            if ok then
                local skillId = result[1]
                local headerName = result[4]

                if skillId
                    and type(headerName) == "string" then
                    names[#names + 1] =
                        headerName ..
                        "=" ..
                        tostring(skillId)
                end
            end
        end

        if #names > 0 then
            print(
                PREFIX,
                "guild professions:",
                table.concat(
                    names,
                    ", "
                )
            )
        end
    end
end

function FDB:RunGuildRecipeCommand(argument)
    argument =
        type(argument) == "string"
        and argument:match("^%s*(.-)%s*$")
        or ""

    if argument == "" then
        self:PrintGuildRecipeHelp()
        return
    end

    local memberName
    local professionValue

    -- A single argument targets the logged-in character:
    -- /fdb recipe alch
    -- /fdb recipe 171
    if not argument:find("%s") then
        memberName =
            UnitName
            and UnitName("player")
            or nil
        professionValue = argument
    else
        -- With multiple words, the last token is the profession and everything
        -- before it is the member name:
        -- /fdb recipe Vesti Stormchaser alch
        -- /fdb recipe Vesti Stormchaser 171
        memberName, professionValue =
            argument:match("^(.-)%s+(%S+)$")
    end

    if not memberName
        or memberName == ""
        or not professionValue then
        self:PrintGuildRecipeHelp()
        return
    end

    local skillLineID, canonicalProfession =
        resolveGuildSkillLine(
            professionValue
        )

    if not skillLineID then
        print(
            PREFIX,
            "guildrecipe: unknown profession:",
            tostring(professionValue)
        )
        self:PrintGuildRecipeHelp()
        return
    end

    print(
        PREFIX,
        "guildrecipe:",
        tostring(memberName),
        "profession=" ..
        tostring(
            canonicalProfession
            or professionValue
        ),
        "skillLine=" ..
        tostring(skillLineID)
    )

    self:RunGuildRecipeProbe(
        memberName,
        skillLineID
    )
end

function FDB:RunGuildRecipeProbe(memberName, skillLineID)
    self:InitializeGuildApiProbe()

    skillLineID = tonumber(skillLineID)

    if type(memberName) ~= "string"
        or memberName == ""
        or not skillLineID then
        print(PREFIX, "usage: /fdb guildrecipe <member name> <skillLineID>")
        print(PREFIX, "example: /fdb guildrecipe Vesti Stormchaser 171")
        return
    end

    if not (C_GuildInfo
        and type(C_GuildInfo.QueryGuildMemberRecipes) == "function") then
        print(PREFIX, "guildrecipe: QueryGuildMemberRecipes unavailable")
        return
    end

    local guid
    local canonicalName
    local lookupError

    local playerName =
        UnitName
        and UnitName("player")
        or nil

    -- /fdb recipe <profession> targets the logged-in character. Do not
    -- depend on the guild-roster cache for that case: Forever can expose
    -- a short UnitName ("Vesperix") while the guild roster contains a
    -- display/surname form ("Vesperix Vane").
    if playerName
        and normalizeGuildName(memberName)
            == normalizeGuildName(playerName) then
        guid =
            UnitGUID
            and UnitGUID("player")
            or nil
        canonicalName = playerName
    end

    if not guid then
        guid, canonicalName, lookupError =
            findGuildMemberGuid(memberName)
    end

    if not guid then
        if lookupError == "ambiguous" then
            print(
                PREFIX,
                "guildrecipe: member prefix is ambiguous; type a few more letters:",
                memberName
            )
        else
            print(
                PREFIX,
                "guildrecipe: guild member not found:",
                memberName
            )
        end
        return
    end

    recipeProbeGeneration = recipeProbeGeneration + 1
    recipeProbePending = true
    reverseRecipeQueryPending = false
    legacyRecipeFallbackPending = false

    local rosterName =
        findGuildMemberNameByGuid(guid)

    recipeTarget = {
        name = canonicalName or memberName,
        rosterName = rosterName,
        guid = guid,
        skillLineID = skillLineID,
    }

    probeFrame:RegisterEvent("TRADE_SKILL_SHOW")

    print(
        PREFIX,
        "guildrecipe: querying",
        recipeTarget.name,
        "guid=" .. tostring(guid),
        "skillLine=" .. tostring(skillLineID)
    )
    print(PREFIX, "guildrecipe: this may open the TradeSkill window; nothing is persisted or uploaded")

    local ok, err =
        pcall(
            C_GuildInfo.QueryGuildMemberRecipes,
            guid,
            skillLineID
        )

    print(
        PREFIX,
        "guildrecipe: member recipe request=" .. tostring(ok),
        ok and "" or tostring(err)
    )

    if not ok then
        recipeProbePending = false
        probeFrame:UnregisterEvent("TRADE_SKILL_SHOW")
        return
    end

    local generation = recipeProbeGeneration

    if C_Timer and C_Timer.After then
        C_Timer.After(
            5,
            function()
                if recipeProbePending
                    and generation == recipeProbeGeneration
                    and not reverseRecipeQueryPending then
                    probeFrame:UnregisterEvent("TRADE_SKILL_SHOW")
                    print(PREFIX, "guildrecipe: timeout waiting for TRADE_SKILL_SHOW")
                    startLegacyGuildRecipeFallback()
                end
            end
        )
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
            elseif event == "TRADE_SKILL_SHOW"
                and recipeProbePending then
                handleMemberTradeSkillShow()
            elseif event == "GUILD_RECIPE_KNOWN_BY_MEMBERS"
                and reverseRecipeQueryPending then
                finishReverseRecipeQuery(
                    "GUILD_RECIPE_KNOWN_BY_MEMBERS received"
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
    availability("ViewGuildRecipes", ViewGuildRecipes)
    availability("CanViewGuildRecipes", CanViewGuildRecipes)
    availability("GetGuildRecipeMember", GetGuildRecipeMember)
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
    namespaceAvailability(
        "C_TradeSkillUI.GetAllRecipeIDs",
        C_TradeSkillUI,
        "GetAllRecipeIDs"
    )
    namespaceAvailability(
        "C_TradeSkillUI.GetRecipeInfo",
        C_TradeSkillUI,
        "GetRecipeInfo"
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
