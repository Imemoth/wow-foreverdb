-- Run from the repository root: lua5.4 tests/session_ui_smoke.lua
-- Simulated WoW frame APIs; this is NOT live Forever client acceptance.
-- SessionUI.lua must render tracker snapshots only; it must never
-- calculate XP/gold/time itself.
local consolePrint = print
local passed = 0

local function equal(actual, expected, label)
    if actual ~= expected then
        error((label or "value") .. ": " .. tostring(actual) .. " ~= " .. tostring(expected))
    end
end

local function truthy(value, label)
    if not value then
        error((label or "value") .. " expected truthy, got " .. tostring(value))
    end
end

local function falsy(value, label)
    if value then
        error((label or "value") .. " expected falsy, got " .. tostring(value))
    end
end

-- A widget "has layout" only if it received a real SetPoint anchor and,
-- where the widget requires one, a positive explicit size. Checking that
-- a field merely exists, or that GetText() returns a value, proves
-- nothing about whether it was ever actually positioned.
-- Reviewer C finding: a bare "at least one SetPoint call happened" check
-- would still pass a degenerate `obj:SetPoint()` call with no arguments
-- at all -- it proves a call happened, not that it anchored anywhere
-- real. Require the most recent anchor to carry a real point, a real
-- relativeTo, and a real relativePoint.
local function hasAnchor(obj)
    if obj == nil or obj.points == nil or #obj.points == 0 then return false end
    local anchor = obj.points[#obj.points]
    return type(anchor.point) == "string" and anchor.point ~= ""
        and anchor.relativeTo ~= nil
        and type(anchor.relativePoint) == "string" and anchor.relativePoint ~= ""
end

local function hasPositiveSize(obj)
    return obj ~= nil
        and type(obj.width) == "number" and obj.width > 0
        and type(obj.height) == "number" and obj.height > 0
end

-- Shared geometry mixin: real WoW Region-derived objects (frames, font
-- strings, textures) all support SetPoint/ClearAllPoints/SetSize with the
-- same semantics. A prior version of this mock made SetPoint/SetSize
-- either no-ops or single-anchor-only, which let production code create
-- widgets with no real anchor or size at all without any test noticing.
-- This mock now records every anchor (SetPoint is cumulative until
-- ClearAllPoints, exactly like the real API) and the last explicit size,
-- so a missing SetPoint/SetSize call is directly observable as
-- `#obj.points == 0` / `obj.width == nil`.
local function addGeometry(obj)
    obj.points = {}
    obj.width = nil
    obj.height = nil

    function obj:SetPoint(point, relativeTo, relativePoint, x, y)
        local anchor = { point = point, relativeTo = relativeTo, relativePoint = relativePoint, x = x, y = y }
        table.insert(self.points, anchor)
        self.point = anchor -- last-set anchor, for single-anchor call sites
    end

    function obj:GetPoint(index)
        local anchor = self.points[index or 1]
        if not anchor then return nil end
        return anchor.point, anchor.relativeTo, anchor.relativePoint, anchor.x, anchor.y
    end

    function obj:GetNumPoints() return #self.points end

    function obj:ClearAllPoints()
        self.points = {}
        self.point = nil
    end

    function obj:SetSize(width, height)
        self.width = width
        self.height = height
    end

    function obj:SetWidth(width) self.width = width end
    function obj:SetHeight(height) self.height = height end
    function obj:GetWidth() return self.width or 0 end
    function obj:GetHeight() return self.height or 0 end
end

local function makeFontString()
    local fs = { text = "", color = { 1, 1, 1 } }
    addGeometry(fs)
    function fs:SetText(t) self.text = t end
    function fs:GetText() return self.text end
    function fs:SetTextColor(r, g, b) self.color = { r, g, b } end
    function fs:SetJustifyH(justify) self.justifyH = justify end
    function fs:SetFontObject() end
    fs.shown = true
    function fs:Show() self.shown = true end
    function fs:Hide() self.shown = false end
    function fs:IsShown() return self.shown end
    return fs
end

local function makeTexture()
    local tex = {}
    addGeometry(tex)
    function tex:SetAllPoints(target)
        self.allPointsTarget = target or true
        table.insert(self.points, { point = "ALL", relativeTo = target })
    end
    function tex:SetColorTexture(r, g, b, a) self.color = { r, g, b, a } end
    function tex:SetTexture(path) self.texturePath = path end
    tex.shown = true
    function tex:Show() self.shown = true end
    function tex:Hide() self.shown = false end
    function tex:IsShown() return self.shown end
    return tex
end

local function makeFrame(withBackdropMethods)
    local frame = { shown = true, events = {}, scripts = {}, moving = false }
    addGeometry(frame)

    function frame:SetMovable() end
    function frame:EnableMouse() end
    function frame:RegisterForDrag() end
    function frame:SetScript(name, handler) self.scripts[name] = handler end
    function frame:GetScript(name) return self.scripts[name] end
    function frame:Show() self.shown = true end
    function frame:Hide() self.shown = false end
    function frame:IsShown() return self.shown end
    function frame:SetFrameStrata() end
    function frame:SetFrameLevel() end
    function frame:SetAlpha() end
    function frame:SetScale() end
    function frame:StartMoving() self.moving = true end
    function frame:StopMovingOrSizing() self.moving = false end
    function frame:CreateFontString() return makeFontString() end
    function frame:CreateTexture() return makeTexture() end
    function frame:RegisterEvent(event) self.events[event] = true end
    function frame:SetText(t) self.text = t end
    function frame:GetText() return self.text end
    function frame:SetEnabled(v) self.enabled = v end
    function frame:IsEnabled() return self.enabled end
    function frame:SetScrollChild(child) self.scrollChild = child end
    function frame:SetMinMaxValues(minValue, maxValue)
        self.minValue = minValue
        self.maxValue = maxValue
    end
    function frame:SetValue(v) self.value = v end
    function frame:SetStatusBarColor() end
    function frame:SetStatusBarTexture(path) self.statusBarTexture = path end
    function frame:SetVerticalScroll() end
    function frame:GetVerticalScroll() return 0 end

    if withBackdropMethods then
        function frame:SetBackdrop(bd) self.backdrop = bd end
        function frame:SetBackdropColor(...) self.backdropColor = { ... } end
        function frame:SetBackdropBorderColor(...) self.backdropBorderColor = { ... } end
    end

    return frame
end

local function setup(options)
    options = options or {}
    local hasBackdropMixin = options.hasBackdropMixin
    if hasBackdropMixin == nil then hasBackdropMixin = true end

    local state = {
        now = 1000,
        guid = "Player-1-000001",
        name = "Vesperix",
        realm = "TestRealm",
        level = 20,
        xp = 1000,
        xpMax = 10000,
        money = 5000,
        frames = {},
        tickers = {},
    }

    local FDB = {}

    GetServerTime = function() return state.now end
    GetTime = function() return state.now end
    time = function() return state.now end
    date = os.date -- WoW exposes os.date as the global `date`; the addon sandbox has no `os` table

    UnitGUID = function(unit) if unit == "player" then return state.guid end end
    UnitName = function(unit) if unit == "player" then return state.name end end
    GetRealmName = function() return state.realm end
    UnitLevel = function(unit) if unit == "player" then return state.level end end
    UnitXP = function(unit) if unit == "player" then return state.xp end end
    UnitXPMax = function(unit) if unit == "player" then return state.xpMax end end
    GetMoney = function() return state.money end

    UIParent = { name = "UIParent" }

    -- BackdropTemplateMixin is only present on clients that registered the
    -- "BackdropTemplate" virtual XML template. Passing that template name
    -- to CreateFrame on a client without it is exactly the real-world
    -- failure mode (an unrecognized template errors inside CreateFrame
    -- itself, before any code can inspect the returned frame), so the
    -- mock reproduces that instead of silently ignoring the argument.
    BackdropTemplateMixin = hasBackdropMixin and {} or nil

    CreateFrame = function(_, name, _, template)
        if template == "BackdropTemplate" and not BackdropTemplateMixin then
            error("CreateFrame: template 'BackdropTemplate' is not registered on this client")
        end
        local frame = makeFrame(template == "BackdropTemplate")
        frame.frameName = name
        function frame:GetName() return self.frameName end
        if name then _G[name] = frame end -- real CreateFrame registers named frames globally
        state.frames[#state.frames + 1] = frame
        return frame
    end

    function state:event(event, ...)
        for _, frame in ipairs(self.frames) do
            if frame.events[event] then frame.scripts.OnEvent(frame, event, ...) end
        end
    end

    C_Timer = {
        NewTicker = function(interval, callback)
            local ticker = { interval = interval, callback = callback }
            state.tickers[#state.tickers + 1] = ticker
            return ticker
        end,
        After = function() end,
    }

    function state:fireTickers()
        for _, ticker in ipairs(self.tickers) do
            ticker.callback()
        end
    end

    ForeverDB_Saved = nil
    ForeverDB_Export = nil

    assert(loadfile("addon/ForeverDB/Core.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/Database.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/SessionTracker.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/SessionUI.lua"))("ForeverDB", FDB)

    FDB:InitializeDatabase()

    return FDB, state
end

local function test(name, run)
    local ok, err = pcall(run)
    if not ok then error(name .. ": " .. tostring(err)) end
    passed = passed + 1
    consolePrint("PASS (simulated): " .. name)
end

test("HUD initializes without optional BackdropTemplate helpers", function()
    local FDB = setup({ hasBackdropMixin = false })
    truthy(FDB:SessionPlayerReady())

    local ok, err = pcall(function() FDB:InitializeSessionUI() end)
    truthy(ok, tostring(err))
    truthy(FDB.SessionHUDFrame)
    falsy(FDB.SessionHUDFrame.backdrop)
    truthy(FDB.SessionHUDFrame.fallbackBackground)
end)

test("HUD renders Gold/hr from earnedPerHour and Net/hr separately", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()

    -- Override the snapshot source directly: SessionUI must render exactly
    -- what GetSessionSnapshot() returns, never recompute XP/gold/time.
    FDB.GetSessionSnapshot = function()
        return {
            xpPerHour = 28400,
            xpGained = 16320,
            etaSeconds = 4440, -- 1h14m
            isMaxLevel = false,
            earnedPerHour = 74200, -- 7g 42s
            netPerHour = 55800,    -- 5g 58s
            activeSeconds = 2264,  -- 0h37m
            status = "RUNNING",
            characterName = state.name,
        }
    end

    FDB:RefreshSessionUI()

    local frame = FDB.SessionHUDFrame
    equal(frame.xpHrValue:GetText(), "28.4k")
    equal(frame.xpGainedValue:GetText(), "16.3k")
    equal(frame.toLevelValue:GetText(), "01:14")
    equal(frame.goldHrValue:GetText(), "7g 42s")
    equal(frame.netHrValue:GetText(), "5g 58s")
    equal(frame.activeValue:GetText(), "00:37")
    truthy(frame.goldHrValue:GetText() ~= frame.netHrValue:GetText())
end)

test("HUD hide does not pause the session", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()

    local newShown = FDB:ToggleSessionHUD()
    falsy(newShown)
    falsy(FDB.SessionHUDFrame:IsShown())

    local snapshot = FDB:GetSessionSnapshot()
    equal(snapshot.status, "RUNNING")
end)

test("HUD status text is color-coded per status, distinctly for each state", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    local frame = FDB.SessionHUDFrame

    local function colorFor(status)
        FDB.GetSessionSnapshot = function()
            return { status = status, activeSeconds = 0 }
        end
        FDB:RefreshSessionUI()
        return frame.statusText.color
    end

    local runningColor = colorFor("RUNNING")
    local idleColor = colorFor("IDLE")
    local pausedColor = colorFor("PAUSED")

    -- Each state must be visually distinct from the others (restrained,
    -- not harsh -- checked qualitatively below, not exact RGB values).
    truthy(runningColor[1] ~= idleColor[1] or runningColor[2] ~= idleColor[2]
        or runningColor[3] ~= idleColor[3])
    truthy(idleColor[1] ~= pausedColor[1] or idleColor[2] ~= pausedColor[2]
        or idleColor[3] ~= pausedColor[3])
    truthy(runningColor[1] ~= pausedColor[1] or runningColor[2] ~= pausedColor[2]
        or runningColor[3] ~= pausedColor[3])

    -- RUNNING reads as the greenest (G channel clearly dominant), PAUSED
    -- as the most red-leaning of the three, IDLE in between -- restrained
    -- rather than harsh (no channel saturated to 1.0).
    truthy(runningColor[2] > runningColor[1], "RUNNING should read greenish")
    truthy(pausedColor[1] > pausedColor[2], "PAUSED should read orange/red-leaning")
    for _, color in ipairs({ runningColor, idleColor, pausedColor }) do
        for _, channel in ipairs(color) do
            truthy(channel < 1.0, "status colors should be restrained, not fully saturated")
        end
    end
end)

test("HUD lock disables drag movement while unlock allows it", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()

    local frame = FDB.SessionHUDFrame
    local onDragStart = frame:GetScript("OnDragStart")
    truthy(onDragStart)

    truthy(FDB:SetSessionHUDLocked(true))
    onDragStart(frame)
    falsy(frame.moving)

    truthy(FDB:SetSessionHUDLocked(false))
    onDragStart(frame)
    truthy(frame.moving)
end)

test("HUD drag stop persists position through tracker API", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()

    local frame = FDB.SessionHUDFrame
    frame:ClearAllPoints()
    frame:SetPoint("BOTTOMRIGHT", UIParent, "CENTER", 12, -34) -- simulates the drag having moved the frame

    local onDragStop = frame:GetScript("OnDragStop")
    truthy(onDragStop)
    onDragStop(frame)

    local settings = FDB:GetSessionHUDSettings()
    equal(settings.hudPoint, "BOTTOMRIGHT")
    equal(settings.hudRelativePoint, "CENTER")
    equal(settings.hudX, 12)
    equal(settings.hudY, -34)
end)

-- Reviewer B findings: HUD position/visibility must restore for the
-- active character (not just at UI-init time, before any character is
-- known), and CreateFrame must never be asked for an unregistered
-- "BackdropTemplate" when BackdropTemplateMixin is absent. -------------

test("HUD position and visibility restore for the active character after login", function()
    local FDB, state = setup()

    -- Real Core.lua order: InitializeSessionTracker/InitializeSessionUI
    -- both run at ADDON_LOADED, before any character is known;
    -- SessionPlayerReady() only runs later, at PLAYER_LOGIN. Pre-seed this
    -- character's saved HUD settings before SessionPlayerReady ever runs,
    -- exactly like a returning character reading its own SavedVariables.
    local sessions = FDB:GetSessionsRoot()
    sessions.characters[state.guid] = {
        ui = {
            hudShown = false, hudLocked = true,
            hudPoint = "BOTTOMRIGHT", hudRelativePoint = "BOTTOMRIGHT",
            hudX = -50, hudY = 50,
        },
        history = {},
    }

    FDB:InitializeSessionUI() -- no active character yet
    local frame = FDB.SessionHUDFrame
    truthy(frame)

    truthy(FDB:SessionPlayerReady()) -- character becomes active only now

    -- SessionTracker.lua must not depend on SessionUI.lua (design spec
    -- §4.1), so Core.lua -- the integration point -- is responsible for
    -- calling this after SessionPlayerReady() on PLAYER_LOGIN; see the
    -- Core-integration test below for proof that it actually does.
    FDB:SyncSessionHUDForActiveCharacter()

    equal(frame.point.point, "BOTTOMRIGHT")
    equal(frame.point.relativePoint, "BOTTOMRIGHT")
    equal(frame.point.x, -50)
    equal(frame.point.y, 50)
    falsy(frame:IsShown())
end)

test("HUD never requests the BackdropTemplate virtual template when the mixin is absent", function()
    local FDB = setup({ hasBackdropMixin = false })
    truthy(FDB:SessionPlayerReady())

    -- With the earlier real-CreateFrame mock, requesting "BackdropTemplate"
    -- while BackdropTemplateMixin is nil errors inside CreateFrame itself,
    -- exactly like an unrecognized virtual template does on a real client.
    local ok, err = pcall(function() FDB:InitializeSessionUI() end)
    truthy(ok, tostring(err))
end)

-- Task 5: detailed window, history UI, reset confirmation, commands -------

test("session command with no args toggles detailed window", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())

    truthy(FDB:HandleSessionCommand(""))
    truthy(FDB.SessionDetailWindow:IsShown())

    truthy(FDB:HandleSessionCommand(""))
    falsy(FDB.SessionDetailWindow:IsShown())
end)

test("pause and resume commands delegate to tracker APIs", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())

    truthy(FDB:HandleSessionCommand("pause"))
    equal(FDB:GetSessionSnapshot().status, "PAUSED")

    truthy(FDB:HandleSessionCommand("resume"))
    equal(FDB:GetSessionSnapshot().status, "RUNNING")
end)

test("reset command opens confirmation and does not reset immediately", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local originalStartedAt = FDB.DB.sessions.characters[state.guid].current.startedAt

    truthy(FDB:HandleSessionCommand("reset"))

    truthy(FDB.SessionResetConfirmationPending)
    equal(FDB.DB.sessions.characters[state.guid].current.startedAt, originalStartedAt)
end)

test("confirmed reset delegates exactly once", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())

    local resetCalls = 0
    local realResetSession = FDB.ResetSession
    FDB.ResetSession = function(self, ...)
        resetCalls = resetCalls + 1
        return realResetSession(self, ...)
    end

    truthy(FDB:HandleSessionCommand("reset"))
    equal(resetCalls, 0)

    FDB:ConfirmSessionReset()
    equal(resetCalls, 1)
    falsy(FDB.SessionResetConfirmationPending)
end)

test("reset confirmation uses StaticPopup when available and only resets on accept", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())

    -- Unlike every other reset test in this file, define StaticPopupDialogs/
    -- StaticPopup_Show so ShowSessionResetConfirmation takes the primary
    -- (non-fallback) path a live client with StaticPopup support would
    -- actually execute.
    local shownKeys = {}
    StaticPopupDialogs = {}
    StaticPopup_Show = function(key) shownKeys[#shownKeys + 1] = key end

    FDB:ShowSessionResetConfirmation()
    truthy(StaticPopupDialogs["FOREVERDB_SESSION_RESET"])
    equal(shownKeys[1], "FOREVERDB_SESSION_RESET")
    truthy(FDB.SessionResetConfirmationPending)

    local resetCalls = 0
    local realResetSession = FDB.ResetSession
    FDB.ResetSession = function(self, ...)
        resetCalls = resetCalls + 1
        return realResetSession(self, ...)
    end

    StaticPopupDialogs["FOREVERDB_SESSION_RESET"].OnCancel()
    equal(resetCalls, 0)
    falsy(FDB.SessionResetConfirmationPending)

    FDB:ShowSessionResetConfirmation()
    StaticPopupDialogs["FOREVERDB_SESSION_RESET"].OnAccept()
    equal(resetCalls, 1)
    falsy(FDB.SessionResetConfirmationPending)

    StaticPopupDialogs = nil
    StaticPopup_Show = nil
end)

test("timeout command accepts positive integer minutes and rejects invalid values", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())

    truthy(FDB:HandleSessionCommand("timeout 90"))
    equal(FDB:GetSessionSettings().offlineTimeout, 5400)

    falsy(FDB:HandleSessionCommand("timeout 0"))
    equal(FDB:GetSessionSettings().offlineTimeout, 5400)

    falsy(FDB:HandleSessionCommand("timeout abc"))
    equal(FDB:GetSessionSettings().offlineTimeout, 5400)
end)

test("idle command accepts positive integer minutes and rejects invalid values", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())

    truthy(FDB:HandleSessionCommand("idle 10"))
    equal(FDB:GetSessionSettings().inactivityTimeout, 600)

    falsy(FDB:HandleSessionCommand("idle -3"))
    equal(FDB:GetSessionSettings().inactivityTimeout, 600)
end)

test("hud and lock commands toggle persisted HUD state", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()

    truthy(FDB:GetSessionHUDSettings().hudShown)
    truthy(FDB:HandleSessionCommand("hud"))
    falsy(FDB:GetSessionHUDSettings().hudShown)

    falsy(FDB:GetSessionHUDSettings().hudLocked)
    truthy(FDB:HandleSessionCommand("lock"))
    truthy(FDB:GetSessionHUDSettings().hudLocked)
end)

test("unknown session subcommand prints usage and returns false", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    falsy(FDB:HandleSessionCommand("bogus"))
end)

test("detailed window creates and refreshes KPI, timing, character and rates", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    state.now = state.now + 120
    state.xp = state.xp + 60
    state.money = state.money + 500
    state:event("PLAYER_XP_UPDATE")
    state:event("PLAYER_MONEY")

    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow
    truthy(frame:IsShown())

    equal(frame.kpi.xpGained.value:GetText(), "60")
    equal(frame.kpi.goldEarned.value:GetText(), "5s")
    truthy(frame.timing.session.value:GetText() ~= "")
    truthy(frame.timing.active.value:GetText() ~= "")
    equal(frame.timing.status.value:GetText(), "RUNNING")
    truthy(frame.timing.status.value.color[2] > frame.timing.status.value.color[1],
        "RUNNING status should read greenish, matching the HUD's status coloring")
    equal(frame.character.level.value:GetText(), tostring(state.level))
    truthy(frame.rates.earnedPerHour.value:GetText() ~= "")

    truthy(frame.pauseButton)
    truthy(frame.resumeButton)
    truthy(frame.resetButton)
    truthy(frame.lockButton)
    truthy(frame.hudButton)
end)

test("detailed window renders recent session history rows", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())

    state.now = state.now + 90
    state.xp = state.xp + 40
    state:event("PLAYER_XP_UPDATE")
    truthy(FDB:ResetSession())

    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow
    truthy(frame.historyRows[1])
    truthy(frame.historyRows[1].primary:GetText():find("40", 1, true))
end)


test("detail window position is saved on drag and restored across a simulated reload", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    frame:ClearAllPoints()
    frame:SetPoint("BOTTOMRIGHT", UIParent, "CENTER", 30, -20) -- simulates the drag having moved the window

    local onDragStop = frame:GetScript("OnDragStop")
    truthy(onDragStop)
    onDragStop(frame)

    local settings = FDB:GetSessionHUDSettings()
    equal(settings.detailPoint, "BOTTOMRIGHT")
    equal(settings.detailRelativePoint, "CENTER")
    equal(settings.detailX, 30)
    equal(settings.detailY, -20)

    -- Simulate a reload: the window's open/closed state is intentionally
    -- not persisted (a reload always starts with it closed), so this
    -- rebuilds a fresh window object the way a real reload would, and
    -- only its position must be restored on the next open.
    FDB.SessionDetailWindow = nil
    truthy(FDB:ToggleSessionWindow())
    local newFrame = FDB.SessionDetailWindow
    truthy(newFrame ~= frame)
    equal(newFrame.point.point, "BOTTOMRIGHT")
    equal(newFrame.point.relativePoint, "CENTER")
    equal(newFrame.point.x, 30)
    equal(newFrame.point.y, -20)
end)

test("detail window builds safely and centers when saved detail position is corrupted", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local char = FDB.DB.sessions.characters[state.guid]
    char.ui.detailPoint = 42
    char.ui.detailX = "bad"

    local ok, err = pcall(function() return FDB:ToggleSessionWindow() end)
    truthy(ok, "ToggleSessionWindow must not error on corrupted saved detail position: " .. tostring(err))
    local frame = FDB.SessionDetailWindow
    truthy(frame)
    equal(frame.point.point, "CENTER")
    equal(frame.point.relativePoint, "CENTER")
    equal(frame.point.x, 0)
    equal(frame.point.y, 0)
end)

test("Recent Sessions renders newest-first: row 1 is the most recently archived session", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()

    -- Storage order (char.history / GetSessionHistory()) is
    -- oldest-appended-first: this is an internal detail the eviction
    -- logic relies on (table.remove(char.history, 1) evicts the
    -- oldest), NOT a display contract. The UI must present the most
    -- recently archived session first regardless of storage order.
    for _, xpTag in ipairs({ 10, 20, 30 }) do
        state.now = state.now + 61
        state.xp = state.xp + xpTag
        state:event("PLAYER_XP_UPDATE")
        truthy(FDB:ResetSession())
    end

    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    -- "XP +N" is a literal, unambiguous prefix in the primary line (unlike
    -- a bare digit, which could coincidentally match a timestamp/duration
    -- component), so this can't collide with anything else in the row.
    truthy(frame.historyRows[1].primary:GetText():find("XP +30", 1, true) ~= nil)
    truthy(frame.historyRows[2].primary:GetText():find("XP +20", 1, true) ~= nil)
    truthy(frame.historyRows[3].primary:GetText():find("XP +10", 1, true) ~= nil)
end)

test("Started and history Date/Time show a human-readable timestamp, not a raw UNIX epoch", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    local startedAt = state.now

    state.now = state.now + 90
    state.xp = state.xp + 40
    state:event("PLAYER_XP_UPDATE")

    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    local startedText = frame.timing.started.value:GetText()
    falsy(startedText == tostring(startedAt), "Started must not display the raw epoch number")
    truthy(startedText:find("%d%d%d%d") ~= nil, "Started should show a real calendar date")

    truthy(FDB:ResetSession())
    FDB:RefreshSessionDetailWindow()

    local rowText = frame.historyRows[1].primary:GetText()
    local endedAt = FDB:GetSessionHistory()[1].endedAt
    falsy(rowText:find(tostring(endedAt), 1, true) ~= nil,
        "history row must not embed the raw epoch number for its date/time column")
end)

test("a missing or invalid timestamp falls back to a safe placeholder", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    -- Snapshot with no startedAt at all (nil) must not error or display
    -- something misleading.
    FDB.GetSessionSnapshot = function()
        return {
            xpPerHour = nil, etaSeconds = nil, isMaxLevel = false,
            earnedPerHour = nil, netPerHour = nil, activeSeconds = 0,
            status = "RUNNING", startedAt = nil,
        }
    end

    local ok, err = pcall(function() FDB:RefreshSessionDetailWindow() end)
    truthy(ok, "must not error on a missing startedAt: " .. tostring(err))
    equal(frame.timing.started.value:GetText(), "--")
end)

test("detailed window controls call the same tracker APIs as slash commands", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    frame.pauseButton.scripts.OnClick(frame.pauseButton)
    equal(FDB:GetSessionSnapshot().status, "PAUSED")

    frame.resumeButton.scripts.OnClick(frame.resumeButton)
    equal(FDB:GetSessionSnapshot().status, "RUNNING")

    frame.resetButton.scripts.OnClick(frame.resetButton)
    truthy(FDB.SessionResetConfirmationPending)
    FDB:ConfirmSessionReset()
    falsy(FDB.SessionResetConfirmationPending)

    falsy(FDB:GetSessionHUDSettings().hudLocked)
    frame.lockButton.scripts.OnClick(frame.lockButton)
    truthy(FDB:GetSessionHUDSettings().hudLocked)

    truthy(FDB:GetSessionHUDSettings().hudShown)
    frame.hudButton.scripts.OnClick(frame.hudButton)
    falsy(FDB:GetSessionHUDSettings().hudShown)
end)

test("close button hides the window without pausing, resetting, or losing its saved position", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow
    truthy(frame:IsShown())
    truthy(frame.closeButton)

    frame.closeButton.scripts.OnClick(frame.closeButton)

    falsy(frame:IsShown())
    equal(FDB:GetSessionSnapshot().status, "RUNNING")
    falsy(FDB.SessionResetConfirmationPending)

    -- /fdb session must still toggle it back open -- closing is not a
    -- one-way trip, and the position saved earlier (build-time default
    -- here) must not have been reset by closing.
    local settingsBeforeReopen = FDB:GetSessionHUDSettings()
    truthy(FDB:HandleSessionCommand(""))
    truthy(frame:IsShown())
    local settingsAfterReopen = FDB:GetSessionHUDSettings()
    equal(settingsAfterReopen.detailPoint, settingsBeforeReopen.detailPoint)
    equal(settingsAfterReopen.detailX, settingsBeforeReopen.detailX)
end)

test("close button has a real anchor and size", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow
    truthy(hasAnchor(frame.closeButton))
    truthy(hasPositiveSize(frame.closeButton))
end)

test("detail window registers for ESC-close when UISpecialFrames is available", function()
    local FDB = setup()
    UISpecialFrames = {}
    truthy(FDB:SessionPlayerReady())
    truthy(FDB:ToggleSessionWindow())

    local found = false
    for _, name in ipairs(UISpecialFrames) do
        if name == FDB.SessionDetailWindow:GetName() then found = true end
    end
    truthy(found, "detail window frame name must be registered in UISpecialFrames for ESC-close")
end)

test("detail window does not error when UISpecialFrames is unavailable", function()
    local FDB = setup()
    UISpecialFrames = nil
    local ok, err = pcall(function()
        truthy(FDB:SessionPlayerReady())
        return FDB:ToggleSessionWindow()
    end)
    truthy(ok, "must not error when UISpecialFrames is absent: " .. tostring(err))
end)

test("the registered periodic ticker also refreshes an already-open detailed window", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow
    truthy(frame:IsShown())

    equal(frame.kpi.xpGained.value:GetText(), "0")

    state.now = state.now + 60
    state.xp = state.xp + 50
    state.money = state.money + 100
    state:event("PLAYER_XP_UPDATE")
    state:event("PLAYER_MONEY")

    -- Deliberately do NOT call RefreshSessionDetailWindow() directly: this
    -- must be driven by the actually-registered periodic ticker callback
    -- (the same one a live client fires roughly once a second), which is
    -- exactly the wiring under test.
    truthy(#state.tickers >= 1)
    state:fireTickers()

    equal(frame.kpi.xpGained.value:GetText(), "50")
    equal(frame.kpi.goldEarned.value:GetText(), "1s")
    equal(frame.timing.active.value:GetText(), "00:01:00")
    equal(frame.character.xpBar.maxValue, state.xpMax)
    equal(frame.character.xpBar.value, state.xp)
end)

test("the periodic ticker refreshes the detailed window even while the HUD is hidden", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    falsy(FDB:ToggleSessionHUD()) -- HUD hidden; detailed window unaffected
    falsy(FDB.SessionHUDFrame:IsShown())

    state.now = state.now + 30
    state.xp = state.xp + 15
    state:event("PLAYER_XP_UPDATE")
    state:fireTickers()

    equal(frame.kpi.xpGained.value:GetText(), "15")
end)

-- Task 6: Core integration (load order, event wiring, slash routing) ------

local function setupCoreIntegration()
    local state = {
        now = 1000,
        guid = "Player-1-000001",
        name = "Vesperix",
        realm = "TestRealm",
        level = 20,
        xp = 1000,
        xpMax = 10000,
        money = 5000,
        frames = {},
        tickers = {},
        messages = {},
    }

    local FDB = {}

    GetServerTime = function() return state.now end
    GetTime = function() return state.now end
    time = function() return state.now end
    date = os.date -- WoW exposes os.date as the global `date`; the addon sandbox has no `os` table

    UnitGUID = function(unit) if unit == "player" then return state.guid end end
    UnitName = function(unit) if unit == "player" then return state.name end end
    GetRealmName = function() return state.realm end
    UnitLevel = function(unit) if unit == "player" then return state.level end end
    UnitXP = function(unit) if unit == "player" then return state.xp end end
    UnitXPMax = function(unit) if unit == "player" then return state.xpMax end end
    GetMoney = function() return state.money end

    UIParent = { name = "UIParent" }
    C_Map = nil -- absent in this fixture; Core.lua must guard this optional API
    BackdropTemplateMixin = {}

    CreateFrame = function(_, name, _, template)
        local frame = makeFrame(template == "BackdropTemplate")
        frame.frameName = name
        function frame:GetName() return self.frameName end
        if name then _G[name] = frame end
        state.frames[#state.frames + 1] = frame
        return frame
    end

    function state:event(event, ...)
        for _, frame in ipairs(self.frames) do
            if frame.events[event] then frame.scripts.OnEvent(frame, event, ...) end
        end
    end

    C_Timer = {
        NewTicker = function(interval, callback)
            state.tickers[#state.tickers + 1] = { interval = interval, callback = callback }
            return {}
        end,
        After = function() end,
    }

    SlashCmdList = {}
    print = function(...)
        local parts = {}
        for i = 1, select("#", ...) do parts[i] = tostring(select(i, ...)) end
        state.messages[#state.messages + 1] = table.concat(parts, " ")
    end

    ForeverDB_Saved = nil
    ForeverDB_Export = nil

    assert(loadfile("addon/ForeverDB/Core.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/Database.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/Exporter.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/SessionTracker.lua"))("ForeverDB", FDB)
    assert(loadfile("addon/ForeverDB/SessionUI.lua"))("ForeverDB", FDB)

    -- Collector/UI modules this fixture does not load; Core.lua's
    -- ADDON_LOADED handler still calls them, so stub them as no-ops. This
    -- keeps the integration test scoped to session-tracker wiring instead
    -- of duplicating the unrelated collector-smoke fixture.
    for _, name in ipairs({
        "InitializeGuildApiProbe", "InitializeGuildbookTracker",
        "InitializeGatheringTracker", "InitializeSkinningTracker",
        "InitializeFishingPoolTracker", "InitializeDisenchantTracker",
        "InitializeLootTracker", "InitializeTooltip",
    }) do
        FDB[name] = function() end
    end

    return FDB, state
end

test("addon load initializes the session tracker and UI after the database", function()
    local FDB, state = setupCoreIntegration()
    local initOrder = {}

    local realInitDB = FDB.InitializeDatabase
    FDB.InitializeDatabase = function(self, ...)
        initOrder[#initOrder + 1] = "database"
        return realInitDB(self, ...)
    end
    FDB.InitializeSessionTracker = function(self, ...)
        initOrder[#initOrder + 1] = "tracker"
        return FDB.GetSessionsRoot(self) -- keep DB.sessions normalized without full event wiring
    end
    FDB.InitializeSessionUI = function() initOrder[#initOrder + 1] = "ui" end

    state:event("ADDON_LOADED", "ForeverDB")

    equal(initOrder[1], "database")
    truthy(initOrder[2] == "tracker" or initOrder[3] == "tracker")
    truthy(initOrder[2] == "ui" or initOrder[3] == "ui")
end)

test("player login calls SessionPlayerReady", function()
    local FDB, state = setupCoreIntegration()
    state:event("ADDON_LOADED", "ForeverDB")

    local called = false
    FDB.SessionPlayerReady = function(self, ...)
        called = true
        return true
    end

    state:event("PLAYER_LOGIN")
    truthy(called)
end)

test("real ADDON_LOADED then PLAYER_LOGIN restores this character's saved HUD position, unstubbed", function()
    local FDB, state = setupCoreIntegration()

    -- Pre-seed a saved HUD position/visibility for this GUID before any
    -- Core.lua event fires, exactly like a returning character's
    -- SavedVariables. Nothing here is stubbed: this drives the real
    -- InitializeSessionTracker/InitializeSessionUI/SessionPlayerReady
    -- through Core.lua's real ADDON_LOADED -> PLAYER_LOGIN event order.
    ForeverDB_Saved = {
        sessions = {
            characters = {
                [state.guid] = {
                    ui = {
                        hudShown = false, hudLocked = true,
                        hudPoint = "BOTTOMRIGHT", hudRelativePoint = "BOTTOMRIGHT",
                        hudX = -50, hudY = 50,
                    },
                },
            },
        },
    }

    state:event("ADDON_LOADED", "ForeverDB")
    local frame = FDB.SessionHUDFrame
    truthy(frame)

    state:event("PLAYER_LOGIN")

    equal(frame.point.point, "BOTTOMRIGHT")
    equal(frame.point.x, -50)
    equal(frame.point.y, 50)
    falsy(frame:IsShown())
end)

test("late GUID: HUD state restores via the PLAYER_ENTERING_WORLD fallback, not only PLAYER_LOGIN", function()
    local FDB, state = setupCoreIntegration()
    local realGuid = state.guid

    -- Pre-seed saved HUD state exactly like a returning character, but the
    -- GUID is NOT yet available at PLAYER_LOGIN (a slow character-select
    -- handoff), so SessionPlayerReady() only succeeds later at
    -- PLAYER_ENTERING_WORLD, through SessionTracker.lua's own fallback
    -- listener rather than Core.lua's PLAYER_LOGIN call. Nothing here is
    -- stubbed: this drives the real functions through the real event order.
    ForeverDB_Saved = {
        sessions = {
            characters = {
                [realGuid] = {
                    ui = {
                        hudShown = false, hudLocked = true,
                        hudPoint = "BOTTOMRIGHT", hudRelativePoint = "BOTTOMRIGHT",
                        hudX = -50, hudY = 50,
                    },
                },
            },
        },
    }

    state:event("ADDON_LOADED", "ForeverDB")
    local frame = FDB.SessionHUDFrame
    truthy(frame)

    state.guid = nil -- GUID unavailable at PLAYER_LOGIN
    state:event("PLAYER_LOGIN")

    falsy(FDB.SessionState, "no session should start without a GUID")
    equal(frame.point.point, "TOPLEFT") -- still at build-time defaults

    state.guid = realGuid -- GUID becomes available moments later
    state:event("PLAYER_ENTERING_WORLD")

    truthy(FDB.SessionState)
    equal(FDB.SessionState.guid, realGuid)
    equal(frame.point.point, "BOTTOMRIGHT")
    equal(frame.point.x, -50)
    equal(frame.point.y, 50)
    falsy(frame:IsShown())

    -- A repeated PLAYER_ENTERING_WORLD (e.g. a later zone change) must be
    -- idempotent: no new session, no timer reset, no new frames/tickers.
    local sessionId = FDB.DB.sessions.characters[realGuid].current.id
    local trackedBefore = FDB.DB.sessions.characters[realGuid].current.trackedSeconds
    local frameCountBefore = #state.frames
    local tickerCountBefore = #state.tickers

    state:event("PLAYER_ENTERING_WORLD")

    equal(FDB.DB.sessions.characters[realGuid].current.id, sessionId)
    equal(FDB.DB.sessions.characters[realGuid].current.trackedSeconds, trackedBefore)
    equal(#state.frames, frameCountBefore)
    equal(#state.tickers, tickerCountBefore)
end)

test("player logout calls SessionBeforeLogout before PrepareForSave", function()
    local FDB, state = setupCoreIntegration()
    state:event("ADDON_LOADED", "ForeverDB")
    truthy(FDB:SessionPlayerReady())

    local order = {}
    local realPrepareForSave = FDB.PrepareForSave
    FDB.SessionBeforeLogout = function(self, ...)
        order[#order + 1] = "sessionBeforeLogout"
    end
    FDB.PrepareForSave = function(self, ...)
        order[#order + 1] = "prepareForSave"
        return realPrepareForSave(self, ...)
    end

    state:event("PLAYER_LOGOUT")

    equal(order[1], "sessionBeforeLogout")
    equal(order[2], "prepareForSave")
end)

test("/fdb session delegates to HandleSessionCommand with no args", function()
    local FDB, state = setupCoreIntegration()
    state:event("ADDON_LOADED", "ForeverDB")

    local receivedArgs
    FDB.HandleSessionCommand = function(self, args) receivedArgs = args; return true end

    SlashCmdList.FOREVERDB("session")
    equal(receivedArgs, "")
end)

test("/fdb session timeout 45 delegates the raw session arguments", function()
    local FDB, state = setupCoreIntegration()
    state:event("ADDON_LOADED", "ForeverDB")

    local receivedArgs
    FDB.HandleSessionCommand = function(self, args) receivedArgs = args; return true end

    SlashCmdList.FOREVERDB("session timeout 45")
    equal(receivedArgs, "timeout 45")
end)

test("generic help mentions /fdb session", function()
    local FDB, state = setupCoreIntegration()
    state:event("ADDON_LOADED", "ForeverDB")

    SlashCmdList.FOREVERDB("not-a-real-command")

    local found = false
    for _, message in ipairs(state.messages) do
        if message:find("/fdb session", 1, true) then found = true end
    end
    truthy(found)
end)

-- External review round 2: real layout, not just created widgets --------

test("HUD stat label/value pairs and status/character info all have a real anchor", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    local frame = FDB.SessionHUDFrame

    for _, widget in ipairs({
        frame.xpHrLabel, frame.xpHrValue, frame.xpGainedLabel, frame.xpGainedValue,
        frame.toLevelLabel, frame.toLevelValue,
        frame.goldHrLabel, frame.goldHrValue, frame.netHrLabel, frame.netHrValue,
        frame.activeLabel, frame.activeValue, frame.statusText, frame.characterText,
    }) do
        truthy(hasAnchor(widget), "expected a real SetPoint anchor on a HUD stat widget")
    end

    truthy(hasPositiveSize(frame), "HUD frame must have a positive size")
end)

test("detailed window KPI, timing, character, rates fields and control buttons are all positioned and sized", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    for _, group in ipairs({ frame.kpi, frame.timing, frame.character, frame.rates }) do
        for key, pair in pairs(group) do
            if type(pair) == "table" and pair.label and pair.value then
                truthy(hasAnchor(pair.label), "label " .. tostring(key) .. " must have a real anchor")
                truthy(hasAnchor(pair.value), "value " .. tostring(key) .. " must have a real anchor")
            end
        end
    end

    for _, button in ipairs({
        frame.pauseButton, frame.resumeButton, frame.resetButton,
        frame.lockButton, frame.hudButton,
    }) do
        truthy(hasAnchor(button), "control button must have a real anchor")
        truthy(hasPositiveSize(button), "control button must have a positive size")
    end

    truthy(hasPositiveSize(frame), "detailed window must have a positive size")
end)

test("XP progress bar has a real size, anchor, and status bar texture", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local bar = FDB.SessionDetailWindow.character.xpBar

    truthy(hasAnchor(bar), "XP bar must have a real anchor")
    truthy(hasPositiveSize(bar), "XP bar must have a positive size")
    truthy(bar.statusBarTexture, "XP bar must have a status bar texture set")
end)

test("history scroll viewport, content child, and rows all have real, distinct geometry", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    truthy(hasAnchor(frame.historyScroll), "history scroll viewport must have a real anchor")
    truthy(hasPositiveSize(frame.historyScroll), "history scroll viewport must have a positive size")
    truthy(hasAnchor(frame.historyContent), "history content child must have a real anchor")
    truthy(type(frame.historyContent.width) == "number" and frame.historyContent.width > 0,
        "history content child must have a real width matching the viewport")

    for i = 1, 3 do
        state.now = state.now + 61
        state.xp = state.xp + i
        state:event("PLAYER_XP_UPDATE")
        truthy(FDB:ResetSession())
    end
    FDB:RefreshSessionDetailWindow()

    truthy(#frame.historyRows >= 3)
    truthy(hasAnchor(frame.historyRows[1].primary), "history row 1 must have a real anchor")
    truthy(hasAnchor(frame.historyRows[2].primary), "history row 2 must have a real anchor")
    truthy(hasAnchor(frame.historyRows[1].secondary), "history row 1's secondary line must have a real anchor")

    local firstY = frame.historyRows[1].primary.point and frame.historyRows[1].primary.point.y
    local secondY = frame.historyRows[2].primary.point and frame.historyRows[2].primary.point.y
    truthy(firstY ~= nil and secondY ~= nil and firstY ~= secondY,
        "each history record must get its own distinct vertical position")
end)

test("at 30 history records the content child height genuinely exceeds the viewport", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    for i = 1, 30 do
        state.now = state.now + 61
        state.xp = state.xp + i
        state:event("PLAYER_XP_UPDATE")
        truthy(FDB:ResetSession())
    end
    FDB:RefreshSessionDetailWindow()

    equal(#FDB:GetSessionHistory(), 30)
    truthy(type(frame.historyContent.height) == "number" and type(frame.historyScroll.height) == "number")
    truthy(frame.historyContent.height > frame.historyScroll.height,
        "30 records must genuinely overflow a fixed-height viewport")
end)

test("history overflow indicator is shown once real content genuinely exceeds the viewport", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    for i = 1, 30 do
        state.now = state.now + 61
        state.xp = state.xp + i
        state:event("PLAYER_XP_UPDATE")
        truthy(FDB:ResetSession())
    end
    FDB:RefreshSessionDetailWindow()

    truthy(frame.historyContent.height > frame.historyScroll.height)
    truthy(frame.historyOverflowIndicator:IsShown(),
        "overflow indicator must appear once content genuinely overflows the viewport")
end)

test("history overflow indicator stays hidden for a couple of short records with nothing to scroll", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    for i = 1, 2 do
        state.now = state.now + 61
        state.xp = state.xp + i
        state:event("PLAYER_XP_UPDATE")
        truthy(FDB:ResetSession())
    end
    FDB:RefreshSessionDetailWindow()

    equal(#FDB:GetSessionHistory(), 2)
    truthy(frame.historyContent.height <= frame.historyScroll.height,
        "2 short records must not genuinely overflow the viewport")
    falsy(frame.historyOverflowIndicator:IsShown(),
        "overflow indicator must not appear when there is nothing to scroll")
    falsy(frame.historyEmptyText:IsShown(),
        "empty-state text must not show once real history exists")
end)

test("history empty-state text shows with zero completed sessions and hides once one exists", function()
    local FDB, state = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    equal(#FDB:GetSessionHistory(), 0)
    FDB:RefreshSessionDetailWindow()
    truthy(frame.historyEmptyText:IsShown(),
        "empty-state text must show when there are no completed sessions")
    falsy(frame.historyOverflowIndicator:IsShown(),
        "overflow indicator must not appear when history is empty")

    state.now = state.now + 61
    state.xp = state.xp + 5
    state:event("PLAYER_XP_UPDATE")
    truthy(FDB:ResetSession())
    FDB:RefreshSessionDetailWindow()

    equal(#FDB:GetSessionHistory(), 1)
    falsy(frame.historyEmptyText:IsShown(),
        "empty-state text must hide as soon as a completed session exists")
end)

test("each KPI figure renders as its own card with a real background, anchor and positive size", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    local keys = { "xpPerHour", "xpGained", "toLevel", "goldEarned", "goldSpent", "netGold" }
    for _, key in ipairs(keys) do
        local kpi = frame.kpi[key]
        truthy(kpi ~= nil, "missing KPI card for " .. key)
        truthy(kpi.card ~= nil and kpi.background ~= nil and kpi.label ~= nil and kpi.value ~= nil,
            "KPI card for " .. key .. " must have card/background/label/value widgets")
        truthy(hasAnchor(kpi.card), "KPI card for " .. key .. " must have a real anchor")
        truthy(hasPositiveSize(kpi.card), "KPI card for " .. key .. " must have a real positive size")
        truthy(kpi.background.allPointsTarget ~= nil,
            "KPI card background for " .. key .. " must be anchored to the card via SetAllPoints")
    end
end)

test("detailed window section headers all have a real anchor", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    FDB:InitializeSessionUI()
    truthy(FDB:ToggleSessionWindow())
    local frame = FDB.SessionDetailWindow

    truthy(hasAnchor(frame.timingHeader), "Session Timing header must have a real anchor")
    truthy(hasAnchor(frame.characterHeader), "Character header must have a real anchor")
    truthy(hasAnchor(frame.ratesHeader), "Rates header must have a real anchor")
    truthy(hasAnchor(frame.historyHeader), "Recent Sessions header must have a real anchor")

    equal(frame.timingHeader:GetText(), "Session Timing")
    equal(frame.characterHeader:GetText(), "Character")
    equal(frame.ratesHeader:GetText(), "Rates")
    equal(frame.historyHeader:GetText(), "Recent Sessions")
end)

test("fallback reset-confirmation frame's text and buttons all have real geometry", function()
    local FDB = setup()
    truthy(FDB:SessionPlayerReady())
    -- StaticPopupDialogs/StaticPopup_Show are undefined in this fixture's
    -- default setup(), so this exercises the native-frame fallback path.

    FDB:ShowSessionResetConfirmation()
    local frame = FDB.SessionResetConfirmFrame
    truthy(frame)

    truthy(hasAnchor(frame), "confirmation frame must have a real anchor")
    truthy(hasPositiveSize(frame), "confirmation frame must have a positive size")
    truthy(hasAnchor(frame.text), "confirmation text must have a real anchor")
    truthy(type(frame.text.width) == "number" and frame.text.width > 0,
        "confirmation text must have a width so the message actually fits")

    truthy(hasAnchor(frame.acceptButton), "accept button must have a real anchor")
    truthy(hasPositiveSize(frame.acceptButton), "accept button must have a positive size")
    truthy(hasAnchor(frame.cancelButton), "cancel button must have a real anchor")
    truthy(hasPositiveSize(frame.cancelButton), "cancel button must have a positive size")
end)

consolePrint(passed .. " session UI smoke tests passed; live Forever E2E remains PENDING")
