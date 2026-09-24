local addonName, FDB = ...

FDB = FDB or {}
_G[addonName] = FDB

FDB.VERSION = "0.1.0-alpha"
FDB.SCHEMA_VERSION = 1
FDB.DEBUG = true

function FDB:Debug(...)
    if not self.DEBUG then return end
    print("|cff7dd3fcForeverDB|r", ...)
end

function FDB:PrintStatus()
    local db = self.DB
    if not db then
        print("|cff7dd3fcForeverDB|r database not initialized")
        return
    end

    local mobCount = 0
    local normalObservations = 0
    local skinningObservations = 0

    for _, mob in pairs(db.mobs or {}) do
        mobCount = mobCount + 1
        normalObservations = normalObservations + ((mob.normal and mob.normal.observations) or 0)
        skinningObservations = skinningObservations + ((mob.skinning and mob.skinning.observations) or 0)
    end

    print("|cff7dd3fcForeverDB|r", self.VERSION)
    print("schema:", db.schemaVersion, "mobs:", mobCount)
    print("normal observations:", normalObservations, "skinning observations:", skinningObservations)
    print("installation:", db.installationId or "missing")
end

local frame = CreateFrame("Frame")
FDB.EventFrame = frame

frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_LOGOUT")

frame:SetScript("OnEvent", function(_, event, ...)
    if event == "ADDON_LOADED" then
        local loadedAddon = ...
        if loadedAddon ~= addonName then return end

        FDB:InitializeDatabase()
        FDB:InitializeLootTracker()
        FDB:InitializeSkinningTracker()
        FDB:InitializeTooltip()

        SLASH_FOREVERDB1 = "/fdb"
        SlashCmdList.FOREVERDB = function(message)
            local command = (message or ""):match("^%s*(.-)%s*$"):lower()
            if command == "" or command == "status" then
                FDB:PrintStatus()
            elseif command == "debug" then
                FDB.DEBUG = not FDB.DEBUG
                print("|cff7dd3fcForeverDB|r debug:", FDB.DEBUG and "on" or "off")
            else
                print("|cff7dd3fcForeverDB|r commands: /fdb status, /fdb debug")
            end
        end

        FDB:Debug("loaded", FDB.VERSION, "schema", FDB.SCHEMA_VERSION)
    elseif event == "PLAYER_LOGOUT" then
        FDB:PrepareForSave()
    end
end)
