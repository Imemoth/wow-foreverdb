local _, FDB = ...
-- Local observations only. A tooltip match, death and objective counter change
-- are separate facts; no one of them proves the others caused quest credit.
local frame
local seen = {}
local seenCount = 0
local MAX_SEEN = 200
local function api(fn,...)
    if type(fn) ~= "function" then return nil end
    local ok,a,b,c,d,e,f,g,h=pcall(fn,...)
    if ok then return a,b,c,d,e,f,g,h end
end
local function journal()
    local guid=api(UnitGUID,"player")
    return guid and FDB.DB and FDB.DB.questJournal and FDB.DB.questJournal[guid]
end
local function clean(text)
    if type(text)~="string" then return nil end
    return (text:gsub(":%s*%d+%s*/%s*%d+.*$",""):gsub("^%s+",""):gsub("%s+$",""))
end
local function matchTarget(data)
    if type(data)~="table" or type(data.lines)~="table" then return end
    local titles,objectives={},{}
    for _,line in ipairs(data.lines) do
        if type(line)=="table" then
            local value=clean(line.leftText or line.text)
            if value and line.type==17 then titles[value]=true
            elseif value and line.type==8 then objectives[value]=true end
        end
    end
    local j=journal()
    if not j then return end
    local matches={}
    for _,record in pairs(j.entries or {}) do
        if record.status=="active" and titles[record.title] then
            for i,objective in ipairs(record.objectives or {}) do
                if objective.kind=="monster" and objectives[clean(objective.text)] then
                    matches[#matches+1]={record=record,index=i,objective=objective}
                end
            end
        end
    end
    if #matches~=1 then return end
    return matches[1]
end
function FDB:ObserveQuestMob(unit)
    if unit~="target" and unit~="mouseover" then return end
    local guid=api(UnitGUID,unit)
    if type(guid)~="string" or seen[guid] then return end
    local kind,id=self:ParseSourceGuid(guid)
    if kind~="creature" or type(id)~="number" or id<=0 then return end
    local data=C_TooltipInfo and api(C_TooltipInfo.GetUnit,unit)
    local match=matchTarget(data)
    if not match then return end
    local record=match.record
    local key=tostring(match.index)..":"..tostring(id)
    record.mobObservations=record.mobObservations or {}
    local entry=record.mobObservations[key]
    if not entry then
        local count=0
        for _ in pairs(record.mobObservations) do count=count+1 end
        if count>=100 then return end
        entry={questId=record.questId,objectiveIndex=match.index,
            objectiveText=clean(match.objective.text),npcId=id,
            npcName=api(UnitName,unit),tooltipMatches=0,observedDeaths=0,
            evidence="tooltip_objective_match",locale=api(GetLocale),
            clientBuild=api(GetBuildInfo)}
        record.mobObservations[key]=entry
    end
    entry.tooltipMatches=entry.tooltipMatches+1
    entry.lastSeenAt=api(GetServerTime)
    entry.location=api(self.GetCurrentLocation,self)
    if entry.location and entry.location.mapId then
        entry.locations=entry.locations or {}
        local loc=entry.location
        local locKey=tostring(loc.mapId)..":"..tostring(loc.x or "?")..":"..tostring(loc.y or "?")
        if entry.locations[locKey] then
            entry.locations[locKey].observations=entry.locations[locKey].observations+1
        else
            local count=0
            for _ in pairs(entry.locations) do count=count+1 end
            if count<20 then
                entry.locations[locKey]={mapId=loc.mapId,zoneName=loc.zoneName,
                    subZoneName=loc.subZoneName,x=loc.x,y=loc.y,observations=1}
            end
        end
    end
    if seenCount>=MAX_SEEN then seen={};seenCount=0 end
    seen[guid]={record=record,key=key,at=api(GetTime) or 0,death=false}
    seenCount=seenCount+1
end
function FDB:ObserveQuestMobDeath()
    local _,subevent,_,_,_,_,_,destGuid=api(CombatLogGetCurrentEventInfo)
    if subevent~="UNIT_DIED" then return end
    local item=seen[destGuid]
    if not item or item.death or (api(GetTime) or 0)-item.at>20 then return end
    if item.record.status~="active" then return end
    local entry=item.record.mobObservations and item.record.mobObservations[item.key]
    if not entry then return end
    item.death=true
    entry.observedDeaths=entry.observedDeaths+1
    entry.lastDeathAt=api(GetServerTime)
end
function FDB:ObserveQuestProgress()
    local j=journal()
    if not j or not C_QuestLog then return end
    for _,record in pairs(j.entries or {}) do
        if record.status=="active" then
            local current=api(C_QuestLog.GetQuestObjectives,record.questId)
            if type(current)=="table" then
                for i,objective in ipairs(record.objectives or {}) do
                    local nextObjective=current[i]
                    if objective.kind=="monster" and type(nextObjective)=="table"
                        and type(nextObjective.numFulfilled)=="number"
                        and type(objective.numFulfilled)=="number"
                        and nextObjective.numFulfilled>objective.numFulfilled then
                        record.progressChanges=record.progressChanges or {}
                        record.progressChanges[i]=(record.progressChanges[i] or 0)
                            +(nextObjective.numFulfilled-objective.numFulfilled)
                    end
                end
            end
        end
    end
end
function FDB:PrintQuestMobs(id)
    local j=journal()
    local record=j and j.entries and j.entries[tostring(tonumber(id) or -1)]
    if not record then print("ForeverDB: no local quest record") return end
    for key,entry in pairs(record.mobObservations or {}) do
        local loc=entry.location or {}
        print("ForeverDB: quest mob",key,entry.npcName or "?",
            "tooltip="..entry.tooltipMatches,"deaths="..entry.observedDeaths,
            loc.zoneName or "?",loc.x or "?",loc.y or "?")
    end
    for index,delta in pairs(record.progressChanges or {}) do
        print("ForeverDB: objective progress",index,"delta="..delta,"source=unattributed")
    end
end
function FDB:InitializeQuestKillTracker()
    if frame then return end
    frame=CreateFrame("Frame")
    for _,event in ipairs({"PLAYER_TARGET_CHANGED","UPDATE_MOUSEOVER_UNIT",
        "COMBAT_LOG_EVENT_UNFILTERED","QUEST_LOG_UPDATE"}) do
        pcall(frame.RegisterEvent,frame,event)
    end
    frame:SetScript("OnEvent",function(_,event)
        if event=="PLAYER_TARGET_CHANGED" then FDB:ObserveQuestMob("target")
        elseif event=="UPDATE_MOUSEOVER_UNIT" then FDB:ObserveQuestMob("mouseover")
        elseif event=="COMBAT_LOG_EVENT_UNFILTERED" then FDB:ObserveQuestMobDeath()
        elseif event=="QUEST_LOG_UPDATE" then FDB:ObserveQuestProgress() end
    end)
end
