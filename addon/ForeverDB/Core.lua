local addonName, FDB = ...

FDB = FDB or {}
_G[addonName] = FDB

FDB.VERSION = "0.3.15-alpha"
FDB.SCHEMA_VERSION = 8
FDB.DEBUG = true

local PREFIX = "|cff7dd3fcForeverDB|r"

function FDB:Debug(...)
    if not self.DEBUG then return end
    print(PREFIX, ...)
end

function FDB:PrintStatus()
    local db = self.DB
    if not db then
        print(PREFIX, "database not initialized")
        return
    end

    local stats = self:GetDatabaseStats()

    print(PREFIX, self.VERSION)
    print("schema:", db.schemaVersion, "sources:", stats.sourceCount)
    print(
        "mob:", stats.byKind.mob or 0,
        "skinning:", stats.byKind.skinning or 0,
        "mining:", stats.byKind.mining or 0,
        "herbalism:", stats.byKind.herbalism or 0,
        "fishing:", stats.byKind.fishing or 0,
        "pools:", stats.byKind.fishing_pool or 0,
        "chest:", stats.byKind.chest or 0,
        "disenchant:", stats.byKind.disenchant or 0
    )
    print("unresolved loot windows:", stats.unresolvedLootWindows)
    print("installation:", db.installationId or "missing")
    print("export bytes:", type(ForeverDB_Export) == "string" and #ForeverDB_Export or 0)
end

function FDB:PrintLastObservation()
    local last = self.DB and self.DB.lastObservation
    if not last then
        print(PREFIX, "no observation recorded yet")
        return
    end

    print(
        PREFIX,
        "last:",
        last.kind or "?",
        last.sourceType or "?",
        last.sourceId or "?",
        last.sourceName or ""
    )
    print(
        "items:", last.itemKinds or 0,
        "quest items:", last.questItemKinds or 0,
        "quantity:", last.totalQuantity or 0,
        "level:", (last.sourceLevel and last.sourceLevel > 0) and last.sourceLevel or "?"
    )
end

local function registerSlashCommands()
    SLASH_FOREVERDB1 = "/fdb"
    SlashCmdList.FOREVERDB = function(message)
        local rawCommand =
            (message or ""):match("^%s*(.-)%s*$")
        local command =
            rawCommand:lower()

        if command == "" or command == "status" then
            FDB:PrintStatus()
        elseif command == "last" then
            FDB:PrintLastObservation()
        elseif command == "export" then
            FDB:BuildExportSnapshot()
            print(PREFIX, "export snapshot rebuilt:", #ForeverDB_Export, "bytes")
        elseif command:match("^item%s+") then
            local argument = command:match("^item%s+(.+)$")
            local itemId = tonumber(argument or "")
            if not itemId and argument then
                itemId = tonumber(argument:match("item:(%d+)"))
            end

            if itemId then
                FDB:PrintItemSources(itemId, 20)
            else
                print(PREFIX, "usage: /fdb item <itemID or item link>")
            end
        elseif command == "guildapi"
            or command == "guild" then
            FDB:RunGuildApiProbe()
        elseif command == "recipe"
            or command == "guildrecipe"
            or command == "gr" then
            FDB:PrintGuildRecipeHelp()
        elseif command:match("^recipe%s+")
            or command:match("^guildrecipe%s+")
            or command:match("^gr%s+") then
            local argument =
                rawCommand:match("^%S+%s+(.+)$")

            FDB:RunGuildRecipeCommand(
                argument
            )
        elseif command == "debug" then
            FDB.DEBUG = not FDB.DEBUG
            print(PREFIX, "debug:", FDB.DEBUG and "on" or "off")
        else
            print(PREFIX, "commands: /fdb status, /fdb last, /fdb export, /fdb item <id/link>, /fdb guild, /fdb recipe <profession>, /fdb recipe <member> <profession>, /fdb debug")
        end
    end
end

local frame = CreateFrame("Frame")
FDB.EventFrame = frame

frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_LOGOUT")

frame:SetScript("OnEvent", function(_, event, ...)
    if event == "ADDON_LOADED" then
        local loadedAddon = ...
        if loadedAddon ~= addonName then return end

        FDB:InitializeDatabase()
        FDB:InitializeGuildApiProbe()
        FDB:InitializeGatheringTracker()
        FDB:InitializeSkinningTracker()
        FDB:InitializeFishingPoolTracker()
        FDB:InitializeDisenchantTracker()
        FDB:InitializeLootTracker()
        FDB:InitializeTooltip()
        registerSlashCommands()
        FDB:BuildExportSnapshot()

        FDB:Debug("loaded", FDB.VERSION, "schema", FDB.SCHEMA_VERSION)
    elseif event == "PLAYER_LOGIN" then
        FDB:EnsureInstallationId()

        if C_Map and C_Map.GetBestMapForUnit then
            local mapId =
                C_Map.GetBestMapForUnit("player")

            if mapId and FDB.CaptureMapMetadata then
                FDB:CaptureMapMetadata(mapId)
            end
        end

        FDB:BuildExportSnapshot()
    elseif event == "PLAYER_LOGOUT" then
        FDB:PrepareForSave()
    end
end)
