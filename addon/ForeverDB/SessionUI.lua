local _, FDB = ...

-- ForeverDB Session UI: compact HUD and (later) detailed session window.
-- This module owns presentation only. It must read normalized snapshots
-- from SessionTracker.lua and must never calculate XP/gold/time itself.

local HUD_REFRESH_INTERVAL = 1

--- Layout constants ---------------------------------------------------------
-- Approximate, not pixel-perfect against the mockup (the design spec
-- explicitly treats it as a reference, not a pixel-exact contract). Every
-- widget below gets a real SetPoint anchor and, where the widget type
-- requires it, a positive explicit size.

local HUD_WIDTH, HUD_HEIGHT = 230, 120
local HUD_COL1_X, HUD_COL2_X = 14, 122
local HUD_ROW1_Y, HUD_ROW2_Y, HUD_ROW3_Y = -30, -50, -70
local HUD_STATUS_Y = 10 -- offset up from the bottom edge

local DETAIL_WIDTH, DETAIL_HEIGHT = 420, 480
local DETAIL_MARGIN = 16
local DETAIL_COL_X = { 16, 156, 296 }
local DETAIL_KPI_ROW1_Y, DETAIL_KPI_ROW2_Y = -40, -64
local DETAIL_TIMING_ROW1_Y, DETAIL_TIMING_ROW2_Y = -100, -124
local DETAIL_TIMING_COL_X = { 16, 216 }
local DETAIL_CHARACTER_ROW_Y = -156
local DETAIL_XPBAR_Y = -178
local DETAIL_XPBAR_HEIGHT = 16
local DETAIL_RATES_ROW_Y = -208
local DETAIL_HISTORY_TOP_Y = -234
local DETAIL_HISTORY_HEIGHT = 168
local HISTORY_ROW_HEIGHT = 16
local DETAIL_BUTTON_ROW_Y = 14 -- offset up from the bottom edge
local BUTTON_WIDTH, BUTTON_HEIGHT = 78, 22
local BUTTON_GAP = 4

local CONFIRM_WIDTH, CONFIRM_HEIGHT = 260, 110
local CONFIRM_TEXT_WIDTH = CONFIRM_WIDTH - 32
local CONFIRM_BUTTON_WIDTH, CONFIRM_BUTTON_HEIGHT = 90, 22

local CLOSE_BUTTON_SIZE = 24

--- Formatting helpers -----------------------------------------------------

local function formatCompactNumber(n)
    if type(n) ~= "number" then return "--" end
    local sign = n < 0 and "-" or ""
    local abs = math.abs(n)
    if abs >= 1000 then
        return string.format("%s%.1fk", sign, abs / 1000)
    end
    return string.format("%s%d", sign, math.floor(abs + 0.5))
end

local function formatCopperShort(copper)
    if type(copper) ~= "number" then return "--" end
    local sign = copper < 0 and "-" or ""
    local abs = math.floor(math.abs(copper) + 0.5)
    local gold = math.floor(abs / 10000)
    local silver = math.floor((abs % 10000) / 100)
    local copperRemainder = abs % 100

    if gold > 0 then
        return string.format("%s%dg %ds", sign, gold, silver)
    elseif silver > 0 then
        return string.format("%s%ds", sign, silver)
    end
    return string.format("%s%dc", sign, copperRemainder)
end

local function formatHM(seconds)
    if type(seconds) ~= "number" then return "--:--" end
    if seconds < 0 then seconds = 0 end
    local totalMinutes = math.floor(seconds / 60)
    local hours = math.floor(totalMinutes / 60)
    local minutes = totalMinutes % 60
    return string.format("%02d:%02d", hours, minutes)
end

-- `date()` is the WoW-exposed equivalent of Lua's os.date (the addon
-- sandbox does not expose the `os` library at all); tests run under a
-- plain Lua interpreter, so the test harness aliases the standard
-- library's os.date to a global `date` to match. Falls back to "--" for
-- a missing/invalid timestamp or an environment without `date` at all,
-- rather than ever showing a raw UNIX epoch number to the player.
local function formatTimestamp(epochSeconds)
    if type(epochSeconds) ~= "number" then return "--" end
    if type(date) == "function" then
        local ok, formatted = pcall(date, "%Y-%m-%d %H:%M", epochSeconds)
        if ok and type(formatted) == "string" then return formatted end
    end
    return "--"
end

local function formatHMS(seconds)
    if type(seconds) ~= "number" then return "--:--:--" end
    if seconds < 0 then seconds = 0 end
    local totalSeconds = math.floor(seconds)
    local hours = math.floor(totalSeconds / 3600)
    local minutes = math.floor((totalSeconds % 3600) / 60)
    local secs = totalSeconds % 60
    return string.format("%02d:%02d:%02d", hours, minutes, secs)
end

-- Exposed for tests and for SessionUI's own detailed-window code (added in
-- a later task) so formatting logic is defined exactly once.
FDB.SessionUIFormat = {
    compactNumber = formatCompactNumber,
    copperShort = formatCopperShort,
    hm = formatHM,
    hms = formatHMS,
}

local NEUTRAL_COLOR = { 0.82, 0.82, 0.82 }
local POSITIVE_COLOR = { 0.2, 0.9, 0.3 }
local NEGATIVE_COLOR = { 0.95, 0.25, 0.25 }

local function netColor(value)
    if type(value) ~= "number" or value == 0 then return NEUTRAL_COLOR end
    if value > 0 then return POSITIVE_COLOR end
    return NEGATIVE_COLOR
end

--- Frame construction ------------------------------------------------------

-- "BackdropTemplate" is only a registered virtual XML template on clients
-- that ship the BackdropTemplateMixin (Legion 7.1+). Passing that literal
-- string to CreateFrame on a client without it errors inside CreateFrame
-- itself, before any code can inspect the returned frame -- so the guard
-- has to happen here, not inside applyBackdrop().
local function backdropTemplateName()
    if BackdropTemplateMixin then return "BackdropTemplate" end
    return nil
end

local function applyBackdrop(frame)
    if frame.SetBackdrop then
        frame:SetBackdrop({
            bgFile = "Interface\\Tooltips\\UI-Tooltip-Background",
            edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
            tile = true,
            tileSize = 16,
            edgeSize = 12,
            insets = { left = 3, right = 3, top = 3, bottom = 3 },
        })
        if frame.SetBackdropColor then frame:SetBackdropColor(0.03, 0.03, 0.03, 0.9) end
        if frame.SetBackdropBorderColor then frame:SetBackdropBorderColor(0.55, 0.45, 0.18, 1) end
        return
    end

    -- Guarded fallback for a client where BackdropTemplate mixins are
    -- unavailable: a plain dark texture using only base Frame/Texture
    -- APIs, so the HUD never errors on a limited client.
    local background = frame:CreateTexture(nil, "BACKGROUND")
    background:SetAllPoints(frame)
    if background.SetColorTexture then
        background:SetColorTexture(0.03, 0.03, 0.03, 0.9)
    end
    frame.fallbackBackground = background
end

-- Creates a label/value font string pair and anchors both: the label at
-- (x, y) relative to the parent's top-left, and the value immediately to
-- the label's right. This is the one layout shape every stat row in both
-- the HUD and the detailed window uses.
local function createLabelValue(parent, labelTemplate, valueTemplate, x, y)
    local label = parent:CreateFontString(nil, "ARTWORK", labelTemplate)
    local value = parent:CreateFontString(nil, "ARTWORK", valueTemplate)
    label:SetPoint("TOPLEFT", parent, "TOPLEFT", x, y)
    value:SetPoint("LEFT", label, "RIGHT", 6, 0)
    return label, value
end

function FDB:BuildSessionHUDFrame()
    local frame = CreateFrame("Frame", "ForeverDBSessionHUD", UIParent, backdropTemplateName())
    frame:SetSize(HUD_WIDTH, HUD_HEIGHT)
    frame:SetFrameStrata("MEDIUM")
    frame:SetMovable(true)
    frame:EnableMouse(true)
    frame:RegisterForDrag("LeftButton")

    applyBackdrop(frame)

    frame:SetScript("OnDragStart", function(self)
        local settings = FDB:GetSessionHUDSettings()
        if settings.hudLocked then return end
        self:StartMoving()
    end)

    frame:SetScript("OnDragStop", function(self)
        self:StopMovingOrSizing()
        local point, _, relativePoint, x, y = self:GetPoint()
        FDB:SetSessionHUDPosition(point, relativePoint, x, y)
    end)

    frame.title = frame:CreateFontString(nil, "ARTWORK", "GameFontNormal")
    frame.title:SetPoint("TOP", frame, "TOP", 0, -8)
    frame.title:SetText("ForeverDB Session")

    frame.xpHrLabel, frame.xpHrValue =
        createLabelValue(frame, "GameFontNormalSmall", "GameFontHighlightSmall", HUD_COL1_X, HUD_ROW1_Y)
    frame.toLevelLabel, frame.toLevelValue =
        createLabelValue(frame, "GameFontNormalSmall", "GameFontHighlightSmall", HUD_COL2_X, HUD_ROW1_Y)
    frame.goldHrLabel, frame.goldHrValue =
        createLabelValue(frame, "GameFontNormalSmall", "GameFontHighlightSmall", HUD_COL1_X, HUD_ROW2_Y)
    frame.netHrLabel, frame.netHrValue =
        createLabelValue(frame, "GameFontNormalSmall", "GameFontHighlightSmall", HUD_COL2_X, HUD_ROW2_Y)
    frame.activeLabel, frame.activeValue =
        createLabelValue(frame, "GameFontNormalSmall", "GameFontHighlightSmall", HUD_COL1_X, HUD_ROW3_Y)

    frame.xpHrLabel:SetText("XP/hr")
    frame.toLevelLabel:SetText("To level")
    frame.goldHrLabel:SetText("Gold/hr")
    frame.netHrLabel:SetText("Net/hr")
    frame.activeLabel:SetText("Active")

    frame.statusText = frame:CreateFontString(nil, "ARTWORK", "GameFontNormalSmall")
    frame.statusText:SetPoint("BOTTOMLEFT", frame, "BOTTOMLEFT", HUD_COL1_X, HUD_STATUS_Y)

    frame.characterText = frame:CreateFontString(nil, "ARTWORK", "GameFontNormalSmall")
    frame.characterText:SetPoint("BOTTOMRIGHT", frame, "BOTTOMRIGHT", -HUD_COL1_X, HUD_STATUS_Y)

    return frame
end

--- Position / visibility ---------------------------------------------------

function FDB:ApplySessionHUDPosition()
    local frame = self.SessionHUDFrame
    if not frame then return end

    local settings = self:GetSessionHUDSettings()
    frame:ClearAllPoints()
    frame:SetPoint(settings.hudPoint, UIParent, settings.hudRelativePoint, settings.hudX, settings.hudY)
end

function FDB:ApplySessionHUDVisibility()
    local frame = self.SessionHUDFrame
    if not frame then return end

    local settings = self:GetSessionHUDSettings()
    if settings.hudShown then
        frame:Show()
    else
        frame:Hide()
    end
end

function FDB:ToggleSessionHUD()
    local settings = self:GetSessionHUDSettings()
    local newShown = not settings.hudShown
    self:SetSessionHUDShown(newShown)
    self:ApplySessionHUDVisibility()
    return newShown
end

function FDB:ToggleSessionHUDLock()
    local settings = self:GetSessionHUDSettings()
    local newLocked = not settings.hudLocked
    self:SetSessionHUDLocked(newLocked)
    return newLocked
end

--- Render -------------------------------------------------------------------

function FDB:RefreshSessionUI()
    local frame = self.SessionHUDFrame
    if not frame then return end

    local snapshot = self:GetSessionSnapshot()
    if not snapshot then
        frame.xpHrValue:SetText("--")
        frame.toLevelValue:SetText("--:--")
        frame.goldHrValue:SetText("--")
        frame.netHrValue:SetText("--")
        frame.activeValue:SetText("--:--")
        frame.statusText:SetText("")
        frame.characterText:SetText("")
        return
    end

    frame.xpHrValue:SetText(formatCompactNumber(snapshot.xpPerHour))

    if snapshot.isMaxLevel then
        frame.toLevelValue:SetText("MAX")
    else
        frame.toLevelValue:SetText(formatHM(snapshot.etaSeconds))
    end

    -- Gold/hr is earned/hour specifically; Net/hr is shown separately so
    -- gross income and net profitability are never conflated.
    frame.goldHrValue:SetText(formatCopperShort(snapshot.earnedPerHour))

    frame.netHrValue:SetText(formatCopperShort(snapshot.netPerHour))
    local color = netColor(snapshot.netPerHour)
    frame.netHrValue:SetTextColor(color[1], color[2], color[3])

    frame.activeValue:SetText(formatHM(snapshot.activeSeconds))

    frame.statusText:SetText(snapshot.status or "")
    frame.characterText:SetText(snapshot.characterName or "")
end

--- Lifecycle -----------------------------------------------------------------

-- Refreshes everything the UI ticker is responsible for: the compact HUD
-- and, when it has been opened at least once, the detailed session
-- window -- regardless of whether the HUD itself is currently shown.
-- RefreshSessionDetailWindow() already no-ops when the window doesn't
-- exist yet, so this is safe to call unconditionally on every tick.
function FDB:RefreshSessionUIViews()
    self:RefreshSessionUI()
    self:RefreshSessionDetailWindow()
end

function FDB:StartSessionUIRefreshTicker()
    local interval = HUD_REFRESH_INTERVAL
    if C_Timer and C_Timer.NewTicker then
        C_Timer.NewTicker(interval, function() self:RefreshSessionUIViews() end)
    elseif C_Timer and C_Timer.After then
        local function tick()
            self:RefreshSessionUIViews()
            C_Timer.After(interval, tick)
        end
        C_Timer.After(interval, tick)
    end
end

function FDB:InitializeSessionUI()
    if self.SessionUIInitialized then return end
    self.SessionUIInitialized = true

    local frame = self:BuildSessionHUDFrame()
    self.SessionHUDFrame = frame

    -- No character is active yet at this point (InitializeSessionUI runs
    -- at ADDON_LOADED, before SessionPlayerReady has run at PLAYER_LOGIN),
    -- so this only applies HUD-settings defaults. SyncSessionHUDForActiveCharacter
    -- re-applies the real per-character position/visibility once a
    -- character becomes active.
    self:ApplySessionHUDPosition()
    self:ApplySessionHUDVisibility()
    self:RefreshSessionUI()

    self:StartSessionUIRefreshTicker()
end

-- Re-applies this character's saved HUD position/visibility and refreshes
-- rendered values. The HUD frame is built once at addon load (before any
-- character is known), so this must run again once SessionPlayerReady()
-- resolves the active character -- otherwise a returning character's
-- saved position/visibility is silently ignored in favor of frame-build
-- defaults, forever, until the addon reloads.
function FDB:SyncSessionHUDForActiveCharacter()
    if not self.SessionHUDFrame then return end
    self:ApplySessionHUDPosition()
    self:ApplySessionHUDVisibility()
    self:RefreshSessionUI()
end

--- Reset confirmation -------------------------------------------------------

function FDB:ConfirmSessionReset()
    self.SessionResetConfirmationPending = false
    self:ResetSession()
    if self.SessionResetConfirmFrame then self.SessionResetConfirmFrame:Hide() end
    self:RefreshSessionUI()
    self:RefreshSessionDetailWindow()
end

function FDB:CancelSessionResetConfirmation()
    self.SessionResetConfirmationPending = false
    if self.SessionResetConfirmFrame then self.SessionResetConfirmFrame:Hide() end
end

local function buildResetConfirmFrame(FDB)
    local frame = CreateFrame("Frame", "ForeverDBSessionResetConfirm", UIParent, backdropTemplateName())
    frame:SetSize(CONFIRM_WIDTH, CONFIRM_HEIGHT)
    frame:SetPoint("CENTER", UIParent, "CENTER", 0, 0)
    applyBackdrop(frame)
    frame:Hide()

    frame.text = frame:CreateFontString(nil, "ARTWORK", "GameFontNormal")
    frame.text:SetPoint("TOP", frame, "TOP", 0, -16)
    frame.text:SetWidth(CONFIRM_TEXT_WIDTH)
    frame.text:SetJustifyH("CENTER")
    frame.text:SetText("Reset the current ForeverDB session? This cannot be undone.")

    frame.acceptButton = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
    frame.acceptButton:SetSize(CONFIRM_BUTTON_WIDTH, CONFIRM_BUTTON_HEIGHT)
    frame.acceptButton:SetPoint("BOTTOMLEFT", frame, "BOTTOM", 6, 16)
    frame.acceptButton:SetText("Reset")
    frame.acceptButton:SetScript("OnClick", function() FDB:ConfirmSessionReset() end)

    frame.cancelButton = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
    frame.cancelButton:SetSize(CONFIRM_BUTTON_WIDTH, CONFIRM_BUTTON_HEIGHT)
    frame.cancelButton:SetPoint("BOTTOMRIGHT", frame, "BOTTOM", -6, 16)
    frame.cancelButton:SetText("Cancel")
    frame.cancelButton:SetScript("OnClick", function() FDB:CancelSessionResetConfirmation() end)

    return frame
end

-- Both the Reset button and `/fdb session reset` enter this same
-- confirmation path; only a confirmed accept ever calls ResetSession().
function FDB:ShowSessionResetConfirmation()
    self.SessionResetConfirmationPending = true

    if StaticPopupDialogs and StaticPopup_Show then
        StaticPopupDialogs["FOREVERDB_SESSION_RESET"] = StaticPopupDialogs["FOREVERDB_SESSION_RESET"] or {
            text = "Reset the current ForeverDB session? This cannot be undone.",
            button1 = "Reset",
            button2 = "Cancel",
            OnAccept = function() FDB:ConfirmSessionReset() end,
            OnCancel = function() FDB:CancelSessionResetConfirmation() end,
            timeout = 0,
            whileDead = true,
            hideOnEscape = true,
            preferredIndex = 3,
        }
        StaticPopup_Show("FOREVERDB_SESSION_RESET")
        return
    end

    -- Fallback for a client without StaticPopup support: a minimal native
    -- confirmation frame using only base widget templates.
    if not self.SessionResetConfirmFrame then
        self.SessionResetConfirmFrame = buildResetConfirmFrame(self)
    end
    self.SessionResetConfirmFrame:Show()
end

--- Detailed session window ---------------------------------------------------

-- `specs` is a list of { key, x, y } tuples: every field this module
-- displays gets an explicit position, never just a created-but-unplaced
-- font string pair.
local function addKeyedRow(container, specs, labelTemplate, valueTemplate)
    local rows = {}
    for _, spec in ipairs(specs) do
        local label, value = createLabelValue(container, labelTemplate, valueTemplate, spec[2], spec[3])
        rows[spec[1]] = { label = label, value = value }
    end
    return rows
end

function FDB:BuildSessionDetailWindow()
    local frame = CreateFrame("Frame", "ForeverDBSessionWindow", UIParent, backdropTemplateName())
    frame:SetSize(DETAIL_WIDTH, DETAIL_HEIGHT)
    frame:SetMovable(true)
    frame:EnableMouse(true)
    frame:RegisterForDrag("LeftButton")
    frame:SetScript("OnDragStart", function(self) self:StartMoving() end)
    frame:SetScript("OnDragStop", function(self)
        self:StopMovingOrSizing()
        local point, _, relativePoint, x, y = self:GetPoint()
        FDB:SetSessionDetailWindowPosition(point, relativePoint, x, y)
    end)
    applyBackdrop(frame)
    frame:Hide()

    -- Open/closed state is deliberately not persisted (always starts
    -- closed after a reload); only the last dragged-to position is, so
    -- reopening it later doesn't jump back to the center default.
    local settings = FDB:GetSessionHUDSettings()
    frame:SetPoint(settings.detailPoint, UIParent, settings.detailRelativePoint, settings.detailX, settings.detailY)

    frame.title = frame:CreateFontString(nil, "ARTWORK", "GameFontNormalLarge")
    frame.title:SetPoint("TOP", frame, "TOP", 0, -12)
    frame.title:SetText("ForeverDB Session")

    -- "UIPanelCloseButton" is a classic-era template (present since
    -- vanilla, unlike the Legion-only "BackdropTemplate"), so it does not
    -- need the same registered-template guard; it is used unconditionally
    -- exactly like the "UIPanelButtonTemplate" buttons below already are.
    -- Closing only hides the window: it must never pause, reset, or clear
    -- the saved position, and /fdb session must still be able to reopen
    -- it afterward.
    frame.closeButton = CreateFrame("Button", nil, frame, "UIPanelCloseButton")
    frame.closeButton:SetSize(CLOSE_BUTTON_SIZE, CLOSE_BUTTON_SIZE)
    frame.closeButton:SetPoint("TOPRIGHT", frame, "TOPRIGHT", -4, -4)
    frame.closeButton:SetScript("OnClick", function() frame:Hide() end)

    -- ESC-close via the standard UISpecialFrames mechanism, guarded since
    -- its availability on this custom client is not certain; skipping it
    -- entirely is a safe fallback (the close button and /fdb session
    -- still work either way).
    if UISpecialFrames and frame.GetName and frame:GetName() then
        table.insert(UISpecialFrames, frame:GetName())
    end

    frame.kpi = addKeyedRow(frame, {
        { "xpPerHour", DETAIL_COL_X[1], DETAIL_KPI_ROW1_Y },
        { "xpGained", DETAIL_COL_X[2], DETAIL_KPI_ROW1_Y },
        { "toLevel", DETAIL_COL_X[3], DETAIL_KPI_ROW1_Y },
        { "goldEarned", DETAIL_COL_X[1], DETAIL_KPI_ROW2_Y },
        { "goldSpent", DETAIL_COL_X[2], DETAIL_KPI_ROW2_Y },
        { "netGold", DETAIL_COL_X[3], DETAIL_KPI_ROW2_Y },
    }, "GameFontNormalSmall", "GameFontHighlightSmall")
    frame.kpi.xpPerHour.label:SetText("XP/hr")
    frame.kpi.xpGained.label:SetText("XP gained")
    frame.kpi.toLevel.label:SetText("To level")
    frame.kpi.goldEarned.label:SetText("Gold earned")
    frame.kpi.goldSpent.label:SetText("Gold spent")
    frame.kpi.netGold.label:SetText("Net gold")

    frame.timing = addKeyedRow(frame, {
        { "session", DETAIL_TIMING_COL_X[1], DETAIL_TIMING_ROW1_Y },
        { "active", DETAIL_TIMING_COL_X[2], DETAIL_TIMING_ROW1_Y },
        { "status", DETAIL_TIMING_COL_X[1], DETAIL_TIMING_ROW2_Y },
        { "started", DETAIL_TIMING_COL_X[2], DETAIL_TIMING_ROW2_Y },
    }, "GameFontNormalSmall", "GameFontHighlightSmall")
    frame.timing.session.label:SetText("Session")
    frame.timing.active.label:SetText("Active")
    frame.timing.status.label:SetText("Status")
    frame.timing.started.label:SetText("Started")

    frame.character = addKeyedRow(frame, {
        { "level", DETAIL_COL_X[1], DETAIL_CHARACTER_ROW_Y },
        { "xp", DETAIL_COL_X[2], DETAIL_CHARACTER_ROW_Y },
        { "gold", DETAIL_COL_X[3], DETAIL_CHARACTER_ROW_Y },
    }, "GameFontNormalSmall", "GameFontHighlightSmall")
    frame.character.level.label:SetText("Level")
    frame.character.xp.label:SetText("XP")
    frame.character.gold.label:SetText("Gold")

    frame.character.xpBar = CreateFrame("StatusBar", nil, frame)
    frame.character.xpBar:SetSize(DETAIL_WIDTH - 2 * DETAIL_MARGIN, DETAIL_XPBAR_HEIGHT)
    frame.character.xpBar:SetPoint("TOPLEFT", frame, "TOPLEFT", DETAIL_MARGIN, DETAIL_XPBAR_Y)
    frame.character.xpBar:SetStatusBarTexture("Interface\\TargetingFrame\\UI-StatusBar")
    if frame.character.xpBar.SetStatusBarColor then
        frame.character.xpBar:SetStatusBarColor(0.6, 0.2, 0.9, 1)
    end
    frame.character.xpBarBackground = frame.character.xpBar:CreateTexture(nil, "BACKGROUND")
    frame.character.xpBarBackground:SetAllPoints(frame.character.xpBar)
    if frame.character.xpBarBackground.SetColorTexture then
        frame.character.xpBarBackground:SetColorTexture(0.1, 0.1, 0.1, 0.8)
    end

    frame.rates = addKeyedRow(frame, {
        { "earnedPerHour", DETAIL_COL_X[1], DETAIL_RATES_ROW_Y },
        { "spentPerHour", DETAIL_COL_X[2], DETAIL_RATES_ROW_Y },
        { "netPerHour", DETAIL_COL_X[3], DETAIL_RATES_ROW_Y },
    }, "GameFontNormalSmall", "GameFontHighlightSmall")
    frame.rates.earnedPerHour.label:SetText("Earned/hr")
    frame.rates.spentPerHour.label:SetText("Spent/hr")
    frame.rates.netPerHour.label:SetText("Net/hr")

    local historyViewportWidth = DETAIL_WIDTH - 2 * DETAIL_MARGIN
    frame.historyScroll = CreateFrame("ScrollFrame", nil, frame, "UIPanelScrollFrameTemplate")
    frame.historyScroll:SetPoint("TOPLEFT", frame, "TOPLEFT", DETAIL_MARGIN, DETAIL_HISTORY_TOP_Y)
    frame.historyScroll:SetSize(historyViewportWidth, DETAIL_HISTORY_HEIGHT)

    frame.historyContent = CreateFrame("Frame", nil, frame.historyScroll)
    frame.historyContent:SetPoint("TOPLEFT", frame.historyScroll, "TOPLEFT", 0, 0)
    frame.historyContent:SetSize(historyViewportWidth, HISTORY_ROW_HEIGHT) -- grows with row count on refresh
    if frame.historyScroll.SetScrollChild then
        frame.historyScroll:SetScrollChild(frame.historyContent)
    end
    frame.historyRows = {}

    local buttons = {
        { key = "pauseButton", text = "Pause", handler = function()
            FDB:PauseSession()
            FDB:RefreshSessionDetailWindow()
        end },
        { key = "resumeButton", text = "Resume", handler = function()
            FDB:ResumeSession()
            FDB:RefreshSessionDetailWindow()
        end },
        { key = "resetButton", text = "Reset", handler = function()
            FDB:ShowSessionResetConfirmation()
        end },
        { key = "lockButton", text = "Lock HUD", handler = function()
            FDB:ToggleSessionHUDLock()
            FDB:RefreshSessionDetailWindow()
        end },
        { key = "hudButton", text = "Hide HUD", handler = function()
            FDB:ToggleSessionHUD()
            FDB:RefreshSessionDetailWindow()
        end },
    }

    local totalButtonsWidth = (#buttons * BUTTON_WIDTH) + ((#buttons - 1) * BUTTON_GAP)
    local buttonStartX = (DETAIL_WIDTH - totalButtonsWidth) / 2
    for index, spec in ipairs(buttons) do
        local button = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
        button:SetSize(BUTTON_WIDTH, BUTTON_HEIGHT)
        local x = buttonStartX + (index - 1) * (BUTTON_WIDTH + BUTTON_GAP)
        button:SetPoint("BOTTOMLEFT", frame, "BOTTOMLEFT", x, DETAIL_BUTTON_ROW_Y)
        button:SetText(spec.text)
        button:SetScript("OnClick", spec.handler)
        frame[spec.key] = button
    end

    return frame
end

function FDB:RefreshSessionHistoryRows()
    local frame = self.SessionDetailWindow
    if not frame then return end

    local history = self:GetSessionHistory()
    local count = #history
    -- GetWidth() is the real Frame API; a bare `.width` table field only
    -- ever existed on the test mock, so relying on it would silently do
    -- nothing on a live client and fall through to the constant below.
    local rowWidth = (frame.historyScroll.GetWidth and frame.historyScroll:GetWidth()) or 0
    if rowWidth <= 0 then rowWidth = DETAIL_WIDTH - 2 * DETAIL_MARGIN end

    for index = 1, count do
        -- GetSessionHistory() returns storage order (oldest-appended-
        -- first -- an internal detail the eviction logic relies on,
        -- `table.remove(char.history, 1)` evicts the oldest). Newest
        -- session must render at row 1 regardless, so read from the
        -- reversed position.
        local record = history[count - index + 1]

        local row = frame.historyRows[index]
        if not row then
            row = frame.historyContent:CreateFontString(nil, "ARTWORK", "GameFontHighlightSmall")
            row:SetWidth(rowWidth)
            row:SetJustifyH("LEFT")
            frame.historyRows[index] = row
        end

        -- Each row gets its own distinct vertical slot, newest (index 1)
        -- at the top, so 30 rows genuinely stack past the visible
        -- viewport rather than overlapping at a single shared position.
        row:ClearAllPoints()
        row:SetPoint("TOPLEFT", frame.historyContent, "TOPLEFT", 0, -(index - 1) * HISTORY_ROW_HEIGHT)

        local parts = {
            formatTimestamp(record.endedAt or record.startedAt),
            formatHMS(record.trackedSeconds),
            formatHMS(record.activeSeconds),
            tostring(record.startLevel or "?") .. "->" .. tostring(record.endLevel or "?"),
            formatCompactNumber(record.xpGained),
            formatCompactNumber(record.xpPerHour),
            formatCopperShort(record.goldEarned),
            formatCopperShort(record.goldSpent),
            formatCopperShort(record.netGold),
        }
        row:SetText(table.concat(parts, " | "))
        row:Show()
    end

    for index = #history + 1, #frame.historyRows do
        frame.historyRows[index]:Hide()
    end

    -- The scroll child's height must track the actual row count so 30
    -- retained records can genuinely scroll past a fixed-height viewport
    -- instead of being clipped or overlapping.
    local contentHeight = math.max(#history, 1) * HISTORY_ROW_HEIGHT
    frame.historyContent:SetSize(rowWidth, contentHeight)
end

function FDB:RefreshSessionDetailWindow()
    local frame = self.SessionDetailWindow
    if not frame then return end

    local snapshot = self:GetSessionSnapshot()
    local settings = self:GetSessionHUDSettings()

    frame.lockButton:SetText(settings.hudLocked and "Unlock HUD" or "Lock HUD")
    frame.hudButton:SetText(settings.hudShown and "Hide HUD" or "Show HUD")

    if not snapshot then
        self:RefreshSessionHistoryRows()
        return
    end

    frame.kpi.xpPerHour.value:SetText(formatCompactNumber(snapshot.xpPerHour))
    frame.kpi.xpGained.value:SetText(formatCompactNumber(snapshot.xpGained))
    frame.kpi.toLevel.value:SetText(snapshot.isMaxLevel and "MAX" or formatHMS(snapshot.etaSeconds))
    frame.kpi.goldEarned.value:SetText(formatCopperShort(snapshot.goldEarned))
    frame.kpi.goldSpent.value:SetText(formatCopperShort(snapshot.goldSpent))
    frame.kpi.netGold.value:SetText(formatCopperShort(snapshot.netGold))
    local netGoldColor = netColor(snapshot.netGold)
    frame.kpi.netGold.value:SetTextColor(netGoldColor[1], netGoldColor[2], netGoldColor[3])

    frame.timing.session.value:SetText(formatHMS(snapshot.trackedSeconds))
    frame.timing.active.value:SetText(formatHMS(snapshot.activeSeconds))
    frame.timing.status.value:SetText(snapshot.status or "")
    frame.timing.started.value:SetText(formatTimestamp(snapshot.startedAt))

    frame.character.level.value:SetText(tostring(snapshot.level or "--"))
    frame.character.xp.value:SetText(
        tostring(snapshot.currentXP or "--") .. " / " .. tostring(snapshot.currentXPMax or "--"))
    frame.character.gold.value:SetText(formatCopperShort(snapshot.currentMoney))
    if frame.character.xpBar.SetMinMaxValues and type(snapshot.currentXPMax) == "number"
        and snapshot.currentXPMax > 0 then
        frame.character.xpBar:SetMinMaxValues(0, snapshot.currentXPMax)
        frame.character.xpBar:SetValue(snapshot.currentXP or 0)
    end

    frame.rates.earnedPerHour.value:SetText(formatCopperShort(snapshot.earnedPerHour))
    frame.rates.spentPerHour.value:SetText(formatCopperShort(snapshot.spentPerHour))
    frame.rates.netPerHour.value:SetText(formatCopperShort(snapshot.netPerHour))
    local netRateColor = netColor(snapshot.netPerHour)
    frame.rates.netPerHour.value:SetTextColor(netRateColor[1], netRateColor[2], netRateColor[3])

    self:RefreshSessionHistoryRows()
end

function FDB:ToggleSessionWindow()
    if not self.SessionDetailWindow then
        self.SessionDetailWindow = self:BuildSessionDetailWindow()
    end

    local frame = self.SessionDetailWindow
    if frame:IsShown() then
        frame:Hide()
        return false
    end

    frame:Show()
    self:RefreshSessionDetailWindow()
    return true
end

--- Slash command routing -----------------------------------------------------

local SESSION_COMMAND_USAGE =
    "usage: /fdb session [pause|resume|reset|hud|lock|timeout <minutes>|idle <minutes>]"

function FDB:HandleSessionCommand(rawArgs)
    local trimmed = (rawArgs or ""):match("^%s*(.-)%s*$")
    local command, rest = trimmed:match("^(%S*)%s*(.-)$")
    command = (command or ""):lower()

    if command == "" then
        self:ToggleSessionWindow()
        return true
    elseif command == "pause" then
        self:PauseSession()
        self:RefreshSessionUI()
        self:RefreshSessionDetailWindow()
        return true
    elseif command == "resume" then
        self:ResumeSession()
        self:RefreshSessionUI()
        self:RefreshSessionDetailWindow()
        return true
    elseif command == "reset" then
        self:ShowSessionResetConfirmation()
        return true
    elseif command == "hud" then
        self:ToggleSessionHUD()
        self:RefreshSessionDetailWindow()
        return true
    elseif command == "lock" then
        self:ToggleSessionHUDLock()
        self:RefreshSessionDetailWindow()
        return true
    elseif command == "timeout" then
        local ok, err = self:SetSessionOfflineTimeout(tonumber(rest))
        if not ok then
            print("|cff7dd3fcForeverDB|r", err or SESSION_COMMAND_USAGE)
            return false
        end
        return true
    elseif command == "idle" then
        local ok, err = self:SetSessionInactivityTimeout(tonumber(rest))
        if not ok then
            print("|cff7dd3fcForeverDB|r", err or SESSION_COMMAND_USAGE)
            return false
        end
        return true
    end

    print("|cff7dd3fcForeverDB|r", SESSION_COMMAND_USAGE)
    return false
end
