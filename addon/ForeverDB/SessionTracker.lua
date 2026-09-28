local _, FDB = ...

-- ForeverDB Session Tracker: owns all session lifecycle, persistence, XP/gold
-- accounting, timing and history. SessionUI.lua must read normalized state
-- from this module and never duplicate accounting logic.

local DEFAULT_OFFLINE_TIMEOUT = 3600
local DEFAULT_INACTIVITY_TIMEOUT = 300
local DEFAULT_HISTORY_LIMIT = 30

local sessionIdCounter = 0

local function now()
    if GetServerTime then return GetServerTime() end
    return time()
end

local function normalizeHUDSettings(ui)
    if type(ui) ~= "table" then ui = {} end
    if type(ui.hudShown) ~= "boolean" then ui.hudShown = true end
    if type(ui.hudLocked) ~= "boolean" then ui.hudLocked = false end
    if type(ui.hudPoint) ~= "string" or ui.hudPoint == "" then ui.hudPoint = "TOPLEFT" end
    if type(ui.hudRelativePoint) ~= "string" or ui.hudRelativePoint == "" then
        ui.hudRelativePoint = "TOPLEFT"
    end
    if type(ui.hudX) ~= "number" then ui.hudX = 100 end
    if type(ui.hudY) ~= "number" then ui.hudY = -100 end
    return ui
end

local function newCurrentShell()
    return {
        startedAt = 0,
        trackedSeconds = 0,
        activeSeconds = 0,
        xp = {},
        gold = {},
    }
end

-- Leaf fields on `current` that timing/lifecycle code compares numerically
-- or as booleans. A malformed SavedVariables file (hand-edited, corrupted,
-- or from an incompatible future version) must not crash the tracker; if
-- any of these are wrong-typed, the whole `current` session is discarded
-- and rebuilt fresh rather than propagating impossible accounting state.
local CURRENT_NUMERIC_FIELDS = {
    "startedAt", "lastSeenAt", "checkpointAt", "lastActivityAt",
    "trackedSeconds", "activeSeconds",
}

-- Inner xp/gold leaves accounting code reads with `or 0`/arithmetic. `or 0`
-- only substitutes for nil, not for a wrong-typed truthy value (e.g. a
-- string), so these need the same defend-or-discard treatment as the
-- outer `current` fields above. startCopper/lastCopper may legitimately
-- be nil (no money baseline established yet), so nil is accepted there
-- too -- only a wrong *type* forces a full rebuild.
local CURRENT_XP_NUMERIC_FIELDS = {
    "startLevel", "startXP", "gained", "lastLevel", "lastXP", "lastXPMax",
}
local CURRENT_GOLD_NUMERIC_FIELDS = {
    "startCopper", "lastCopper", "earned", "spent",
}

local function normalizeCurrentShell(current)
    if type(current) ~= "table" then
        return newCurrentShell()
    end

    for _, field in ipairs(CURRENT_NUMERIC_FIELDS) do
        if current[field] ~= nil and type(current[field]) ~= "number" then
            return newCurrentShell()
        end
    end

    if current.paused ~= nil and type(current.paused) ~= "boolean" then
        return newCurrentShell()
    end

    if type(current.xp) ~= "table" then current.xp = {} end
    if type(current.gold) ~= "table" then current.gold = {} end

    for _, field in ipairs(CURRENT_XP_NUMERIC_FIELDS) do
        if current.xp[field] ~= nil and type(current.xp[field]) ~= "number" then
            return newCurrentShell()
        end
    end

    for _, field in ipairs(CURRENT_GOLD_NUMERIC_FIELDS) do
        if current.gold[field] ~= nil and type(current.gold[field]) ~= "number" then
            return newCurrentShell()
        end
    end

    current.startedAt = current.startedAt or 0
    current.trackedSeconds = current.trackedSeconds or 0
    current.activeSeconds = current.activeSeconds or 0
    current.xp.gained = current.xp.gained or 0
    current.gold.earned = current.gold.earned or 0
    current.gold.spent = current.gold.spent or 0

    return current
end

-- A completed-session history entry can be corrupted independently of
-- `current` (a hand-edited SavedVariables file, or a stray non-table
-- value left over from an incompatible future format). SessionUI.lua's
-- formatters already tolerate a wrong-typed *field* on an otherwise
-- valid record (they fall back to "--"), but they cannot tolerate a
-- record itself being a non-table: indexing it errors. Drop only the
-- malformed entries, in place, preserving order and every valid record.
local function normalizeHistoryList(history)
    if type(history) ~= "table" then return {} end

    local cleaned = {}
    for _, record in ipairs(history) do
        if type(record) == "table" then
            cleaned[#cleaned + 1] = record
        end
    end
    return cleaned
end

--- Root persistence access -------------------------------------------------

function FDB:GetSessionsRoot()
    if not self.DB then return nil end

    local sessions = self.DB.sessions
    if type(sessions) ~= "table" then
        sessions = {}
        self.DB.sessions = sessions
    end

    if type(sessions.settings) ~= "table" then
        sessions.settings = {}
    end

    local settings = sessions.settings
    if type(settings.offlineTimeout) ~= "number" or settings.offlineTimeout <= 0 then
        settings.offlineTimeout = DEFAULT_OFFLINE_TIMEOUT
    end
    if type(settings.inactivityTimeout) ~= "number" or settings.inactivityTimeout <= 0 then
        settings.inactivityTimeout = DEFAULT_INACTIVITY_TIMEOUT
    end
    if type(settings.historyLimit) ~= "number" or settings.historyLimit <= 0 then
        settings.historyLimit = DEFAULT_HISTORY_LIMIT
    end

    if type(sessions.characters) ~= "table" then
        sessions.characters = {}
    end

    return sessions
end

function FDB:GetSessionSettings()
    local sessions = self:GetSessionsRoot()
    return sessions and sessions.settings
end

function FDB:GetOrCreateSessionCharacter(guid)
    local sessions = self:GetSessionsRoot()
    if not sessions then return nil end

    -- A character record must be a table to be usable at all. A stray
    -- string/number/boolean (hand-edited or corrupted SavedVariables)
    -- would otherwise error the moment any field on it is written, so it
    -- is treated the same as "no record yet" and rebuilt fresh.
    local char = sessions.characters[guid]
    if type(char) ~= "table" then
        char = {
            name = UnitName and UnitName("player") or nil,
            realm = GetRealmName and GetRealmName() or nil,
            ui = normalizeHUDSettings(nil),
            current = newCurrentShell(),
            history = {},
        }
        sessions.characters[guid] = char
    else
        char.name = (UnitName and UnitName("player")) or char.name
        char.realm = (GetRealmName and GetRealmName()) or char.realm
        char.ui = normalizeHUDSettings(char.ui)
        char.current = normalizeCurrentShell(char.current)
        char.history = normalizeHistoryList(char.history)
    end

    return char
end

function FDB:GetActiveSessionCharacter()
    if not self.SessionState or not self.SessionState.guid then return nil end
    local sessions = self:GetSessionsRoot()
    if not sessions then return nil end
    return sessions.characters[self.SessionState.guid]
end

--- Lifecycle helpers ---------------------------------------------------

local function generateSessionId(nowTs)
    sessionIdCounter = sessionIdCounter + 1
    return tostring(nowTs) .. "-" .. tostring(sessionIdCounter)
end

function FDB:StartNewSession(char, nowTs)
    local level = UnitLevel and UnitLevel("player") or 0
    local xp = UnitXP and UnitXP("player") or 0
    local xpMax = UnitXPMax and UnitXPMax("player") or 0
    local money = GetMoney and GetMoney() or nil

    char.current = {
        id = generateSessionId(nowTs),
        startedAt = nowTs,
        lastSeenAt = nowTs,
        checkpointAt = nowTs,
        lastActivityAt = nowTs,
        paused = false,
        trackedSeconds = 0,
        activeSeconds = 0,
        xp = {
            startLevel = level,
            startXP = xp,
            gained = 0,
            lastLevel = level,
            lastXP = xp,
            lastXPMax = xpMax,
        },
        gold = {
            startCopper = money,
            lastCopper = money,
            earned = 0,
            spent = 0,
        },
    }
end

function FDB:RebaselineCurrentSession(char, nowTs)
    local current = char.current
    current.checkpointAt = nowTs
    current.lastActivityAt = nowTs
    current.lastSeenAt = nowTs
    current.xp.lastLevel = (UnitLevel and UnitLevel("player")) or current.xp.lastLevel
    current.xp.lastXP = (UnitXP and UnitXP("player")) or current.xp.lastXP
    current.xp.lastXPMax = (UnitXPMax and UnitXPMax("player")) or current.xp.lastXPMax
    current.gold.lastCopper = (GetMoney and GetMoney()) or current.gold.lastCopper
end

function FDB:ArchiveCurrentSessionIfMeaningful(char, endedAt)
    local current = char.current
    if not current or not current.startedAt or current.startedAt <= 0 then return end

    local tracked = current.trackedSeconds or 0
    local active = current.activeSeconds or 0
    local xpGained = current.xp.gained or 0
    local earned = current.gold.earned or 0
    local spent = current.gold.spent or 0

    local meaningful = tracked >= 60 or xpGained > 0 or earned > 0 or spent > 0
    if not meaningful then return end

    local net = earned - spent
    local xpPerHour, earnedPerHour, spentPerHour, netPerHour = nil, nil, nil, nil
    if active > 0 then
        xpPerHour = xpGained / active * 3600
        earnedPerHour = earned / active * 3600
        spentPerHour = spent / active * 3600
        netPerHour = net / active * 3600
    end

    local record = {
        id = current.id,
        startedAt = current.startedAt,
        endedAt = endedAt,
        trackedSeconds = tracked,
        activeSeconds = active,
        startLevel = current.xp.startLevel,
        endLevel = current.xp.lastLevel,
        xpGained = xpGained,
        xpPerHour = xpPerHour,
        goldEarned = earned,
        goldSpent = spent,
        netGold = net,
        earnedPerHour = earnedPerHour,
        spentPerHour = spentPerHour,
        netPerHour = netPerHour,
    }

    char.history = char.history or {}
    table.insert(char.history, record)

    local settings = self:GetSessionSettings()
    local limit = (settings and settings.historyLimit) or DEFAULT_HISTORY_LIMIT
    while #char.history > limit do
        table.remove(char.history, 1)
    end
end

--- Timing / checkpoints -------------------------------------------------

function FDB:CheckpointSession(nowTs)
    nowTs = nowTs or now()

    local char = self:GetActiveSessionCharacter()
    if not char then return end

    local current = char.current
    if not current or not current.startedAt or current.startedAt <= 0 then return end

    if current.paused then
        current.lastSeenAt = nowTs
        return
    end

    local settings = self:GetSessionSettings()
    local from = current.checkpointAt or nowTs
    local to = nowTs
    if to < from then to = from end

    local trackedDelta = to - from
    local activeUntil = (current.lastActivityAt or from) + settings.inactivityTimeout
    local activeDelta = math.max(0, math.min(to, activeUntil) - from)

    current.trackedSeconds = (current.trackedSeconds or 0) + trackedDelta
    current.activeSeconds = (current.activeSeconds or 0) + activeDelta
    current.checkpointAt = to
    current.lastSeenAt = to
end

function FDB:RegisterSessionActivity(nowTs)
    nowTs = nowTs or now()

    -- Finalize timing using the PREVIOUS lastActivityAt before moving it
    -- forward, so a new event can never retroactively turn an idle gap
    -- into active time.
    self:CheckpointSession(nowTs)

    local char = self:GetActiveSessionCharacter()
    if char and char.current then
        char.current.lastActivityAt = nowTs
    end
end

--- Public lifecycle interface -------------------------------------------

function FDB:StartSessionCheckpointTicker()
    local interval = 30
    if C_Timer and C_Timer.NewTicker then
        C_Timer.NewTicker(interval, function() self:CheckpointSession() end)
    elseif C_Timer and C_Timer.After then
        local function tick()
            self:CheckpointSession()
            C_Timer.After(interval, tick)
        end
        C_Timer.After(interval, tick)
    end
end

function FDB:InitializeSessionTracker()
    if self.SessionTrackerInitialized then return end
    self.SessionTrackerInitialized = true

    self:GetSessionsRoot()

    local frame = CreateFrame("Frame")
    self.SessionEventFrame = frame
    frame:RegisterEvent("PLAYER_ENTERING_WORLD")
    frame:RegisterEvent("PLAYER_XP_UPDATE")
    frame:RegisterEvent("PLAYER_LEVEL_UP")
    frame:RegisterEvent("PLAYER_MONEY")

    frame:SetScript("OnEvent", function(_, event, ...)
        if event == "PLAYER_ENTERING_WORLD" then
            if not (self.SessionState and self.SessionState.guid) then
                self:SessionPlayerReady()
            end
        elseif event == "PLAYER_XP_UPDATE" or event == "PLAYER_LEVEL_UP" then
            self:HandleSessionXPUpdate()
        elseif event == "PLAYER_MONEY" then
            self:HandleSessionMoneyUpdate()
        end
    end)

    self:StartSessionCheckpointTicker()
end

function FDB:SessionPlayerReady()
    if self.SessionState and self.SessionState.guid then
        return true
    end

    self:GetSessionsRoot()

    local playerGuid = UnitGUID and UnitGUID("player")
    if type(playerGuid) ~= "string" or playerGuid == "" then
        return false
    end

    self:InitializeSessionTracker()

    local char = self:GetOrCreateSessionCharacter(playerGuid)
    if not char then return false end

    local nowTs = now()
    local current = char.current

    if current and current.startedAt and current.startedAt > 0 then
        local settings = self:GetSessionSettings()
        local gap = nowTs - (current.lastSeenAt or nowTs)
        if gap < 0 then gap = 0 end

        if gap <= settings.offlineTimeout then
            self:RebaselineCurrentSession(char, nowTs)
        else
            self:ArchiveCurrentSessionIfMeaningful(char, current.lastSeenAt or nowTs)
            self:StartNewSession(char, nowTs)
        end
    else
        self:StartNewSession(char, nowTs)
    end

    self.SessionState = { guid = playerGuid }
    return true
end

function FDB:SessionBeforeLogout()
    local char = self:GetActiveSessionCharacter()
    if not char or not char.current or not char.current.startedAt
        or char.current.startedAt <= 0 then
        return
    end

    local nowTs = now()
    if not char.current.paused then
        self:CheckpointSession(nowTs)
    end
    char.current.lastSeenAt = nowTs
end

function FDB:PauseSession()
    local char = self:GetActiveSessionCharacter()
    if not char or not char.current or not char.current.startedAt
        or char.current.startedAt <= 0 then
        return false
    end

    if char.current.paused then return true end

    local nowTs = now()
    self:CheckpointSession(nowTs)
    char.current.paused = true
    char.current.lastSeenAt = nowTs
    return true
end

function FDB:ResumeSession()
    local char = self:GetActiveSessionCharacter()
    if not char or not char.current or not char.current.paused then
        return false
    end

    local nowTs = now()
    char.current.paused = false
    self:RebaselineCurrentSession(char, nowTs)
    return true
end

function FDB:ResetSession()
    local char = self:GetActiveSessionCharacter()
    if not char then return false end

    local nowTs = now()
    if char.current and char.current.startedAt and char.current.startedAt > 0 then
        if not char.current.paused then
            self:CheckpointSession(nowTs)
        end
        self:ArchiveCurrentSessionIfMeaningful(char, char.current.lastSeenAt or nowTs)
    end

    self:StartNewSession(char, nowTs)
    return true
end

function FDB:SetSessionOfflineTimeout(minutes)
    local n = tonumber(minutes)
    if not n or n ~= math.floor(n) or n <= 0 then
        return false, "usage: /fdb session timeout <positive integer minutes>"
    end

    local settings = self:GetSessionSettings()
    if not settings then return false, "session tracker not initialized" end
    settings.offlineTimeout = n * 60
    return true
end

function FDB:SetSessionInactivityTimeout(minutes)
    local n = tonumber(minutes)
    if not n or n ~= math.floor(n) or n <= 0 then
        return false, "usage: /fdb session idle <positive integer minutes>"
    end

    local settings = self:GetSessionSettings()
    if not settings then return false, "session tracker not initialized" end
    settings.inactivityTimeout = n * 60
    return true
end

--- XP accounting ---------------------------------------------------------

function FDB:HandleSessionXPUpdate()
    local char = self:GetActiveSessionCharacter()
    if not char or not char.current or char.current.paused then return end
    if not char.current.startedAt or char.current.startedAt <= 0 then return end

    local current = char.current
    local level = UnitLevel and UnitLevel("player")
    local xp = UnitXP and UnitXP("player")
    local xpMax = UnitXPMax and UnitXPMax("player")
    if not level or not xp or not xpMax then return end

    local prevLevel = current.xp.lastLevel
    local prevXP = current.xp.lastXP
    local prevXPMax = current.xp.lastXPMax

    local gained = 0
    local accept = false

    if prevLevel == nil then
        -- No baseline yet; establish one without fabricating gain.
    elseif level == prevLevel then
        local delta = xp - (prevXP or xp)
        if delta > 0 then
            gained = delta
            accept = true
        end
        -- delta == 0: no-op. delta < 0: re-baseline only (handled below).
    elseif level == prevLevel + 1 and type(prevXPMax) == "number" and prevXPMax > 0
        and type(prevXP) == "number" then
        local candidate = (prevXPMax - prevXP) + xp
        if candidate > 0 then
            gained = candidate
            accept = true
        end
    end
    -- Any other transition (level decrease, multi-level jump, impossible
    -- state) re-baselines without fabricating XP.

    if accept and gained > 0 then
        self:RegisterSessionActivity(now())
        current.xp.gained = (current.xp.gained or 0) + gained
    end

    current.xp.lastLevel = level
    current.xp.lastXP = xp
    current.xp.lastXPMax = xpMax
end

--- Gold accounting -------------------------------------------------------

function FDB:HandleSessionMoneyUpdate()
    local char = self:GetActiveSessionCharacter()
    if not char or not char.current or char.current.paused then return end
    if not char.current.startedAt or char.current.startedAt <= 0 then return end

    local current = char.current
    local money = GetMoney and GetMoney()
    if type(money) ~= "number" then return end

    local prev = current.gold.lastCopper
    if type(prev) ~= "number" then
        current.gold.lastCopper = money
        return
    end

    local delta = money - prev
    if delta > 0 then
        self:RegisterSessionActivity(now())
        current.gold.earned = (current.gold.earned or 0) + delta
    elseif delta < 0 then
        self:RegisterSessionActivity(now())
        current.gold.spent = (current.gold.spent or 0) + (-delta)
    end

    current.gold.lastCopper = money
end

--- HUD settings persistence ----------------------------------------------

function FDB:GetSessionHUDSettings()
    local char = self:GetActiveSessionCharacter()
    if not char then return normalizeHUDSettings(nil) end
    char.ui = normalizeHUDSettings(char.ui)
    return char.ui
end

function FDB:SetSessionHUDShown(shown)
    local char = self:GetActiveSessionCharacter()
    if not char then return false end
    char.ui = normalizeHUDSettings(char.ui)
    char.ui.hudShown = shown and true or false
    return true
end

function FDB:SetSessionHUDLocked(locked)
    local char = self:GetActiveSessionCharacter()
    if not char then return false end
    char.ui = normalizeHUDSettings(char.ui)
    char.ui.hudLocked = locked and true or false
    return true
end

function FDB:SetSessionHUDPosition(point, relativePoint, x, y)
    local char = self:GetActiveSessionCharacter()
    if not char then return false end
    char.ui = normalizeHUDSettings(char.ui)
    if type(point) == "string" and point ~= "" then char.ui.hudPoint = point end
    if type(relativePoint) == "string" and relativePoint ~= "" then
        char.ui.hudRelativePoint = relativePoint
    end
    if type(x) == "number" then char.ui.hudX = x end
    if type(y) == "number" then char.ui.hudY = y end
    return true
end

--- Snapshot / history API for the UI -------------------------------------

function FDB:GetSessionSnapshot()
    local char = self:GetActiveSessionCharacter()
    if not char or not char.current or not char.current.startedAt
        or char.current.startedAt <= 0 then
        return nil
    end

    local current = char.current
    local settings = self:GetSessionSettings()
    local nowTs = now()

    local trackedSeconds = current.trackedSeconds or 0
    local activeSeconds = current.activeSeconds or 0

    if not current.paused then
        local from = current.checkpointAt or nowTs
        local to = math.max(nowTs, from)
        trackedSeconds = trackedSeconds + (to - from)
        local activeUntil = (current.lastActivityAt or from) + settings.inactivityTimeout
        activeSeconds = activeSeconds + math.max(0, math.min(to, activeUntil) - from)
    end

    local status
    if current.paused then
        status = "PAUSED"
    elseif (nowTs - (current.lastActivityAt or nowTs)) > settings.inactivityTimeout then
        status = "IDLE"
    else
        status = "RUNNING"
    end

    local xpGained = current.xp.gained or 0
    local xpPerHour = nil
    if activeSeconds > 0 then
        xpPerHour = xpGained / activeSeconds * 3600
    end

    local level = current.xp.lastLevel
    local currentXP = current.xp.lastXP
    local currentXPMax = current.xp.lastXPMax
    -- Max level, or the client exposing no usable next-level requirement
    -- at all (missing/non-numeric), both mean "no ETA to compute" per spec.
    local isMaxLevel = (type(currentXPMax) ~= "number") or currentXPMax <= 0

    local etaSeconds = nil
    if not isMaxLevel and xpPerHour and xpPerHour > 0
        and type(currentXP) == "number" and type(currentXPMax) == "number" then
        local remaining = currentXPMax - currentXP
        if remaining > 0 then
            etaSeconds = remaining / (xpPerHour / 3600)
        end
    end

    local earned = current.gold.earned or 0
    local spent = current.gold.spent or 0
    local net = earned - spent

    local earnedPerHour, spentPerHour, netPerHour = nil, nil, nil
    if activeSeconds > 0 then
        earnedPerHour = earned / activeSeconds * 3600
        spentPerHour = spent / activeSeconds * 3600
        netPerHour = net / activeSeconds * 3600
    end

    return {
        level = level,
        currentXP = currentXP,
        currentXPMax = currentXPMax,
        xpGained = xpGained,
        xpPerHour = xpPerHour,
        etaSeconds = etaSeconds,
        isMaxLevel = isMaxLevel,

        goldEarned = earned,
        goldSpent = spent,
        netGold = net,
        earnedPerHour = earnedPerHour,
        spentPerHour = spentPerHour,
        netPerHour = netPerHour,
        currentMoney = current.gold.lastCopper,

        trackedSeconds = trackedSeconds,
        activeSeconds = activeSeconds,
        status = status,
        startedAt = current.startedAt,

        characterName = char.name,
        characterRealm = char.realm,
    }
end

function FDB:GetSessionHistory()
    local char = self:GetActiveSessionCharacter()
    if not char then return {} end

    -- Defensive on top of the normalization GetOrCreateSessionCharacter
    -- already applies: skip any entry that isn't a table so a record
    -- corrupted after normalization ran (or a fixture that bypasses it)
    -- still can't crash this copy loop by indexing a non-table value.
    local result = {}
    for _, record in ipairs(char.history or {}) do
        if type(record) == "table" then
            result[#result + 1] = {
                id = record.id,
                startedAt = record.startedAt,
                endedAt = record.endedAt,
                trackedSeconds = record.trackedSeconds,
                activeSeconds = record.activeSeconds,
                startLevel = record.startLevel,
                endLevel = record.endLevel,
                xpGained = record.xpGained,
                xpPerHour = record.xpPerHour,
                goldEarned = record.goldEarned,
                goldSpent = record.goldSpent,
                netGold = record.netGold,
                earnedPerHour = record.earnedPerHour,
                spentPerHour = record.spentPerHour,
                netPerHour = record.netPerHour,
            }
        end
    end
    return result
end
