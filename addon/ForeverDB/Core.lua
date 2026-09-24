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
        FDB:Debug("loaded", FDB.VERSION, "schema", FDB.SCHEMA_VERSION)
    elseif event == "PLAYER_LOGOUT" then
        FDB:PrepareForSave()
    end
end)
