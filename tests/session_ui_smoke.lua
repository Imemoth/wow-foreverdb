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

local function makeFontString()
    local fs = { text = "", color = { 1, 1, 1 } }
    function fs:SetText(t) self.text = t end
    function fs:GetText() return self.text end
    function fs:SetTextColor(r, g, b) self.color = { r, g, b } end
    function fs:SetPoint() end
    function fs:SetJustifyH() end
    function fs:SetFontObject() end
    return fs
end

local function makeTexture()
    local tex = {}
    function tex:SetAllPoints() end
    function tex:SetColorTexture(r, g, b, a) self.color = { r, g, b, a } end
    function tex:SetTexture() end
    function tex:SetPoint() end
    return tex
end

local function makeFrame(withBackdrop)
    local frame = { point = {}, shown = true, events = {}, scripts = {}, moving = false }

    function frame:SetSize() end
    function frame:SetMovable() end
    function frame:EnableMouse() end
    function frame:RegisterForDrag() end
    function frame:SetScript(name, handler) self.scripts[name] = handler end
    function frame:GetScript(name) return self.scripts[name] end
    function frame:SetPoint(point, relativeTo, relativePoint, x, y)
        self.point = { point = point, relativeTo = relativeTo, relativePoint = relativePoint, x = x, y = y }
    end
    function frame:ClearAllPoints() self.point = {} end
    function frame:GetPoint()
        local p = self.point
        return p.point, p.relativeTo, p.relativePoint, p.x, p.y
    end
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

    if withBackdrop then
        function frame:SetBackdrop(bd) self.backdrop = bd end
        function frame:SetBackdropColor(...) self.backdropColor = { ... } end
        function frame:SetBackdropBorderColor(...) self.backdropBorderColor = { ... } end
    end

    return frame
end

local function setup(options)
    options = options or {}
    local withBackdrop = options.withBackdrop
    if withBackdrop == nil then withBackdrop = true end

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

    UnitGUID = function(unit) if unit == "player" then return state.guid end end
    UnitName = function(unit) if unit == "player" then return state.name end end
    GetRealmName = function() return state.realm end
    UnitLevel = function(unit) if unit == "player" then return state.level end end
    UnitXP = function(unit) if unit == "player" then return state.xp end end
    UnitXPMax = function(unit) if unit == "player" then return state.xpMax end end
    GetMoney = function() return state.money end

    UIParent = { name = "UIParent" }

    CreateFrame = function()
        local frame = makeFrame(withBackdrop)
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
    local FDB = setup({ withBackdrop = false })
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
    frame.point = { point = "BOTTOMRIGHT", relativeTo = UIParent, relativePoint = "CENTER", x = 12, y = -34 }

    local onDragStop = frame:GetScript("OnDragStop")
    truthy(onDragStop)
    onDragStop(frame)

    local settings = FDB:GetSessionHUDSettings()
    equal(settings.hudPoint, "BOTTOMRIGHT")
    equal(settings.hudRelativePoint, "CENTER")
    equal(settings.hudX, 12)
    equal(settings.hudY, -34)
end)

consolePrint(passed .. " session UI smoke tests passed; live Forever E2E remains PENDING")
