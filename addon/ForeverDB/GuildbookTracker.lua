local _, FDB = ...

local trackerFrame
local refreshPending = false
local professionCapturePending = false
local professionCaptureGeneration = 0
local expandedSkillLines = {}
local lastRefreshAt = 0

local function now()
    if GetServerTime then
        return GetServerTime()
    end

    return time()
end

local function normalizeName(value)
    if type(value) ~= "string" then
        return ""
    end

    return string.lower(
        value:match("^([^%-]+)")
        or value
    )
end

local function guildKey(guildName, realmName)
    return tostring(realmName or "")
        .. "|"
        .. tostring(guildName or "")
end

local function getCurrentGuild()
    if type(IsInGuild) ~= "function"
        or not IsInGuild()
        or type(GetGuildInfo) ~= "function" then
        return nil
    end

    local guildName =
        select(
            1,
            GetGuildInfo("player")
        )

    if type(guildName) ~= "string"
        or guildName == "" then
        return nil
    end

    local realmName =
        type(GetRealmName) == "function"
        and GetRealmName()
        or ""

    local key =
        guildKey(
            guildName,
            realmName
        )

    FDB.DB.guilds =
        FDB.DB.guilds
        or {}

    local guild =
        FDB.DB.guilds[key]

    if not guild then
        guild = {
            guildKey = key,
            name = guildName,
            realmName = realmName,
            capturedAt = now(),
            members = {},
        }

        FDB.DB.guilds[key] = guild
    end

    guild.guildKey = key
    guild.name = guildName
    guild.realmName = realmName
    guild.members = guild.members or {}

    return guild
end

local function lastOnlineHours(index, online)
    if online
        or type(GetGuildRosterLastOnline) ~= "function" then
        return 0
    end

    local ok, years, months, days, hours =
        pcall(
            GetGuildRosterLastOnline,
            index
        )

    if not ok then
        return 0
    end

    return math.floor(
        (tonumber(years) or 0) * 8760
        + (tonumber(months) or 0) * 720
        + (tonumber(days) or 0) * 24
        + (tonumber(hours) or 0)
    )
end

local function captureOwnProfessions(guild)
    if not guild
        or type(GetProfessions) ~= "function"
        or type(GetProfessionInfo) ~= "function"
        or type(UnitGUID) ~= "function" then
        return
    end

    local playerGuid =
        UnitGUID("player")

    if type(playerGuid) ~= "string" then
        return
    end

    local member =
        guild.members[playerGuid]

    if not member then
        local playerName =
            type(UnitName) == "function"
            and UnitName("player")
            or "Player"

        local className, classFile

        if type(UnitClass) == "function" then
            className, classFile =
                UnitClass("player")
        end

        member = {
            guid = playerGuid,
            name = playerName,
            className = className,
            classFile = classFile,
            level =
                type(UnitLevel) == "function"
                and UnitLevel("player")
                or 0,
            rankName = "",
            rankIndex = -1,
            online = true,
            zone =
                type(GetRealZoneText) == "function"
                and GetRealZoneText()
                or "",
            lastOnlineHours = 0,
            professions = {},
        }

        guild.members[playerGuid] = member
    end

    member.professions =
        member.professions
        or {}

    local p1, p2, archaeology, fishing, cooking, firstAid =
        GetProfessions()

    local professionIndexes = {
        p1,
        p2,
        archaeology,
        fishing,
        cooking,
        firstAid,
    }

    for index = 1, 6 do
        local professionIndex =
            professionIndexes[index]

        if professionIndex then
            local result = {
                pcall(
                    GetProfessionInfo,
                    professionIndex
                )
            }

            local ok =
                table.remove(
                    result,
                    1
                )

            if ok then
                local professionName = result[1]
                local skill = tonumber(result[3]) or 0
                local maxSkill = tonumber(result[4]) or 0
                local skillLineId = tonumber(result[7])

                if skillLineId then
                    local existing =
                        member.professions[tostring(skillLineId)]
                        or {}

                    existing.skillLineId = skillLineId
                    existing.name =
                        professionName
                        or existing.name
                        or ""
                    existing.skill = skill
                    existing.maxSkill = maxSkill
                    existing.source = "self"
                    existing.isSecondary =
                        professionIndex == archaeology
                        or professionIndex == fishing
                        or professionIndex == cooking
                        or professionIndex == firstAid

                    member.professions[tostring(skillLineId)] =
                        existing
                end
            end
        end
    end
end

local function captureRoster()
    local guild =
        getCurrentGuild()

    if not guild
        or type(GetNumGuildMembers) ~= "function"
        or type(GetGuildRosterInfo) ~= "function" then
        return false
    end

    local oldMembers =
        guild.members
        or {}

    local members = {}
    local total =
        select(
            1,
            GetNumGuildMembers()
        )

    total =
        tonumber(total)
        or 0

    for index = 1, total do
        local result = {
            pcall(
                GetGuildRosterInfo,
                index
            )
        }

        local ok =
            table.remove(
                result,
                1
            )

        if ok then
            local name = result[1]
            local rankName = result[2]
            local rankIndex = tonumber(result[3]) or -1
            local level = tonumber(result[4]) or 0
            local className = result[5]
            local zone = result[6]
            local online = result[9] and true or false
            local classFile = result[11]
            local guid = result[17]

            if type(guid) == "string"
                and guid ~= "" then
                local old =
                    oldMembers[guid]

                members[guid] = {
                    guid = guid,
                    name = name or "",
                    className = className or "",
                    classFile = classFile or "",
                    level = level,
                    rankName = rankName or "",
                    rankIndex = rankIndex,
                    online = online,
                    zone = zone or "",
                    lastOnlineHours =
                        lastOnlineHours(
                            index,
                            online
                        ),
                    professions =
                        old
                        and old.professions
                        or {},
                }
            end
        end
    end

    guild.members = members
    guild.capturedAt = now()

    captureOwnProfessions(guild)

    FDB.DB.updatedAt = now()

    return true
end

local function captureGuildTradeSkills()
    local guild =
        getCurrentGuild()

    if not guild
        or type(GetNumGuildTradeSkill) ~= "function"
        or type(GetGuildTradeSkillInfo) ~= "function" then
        return false
    end

    local count =
        select(
            1,
            GetNumGuildTradeSkill()
        )

    count =
        tonumber(count)
        or 0

    local currentHeaderName = ""
    local currentSkillLineId

    for index = 1, count do
        local result = {
            pcall(
                GetGuildTradeSkillInfo,
                index
            )
        }

        local ok =
            table.remove(
                result,
                1
            )

        if ok then
            local skillLineId = tonumber(result[1])
            local headerName = result[4]
            local playerName = result[8]
            local skill = tonumber(result[13]) or 0

            if type(headerName) == "string"
                and headerName ~= "" then
                currentHeaderName = headerName
                currentSkillLineId = skillLineId
            elseif type(playerName) == "string"
                and playerName ~= ""
                and currentSkillLineId then
                local wanted =
                    normalizeName(playerName)

                for _, member in pairs(guild.members or {}) do
                    if normalizeName(member.name) == wanted then
                        member.professions =
                            member.professions
                            or {}

                        local key =
                            tostring(
                                currentSkillLineId
                            )

                        local existing =
                            member.professions[key]
                            or {}

                        existing.skillLineId =
                            currentSkillLineId
                        existing.name =
                            currentHeaderName
                        existing.skill =
                            skill
                        existing.maxSkill =
                            existing.maxSkill
                            or 0
                        existing.source = "guild"
                        existing.isSecondary = false

                        member.professions[key] =
                            existing

                        break
                    end
                end
            end
        end
    end

    captureOwnProfessions(guild)

    guild.capturedAt = now()
    FDB.DB.updatedAt = now()

    return true
end

local function restoreExpandedHeaders()
    if type(CollapseGuildTradeSkillHeader) == "function" then
        for _, skillLineId in ipairs(expandedSkillLines) do
            pcall(
                CollapseGuildTradeSkillHeader,
                skillLineId
            )
        end
    end

    expandedSkillLines = {}
end

local function finishProfessionCapture()
    if not professionCapturePending then
        return
    end

    professionCapturePending = false

    if trackerFrame then
        trackerFrame:UnregisterEvent(
            "GUILD_TRADESKILL_UPDATE"
        )
    end

    captureGuildTradeSkills()
    restoreExpandedHeaders()

    if FDB.BuildExportSnapshot then
        FDB:BuildExportSnapshot()
    end
end

local function startProfessionCapture()
    if professionCapturePending
        or type(GetNumGuildTradeSkill) ~= "function"
        or type(GetGuildTradeSkillInfo) ~= "function" then
        captureOwnProfessions(
            getCurrentGuild()
        )

        if FDB.BuildExportSnapshot then
            FDB:BuildExportSnapshot()
        end

        return
    end

    if type(QueryGuildRecipes) == "function" then
        pcall(QueryGuildRecipes)
    end

    local count =
        select(
            1,
            GetNumGuildTradeSkill()
        )

    count =
        tonumber(count)
        or 0

    local collapsedSkillLines = {}

    for index = 1, count do
        local result = {
            pcall(
                GetGuildTradeSkillInfo,
                index
            )
        }

        local ok =
            table.remove(
                result,
                1
            )

        if ok then
            local skillLineId =
                tonumber(result[1])
            local isCollapsed =
                result[2]
            local headerName =
                result[4]

            if skillLineId
                and headerName
                and isCollapsed then
                collapsedSkillLines[
                    #collapsedSkillLines + 1
                ] = skillLineId
            end
        end
    end

    expandedSkillLines = {}

    if type(ExpandGuildTradeSkillHeader) == "function" then
        for _, skillLineId in ipairs(collapsedSkillLines) do
            local ok =
                pcall(
                    ExpandGuildTradeSkillHeader,
                    skillLineId
                )

            if ok then
                expandedSkillLines[
                    #expandedSkillLines + 1
                ] = skillLineId
            end
        end
    end

    professionCaptureGeneration =
        professionCaptureGeneration + 1

    local generation =
        professionCaptureGeneration

    professionCapturePending = true

    if trackerFrame then
        trackerFrame:RegisterEvent(
            "GUILD_TRADESKILL_UPDATE"
        )
    end

    if C_Timer and C_Timer.After then
        C_Timer.After(
            2,
            function()
                if professionCapturePending
                    and generation == professionCaptureGeneration then
                    finishProfessionCapture()
                end
            end
        )
    else
        finishProfessionCapture()
    end
end

function FDB:RefreshGuildbook(reason)
    if not self.DB
        or type(IsInGuild) ~= "function"
        or not IsInGuild() then
        return
    end

    local currentTime =
        GetTime
        and GetTime()
        or 0

    if refreshPending
        or currentTime - lastRefreshAt < 3 then
        return
    end

    refreshPending = true
    lastRefreshAt = currentTime

    captureRoster()

    if C_GuildInfo
        and type(C_GuildInfo.GuildRoster) == "function" then
        pcall(
            C_GuildInfo.GuildRoster
        )
    end

    if C_Timer and C_Timer.After then
        C_Timer.After(
            1,
            function()
                refreshPending = false
                captureRoster()
                startProfessionCapture()
            end
        )
    else
        refreshPending = false
        startProfessionCapture()
    end

    self:Debug(
        "guildbook refresh",
        reason or "manual"
    )
end

function FDB:InitializeGuildbookTracker()
    if trackerFrame then
        return
    end

    trackerFrame =
        CreateFrame(
            "Frame"
        )

    trackerFrame:RegisterEvent(
        "PLAYER_GUILD_UPDATE"
    )
    trackerFrame:RegisterEvent(
        "GUILD_ROSTER_UPDATE"
    )
    trackerFrame:RegisterEvent(
        "SKILL_LINES_CHANGED"
    )

    trackerFrame:SetScript(
        "OnEvent",
        function(_, event)
            if event == "GUILD_TRADESKILL_UPDATE"
                and professionCapturePending then
                finishProfessionCapture()
                return
            end

            if event == "GUILD_ROSTER_UPDATE" then
                captureRoster()
                return
            end

            if event == "PLAYER_GUILD_UPDATE" then
                if C_Timer and C_Timer.After then
                    C_Timer.After(
                        1,
                        function()
                            FDB:RefreshGuildbook(
                                "guild-change"
                            )
                        end
                    )
                else
                    FDB:RefreshGuildbook(
                        "guild-change"
                    )
                end
                return
            end

            if event == "SKILL_LINES_CHANGED" then
                captureOwnProfessions(
                    getCurrentGuild()
                )

                if FDB.BuildExportSnapshot then
                    FDB:BuildExportSnapshot()
                end
            end
        end
    )

    if C_Timer and C_Timer.After then
        C_Timer.After(
            3,
            function()
                FDB:RefreshGuildbook(
                    "startup"
                )
            end
        )
    end
end
