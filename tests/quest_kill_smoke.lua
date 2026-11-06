local FDB={DB={questJournal={}}, ParseSourceGuid=function(_,g) return "creature",tonumber(g:match("%-(%d+)%-2$") or g:match("%-(%d+)$")) end,
 GetCurrentLocation=function() return {mapId=85,zoneName="Tirisfal Glades",subZoneName="Deathknell",x=31,y=66} end}
local player="Player-1-test"
local target="Creature-0-0-0-0-1501"
local title="The Mindless Ones"
local objective="Mindless Zombie slain: 0/8"
local frames={}
UnitGUID=function(unit) if unit=="player" then return player elseif unit=="target" then return target end end
UnitName=function(unit) if unit=="target" then return "Mindless Zombie" end end
GetServerTime=function() return 1000 end
GetTime=function() return 10 end
UnitIsDead=function() return false end
CombatLogGetCurrentEventInfo=function() return nil end
GetLocale=function() return "enUS" end
GetBuildInfo=function() return "1.60.1" end
C_QuestLog={GetQuestObjectives=function() return {{text=objective,type="monster",numFulfilled=tonumber(objective:match("(%d+)/")),numRequired=8}} end}
C_TooltipInfo={GetUnit=function() return {lines={{type=17,leftText=title},{type=8,leftText=objective}}} end}
CreateFrame=function()
 local f={events={}}
 function f:RegisterEvent(e) self.events[e]=true end
 function f:SetScript(_,fn) self.handler=fn end
 frames[#frames+1]=f;return f
end
local function emit(e,...) for _,f in ipairs(frames) do if f.events[e] then f.handler(f,e,...) end end end
FDB.DB.questJournal[player]={entries={["364"]={questId=364,title=title,status="active",objectives={{text=objective,kind="monster",numFulfilled=0,numRequired=8}}}}}
assert(loadfile("addon/ForeverDB/QuestKillTracker.lua"))("ForeverDB",FDB)
FDB:InitializeQuestKillTracker()
emit("PLAYER_TARGET_CHANGED")
local q=FDB.DB.questJournal[player].entries["364"]
assert(q.mobObservations and q.mobObservations["1:1501"])
assert(q.mobObservations["1:1501"].tooltipMatches==1)
assert(q.mobObservations["1:1501"].location.mapId==85)
emit("PLAYER_TARGET_CHANGED")
assert(q.mobObservations["1:1501"].tooltipMatches==1)
objective="Mindless Zombie slain: 1/8"
emit("QUEST_LOG_UPDATE"); emit("QUEST_LOG_UPDATE")
assert(q.progressChanges and q.progressChanges[1]==1)
q.objectives[1].numFulfilled=0 -- delayed objective refresh/reload baseline
emit("QUEST_LOG_UPDATE")
assert(q.progressChanges[1]==1)
assert(q.mobObservations["1:1501"].observedDeaths==0)
UnitIsDead=function(unit) return unit=="target" end
emit("UNIT_HEALTH","target"); emit("UNIT_HEALTH","target")
assert(q.mobObservations["1:1501"].observedDeaths==1)
CombatLogGetCurrentEventInfo=function() return 1,"UNIT_DIED",nil,nil,nil,nil,nil,"Creature-0-0-0-0-1501" end
emit("COMBAT_LOG_EVENT_UNFILTERED"); emit("COMBAT_LOG_EVENT_UNFILTERED")
assert(q.mobObservations["1:1501"].observedDeaths==1)
target="Creature-0-0-0-0-1502"; objective="Wretched Zombie slain: 0/8"
q.objectives[2]={text=objective,kind="monster",numFulfilled=0,numRequired=8}
emit("PLAYER_TARGET_CHANGED")
assert(q.mobObservations["2:1502"])
target="Creature-0-0-0-0-1501-2"; objective="Mindless Zombie slain: 1/8"
FDB.GetCurrentLocation=function() return {mapId=85,zoneName="Tirisfal Glades",subZoneName="Deathknell",x=32,y=67} end
emit("PLAYER_TARGET_CHANGED")
assert(q.mobObservations["1:1501"].locations and q.mobObservations["1:1501"].locations["85:32:67"])
title="Another quest"
emit("PLAYER_TARGET_CHANGED")
assert(not q.mobObservations["1:999"])
q.status="removed"; title="The Mindless Ones"; target="Creature-0-0-0-0-999"
emit("PLAYER_TARGET_CHANGED")
assert(not q.mobObservations["1:999"])
print("PASS: distinct tooltip mobs, dedupe, progress, no loot dependency, removed quest exclusion")

-- Optional death APIs may be missing on a client build; core observations
-- and progress events must still register without invoking protected pcall.
CombatLogGetCurrentEventInfo=nil; UnitIsDead=nil
local optional={DB={questJournal={}}}
assert(loadfile("addon/ForeverDB/QuestKillTracker.lua"))("ForeverDB",optional)
optional:InitializeQuestKillTracker()
local optionalFrame=frames[#frames]
assert(optionalFrame.events.PLAYER_TARGET_CHANGED)
assert(optionalFrame.events.QUEST_LOG_UPDATE)
assert(not optionalFrame.events.COMBAT_LOG_EVENT_UNFILTERED)
assert(not optionalFrame.events.UNIT_HEALTH)
print("PASS: unavailable death APIs keep safe core subscriptions")
