-- Run from repository root: lua5.4 tests/guildbook_capture_smoke.lua
-- API tuple shapes follow the addon Guild API probe and the legacy WoW: Forever guild API.
local timers, frames = {}, {}
local now = 1783530000
local gameTime = 100
local playerGuid = "Player-0-AAAA"
local calls = { roster = 0, guildRoster = 0 }

GetTime = function() return gameTime end
GetServerTime = function() return now end
time = function() return now end
GetTimePreciseSec = function() return 100.25 end
UnitGUID = function(unit) return unit == "player" and playerGuid or nil end
UnitName = function(unit) return unit == "player" and "GuildLeader" or nil end
UnitClass = function() return "Mage", "MAGE" end
UnitLevel = function() return 60 end
GetRealZoneText = function() return "Stormwind" end
GetRealmName = function() return "Forever" end
IsInGuild = function() return true end
GetGuildInfo = function() return "Local Guild", "Guild Master", 0 end
GetNumGuildMembers = function() return 2 end
GetGuildRosterInfo = function(index)
    calls.roster = calls.roster + 1
    if index == 1 then
        return "GuildLeader", "Guild Master", 0, 60, "Mage", "Stormwind", nil, nil, true,
            "Interface\\Icons\\INV_Misc_QuestionMark", "MAGE", false, false, false, false, false, playerGuid
    end
    return "Azer", "Officer", 1, 60, "Rogue", "Ironforge", nil, nil, false,
        "Interface\\Icons\\INV_Misc_QuestionMark", "ROGUE", false, false, false, false, false, "Player-0-BBBB"
end
GetGuildRosterLastOnline = function() return 0, 0, 0, 12 end
GetProfessions = function() return 1 end
GetNumGuildTradeSkill = function() return 0 end
GetGuildTradeSkillInfo = function() return nil end
GetProfessionInfo = function(index)
    assert(index == 1)
    return "Blacksmithing", nil, 225, 300, nil, nil, 164
end
C_GuildInfo = { GuildRoster = function() calls.guildRoster = calls.guildRoster + 1 end }
C_Timer = { After = function(_, callback) timers[#timers + 1] = callback end }
CreateFrame = function()
    local frame = { events = {} }
    function frame:RegisterEvent(event) self.events[event] = true end
    function frame:UnregisterEvent(event) self.events[event] = nil end
    function frame:SetScript(_, callback) self.callback = callback end
    frames[#frames + 1] = frame
    return frame
end

local FDB = {
    DB = { installationId = "install-1", guilds = {}, maps = {}, sources = {}, updatedAt = now },
    VERSION = "0.7.1-alpha",
    SCHEMA_VERSION = 9,
    Debug = function() end,
    EnsureInstallationId = function(self) return self.DB.installationId end,
}
assert(loadfile("addon/ForeverDB/Database.lua"))("ForeverDB", FDB)
assert(loadfile("addon/ForeverDB/Exporter.lua"))("ForeverDB", FDB)
assert(loadfile("addon/ForeverDB/GuildbookTracker.lua"))("ForeverDB", FDB)
FDB:InitializeGuildbookTracker()
timers = {} -- discard scheduled startup capture; explicitly exercise the owner's command action below
FDB:RefreshGuildbook("manual-command")
assert(calls.guildRoster == 1, "refresh should request the guild roster")
assert(#timers == 1, "refresh should await roster update before the second capture")
table.remove(timers, 1)()
assert(#timers == 1, "profession capture should wait for guild trade skill update or timeout")
table.remove(timers, 1)()

local guild = assert(FDB.DB.guilds["Forever|Local Guild"])
assert(guild.members["Player-0-AAAA"], "real roster API tuple did not capture the player")
assert(guild.members["Player-0-BBBB"], "real roster API tuple did not capture another member")
local profession = assert(guild.members["Player-0-AAAA"].professions["164"])
assert(profession.name == "Blacksmithing" and profession.skill == 225)
assert(ForeverDB_Export:find("G|Forever%7CLocal Guild|Local Guild|Forever|", 1, true))
assert(ForeverDB_Export:find("C|Forever%7CLocal Guild|Player-0-BBBB|Azer|", 1, true))
assert(ForeverDB_Export:find("P|Forever%7CLocal Guild|Player-0-AAAA|164|Blacksmithing|225|300|self|0", 1, true))

-- Exercise the exact documented slash command through Core's real dispatcher.
SlashCmdList = {}
print = function() end
for _, name in ipairs({
    "InitializeSessionTracker", "InitializeSessionUI", "InitializeGuildApiProbe",
    "InitializeQuestApiProbe", "InitializeQuestKillTracker", "InitializeQuestTracker", "InitializeGatheringTracker",
    "InitializeSkinningTracker", "InitializeFishingPoolTracker", "InitializeDisenchantTracker", "InitializeLootTracker",
    "InitializeTooltip", "SessionPlayerReady", "SessionBeforeLogout",
}) do FDB[name] = function() end end
FDB.InitializeGuildbookTracker = function() end
assert(loadfile("addon/ForeverDB/Core.lua"))("ForeverDB", FDB)
FDB.EventFrame.callback(FDB.EventFrame, "ADDON_LOADED", "ForeverDB")
gameTime = gameTime + 5
local requestsBeforeCommand = calls.guildRoster
SlashCmdList.FOREVERDB("guildbook refresh")
assert(calls.guildRoster == requestsBeforeCommand + 1, "/fdb guildbook refresh did not request the roster")
FDB.EventFrame.callback(FDB.EventFrame, "PLAYER_LOGOUT")
local savedGuild = assert(ForeverDB_Saved.guilds["Forever|Local Guild"], "logout did not retain guild in SavedVariables")
assert(savedGuild.members["Player-0-BBBB"], "logout SavedVariables missed roster members")
assert(ForeverDB_Export:find("P|Forever%7CLocal Guild|Player-0-AAAA|164|Blacksmithing|225|300|self|0", 1, true),
    "logout did not rebuild exported profession snapshot")
print("PASS: explicit guildbook refresh captures legacy guild roster/professions and builds SavedVariables export")
