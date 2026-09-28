local _, FDB = ...

-- ForeverDB Session UI: compact HUD and (later) detailed session window.
-- This module owns presentation only. It must read normalized snapshots
-- from SessionTracker.lua and must never calculate XP/gold/time itself.

local HUD_REFRESH_INTERVAL = 1

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

local function createLabelValue(parent, labelTemplate, valueTemplate)
    local label = parent:CreateFontString(nil, "ARTWORK", labelTemplate)
    local value = parent:CreateFontString(nil, "ARTWORK", valueTemplate)
    return label, value
end

function FDB:BuildSessionHUDFrame()
    local frame = CreateFrame("Frame", "ForeverDBSessionHUD", UIParent, "BackdropTemplate")
    frame:SetSize(220, 112)
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
        createLabelValue(frame, "GameFontNormalSmall", "GameFontHighlightSmall")
    frame.toLevelLabel, frame.toLevelValue =
        createLabelValue(frame, "GameFontNormalSmall", "GameFontHighlightSmall")
    frame.goldHrLabel, frame.goldHrValue =
        createLabelValue(frame, "GameFontNormalSmall", "GameFontHighlightSmall")
    frame.netHrLabel, frame.netHrValue =
        createLabelValue(frame, "GameFontNormalSmall", "GameFontHighlightSmall")
    frame.activeLabel, frame.activeValue =
        createLabelValue(frame, "GameFontNormalSmall", "GameFontHighlightSmall")

    frame.xpHrLabel:SetText("XP/hr")
    frame.toLevelLabel:SetText("To level")
    frame.goldHrLabel:SetText("Gold/hr")
    frame.netHrLabel:SetText("Net/hr")
    frame.activeLabel:SetText("Active")

    frame.statusText = frame:CreateFontString(nil, "ARTWORK", "GameFontNormalSmall")
    frame.characterText = frame:CreateFontString(nil, "ARTWORK", "GameFontNormalSmall")

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

function FDB:StartSessionUIRefreshTicker()
    local interval = HUD_REFRESH_INTERVAL
    if C_Timer and C_Timer.NewTicker then
        C_Timer.NewTicker(interval, function() self:RefreshSessionUI() end)
    elseif C_Timer and C_Timer.After then
        local function tick()
            self:RefreshSessionUI()
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

    self:ApplySessionHUDPosition()
    self:ApplySessionHUDVisibility()
    self:RefreshSessionUI()

    self:StartSessionUIRefreshTicker()
end
