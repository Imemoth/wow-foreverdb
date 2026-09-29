local _, FDB = ...

-- ForeverDB Session UI: compact HUD and detailed session window. This
-- module owns presentation only. It must read normalized snapshots from
-- SessionTracker.lua and must never calculate XP/gold/time itself.

local HUD_REFRESH_INTERVAL = 1

--- Type / color discipline --------------------------------------------------
-- Four text hierarchy steps, reused everywhere rather than inventing new
-- font sizes/weights per section: KPI values (biggest), body values /
-- history primary line, section headings, and labels / history secondary
-- line (smallest/most muted -- GameFontDisableSmall is used specifically
-- where extra dimming reads better, e.g. history secondary lines and the
-- empty-state message, but it is the same visual step as GameFontNormalSmall).
local FONT_KPI_VALUE = "GameFontHighlight"
local FONT_BODY_VALUE = "GameFontHighlightSmall"
local FONT_SECTION_HEADING = "GameFontNormal"
local FONT_LABEL = "GameFontNormalSmall"
local FONT_MUTED_SMALL = "GameFontDisableSmall"

--- Layout constants ---------------------------------------------------------
-- Implements the approved "ForeverDB Dimensioned Spec -- Wide Detail
-- Window": every band's height is an explicit constant and the full
-- vertical budget sums to exactly DETAIL_HEIGHT (asserted below). The
-- dimensioned spec's minimum responsive target is 720x480 at ~1.54 aspect
-- ratio with the Recent Sessions viewport as the only elastic band; no
-- runtime resizing exists in this addon, so only the nominal 800x520
-- target is implemented.

local HUD_WIDTH, HUD_HEIGHT = 240, 112
local HUD_COL1_X, HUD_COL2_X = 14, 128
local HUD_TITLE_Y = -8
local HUD_ROW1_Y, HUD_ROW2_Y, HUD_ROW3_Y = -26, -46, -66
local HUD_STATUS_Y = 10 -- offset up from the bottom edge

local DETAIL_WIDTH, DETAIL_HEIGHT = 800, 520
local DETAIL_MARGIN = 16 -- left/right window padding; content width = 768

-- Vertical budget, top to bottom -- must sum to exactly DETAIL_HEIGHT.
local DETAIL_TOP_PADDING = 16
local DETAIL_TITLE_BAND_HEIGHT = 48
local DETAIL_BAND_GAP = 12
local DETAIL_KPI_BAND_HEIGHT = 56
local DETAIL_GROUP_BAND_HEIGHT = 118
local DETAIL_HISTORY_BAND_HEIGHT = 186
local DETAIL_ACTION_BAND_HEIGHT = 28
local DETAIL_BOTTOM_PADDING = 20

local DETAIL_TITLE_TOP_Y = -DETAIL_TOP_PADDING
local DETAIL_KPI_TOP_Y = DETAIL_TITLE_TOP_Y - DETAIL_TITLE_BAND_HEIGHT - DETAIL_BAND_GAP
local DETAIL_GROUP_TOP_Y = DETAIL_KPI_TOP_Y - DETAIL_KPI_BAND_HEIGHT - DETAIL_BAND_GAP
local DETAIL_HISTORY_TOP_Y = DETAIL_GROUP_TOP_Y - DETAIL_GROUP_BAND_HEIGHT - DETAIL_BAND_GAP
local DETAIL_ACTION_TOP_Y = DETAIL_HISTORY_TOP_Y - DETAIL_HISTORY_BAND_HEIGHT - DETAIL_BAND_GAP
-- Sanity check the vertical budget sums to DETAIL_HEIGHT exactly, so a
-- future constant edit that breaks the arithmetic fails loudly at load
-- time instead of silently clipping the bottom of the window.
assert(-(DETAIL_ACTION_TOP_Y - DETAIL_ACTION_BAND_HEIGHT - DETAIL_BOTTOM_PADDING) == DETAIL_HEIGHT,
    "SessionUI detail window vertical budget must sum to DETAIL_HEIGHT")

local CLOSE_BUTTON_SIZE = 24
local CLOSE_BUTTON_MARGIN = 8
local CLOSE_BUTTON_Y = DETAIL_TITLE_TOP_Y + (DETAIL_TITLE_BAND_HEIGHT - CLOSE_BUTTON_SIZE) / 2
local TITLE_TEXT_Y = DETAIL_TITLE_TOP_Y - 14

--- KPI band: six equal cards in one horizontal row --------------------------
local KPI_CARD_COUNT = 6
local KPI_CARD_GAP = 8
local KPI_CONTENT_WIDTH = DETAIL_WIDTH - 2 * DETAIL_MARGIN -- 768
local KPI_CARD_WIDTH = (KPI_CONTENT_WIDTH - (KPI_CARD_COUNT - 1) * KPI_CARD_GAP) / KPI_CARD_COUNT -- ~121.3
local KPI_CARD_HEIGHT = DETAIL_KPI_BAND_HEIGHT -- 56

local KPI_CARD_FILL_COLOR = { 0x16 / 255, 0x13 / 255, 0x0e / 255, 0.6 }
local KPI_CARD_EDGE_COLOR = { 0x6b / 255, 0x55 / 255, 0x27 / 255, 0.45 }

--- Three-column group band: Session Timing | Character | Rates -------------
local GROUP_PANEL_COUNT = 3
local GROUP_PANEL_GAP = 12
local GROUP_PANEL_WIDTH = (KPI_CONTENT_WIDTH - (GROUP_PANEL_COUNT - 1) * GROUP_PANEL_GAP) / GROUP_PANEL_COUNT -- 248
local GROUP_PANEL_HEIGHT = DETAIL_GROUP_BAND_HEIGHT -- 118
local GROUP_PANEL_X = {
    DETAIL_MARGIN,
    DETAIL_MARGIN + GROUP_PANEL_WIDTH + GROUP_PANEL_GAP,
    DETAIL_MARGIN + 2 * (GROUP_PANEL_WIDTH + GROUP_PANEL_GAP),
}

local PANEL_SIDE_PADDING = 10
local PANEL_TOP_PADDING = 6
local PANEL_HEADING_LINE = 14 -- assumed single-line heading height for our own spacing math
local PANEL_HEADING_GAP = 5   -- clear space after the heading, before the divider
local PANEL_DIVIDER_HEIGHT = 1
local PANEL_DIVIDER_GAP = 6   -- clear space after the divider, before content rows
-- Bumped from 20: the live client reported Session Timing's rows visibly
-- crowding/overlapping. A single stacked column at a slightly taller row
-- height is far more robust against real (uncertain) live font metrics
-- than a tight 2-column grid ever was.
local PANEL_ROW_HEIGHT = 22

local PANEL_DIVIDER_Y = -(PANEL_TOP_PADDING + PANEL_HEADING_LINE + PANEL_HEADING_GAP)
local PANEL_CONTENT_START_Y = PANEL_DIVIDER_Y - PANEL_DIVIDER_HEIGHT - PANEL_DIVIDER_GAP
local PANEL_ROW1_Y = PANEL_CONTENT_START_Y
local PANEL_ROW2_Y = PANEL_CONTENT_START_Y - PANEL_ROW_HEIGHT
local PANEL_ROW3_Y = PANEL_CONTENT_START_Y - 2 * PANEL_ROW_HEIGHT
-- Only Session Timing needs a 4th stacked row (Session/Active/Status/Started).
local PANEL_ROW4_Y = PANEL_CONTENT_START_Y - 3 * PANEL_ROW_HEIGHT

-- Every group panel row is a single label+value column now -- the live
-- client showed the old 2-column Session Timing grid crowding/colliding,
-- and a single column is inherently more robust against real font-metric
-- variance than a tight 2-column grid.
local PANEL_COL_X = PANEL_SIDE_PADDING

--- Icon integration ----------------------------------------------------------
-- Small pictogram textures shipped with the addon itself
-- (addon/ForeverDB/Textures/Session/*.tga, converted from the approved
-- icon pack -- never a guessed native Interface\Icons atlas name), used
-- only as row/heading cues on Session Timing, Character, and Recent
-- Sessions. Purely decorative: reserving their gutter never changes any
-- row/heading Y position already validated by Reviewer G, and every row
-- within a panel that has ANY icon shifts its label by the same fixed
-- amount (whether or not that specific row has its own icon), so labels
-- stay column-aligned instead of going ragged.
local ICON_TEXTURE_PATH = "Interface\\AddOns\\ForeverDB\\Textures\\Session\\"
local HEADER_ICON_SIZE = 18
local HEADER_ICON_GAP = 4
local ROW_ICON_SIZE = 16
local ROW_ICON_GAP = 4
local PANEL_HEADING_X_WITH_ICON = PANEL_SIDE_PADDING + HEADER_ICON_SIZE + HEADER_ICON_GAP
local PANEL_COL_X_WITH_ICON = PANEL_SIDE_PADDING + ROW_ICON_SIZE + ROW_ICON_GAP

local DIVIDER_COLOR = { 0x6b / 255, 0x55 / 255, 0x27 / 255, 0.35 }

-- The XP bar lives only inside the Character panel -- it must never span
-- the full detail-window width. It sits directly under the XP row (so it
-- visually belongs to XP, not Gold); Gold is the panel's last row, below
-- the bar, per the approved order: Level, XP, XP bar, Gold.
local XPBAR_WIDTH, XPBAR_HEIGHT = 228, 7

-- Live client evidence: measuring the bar's gap from the XP row's TOP
-- anchor to the bar's TOP anchor (as a prior round did) is not the same
-- as real clear space, since it ignores the XP row's own rendered text
-- height -- that produced a bar that visually touched/overlapped the XP
-- text. Gaps are now measured from the actual bottom edge of the row
-- above (top anchor Y minus this assumed single-line text height) to the
-- top edge of what follows, so the reported "too tight" spacing is
-- genuinely fixed rather than just moved by an arbitrary constant.
local CHARACTER_ROW_TEXT_HEIGHT = 14
local XP_TEXT_BOTTOM_Y = PANEL_ROW2_Y - CHARACTER_ROW_TEXT_HEIGHT
local XPBAR_GAP_ABOVE = 11 -- clear space between the XP text's bottom edge and the bar's top edge (target 10-12)
local XPBAR_Y = XP_TEXT_BOTTOM_Y - XPBAR_GAP_ABOVE
local XPBAR_BOTTOM_Y = XPBAR_Y - XPBAR_HEIGHT
local XPBAR_GAP_BELOW = 13 -- clear space between the bar's bottom edge and Gold's top edge (target 12-14)
local CHARACTER_GOLD_Y = XPBAR_BOTTOM_Y - XPBAR_GAP_BELOW
local XPBAR_FILL_COLOR = { 0x6b / 255, 0x5a / 255, 0xa6 / 255 }
local XPBAR_TRACK_COLOR = { 0.08, 0.07, 0.11, 0.85 }

--- Recent Sessions band ------------------------------------------------------
local HISTORY_HEADER_HEIGHT = 14
local HISTORY_HEADER_GAP = 12
-- A non-scrolling column-header row ("Date & Time | Duration | XP Gained |
-- XP/hr | Net Gold") sits between the "Recent Sessions" title and the
-- scrollable viewport, so each column's values line up under a label
-- instead of running together as one bullet-joined string -- the live
-- client reported the old single-line format reading as cramped/collapsed.
-- The viewport shrinks by exactly the column header's height + gap so the
-- band's total height is unchanged; the dimensioned spec explicitly calls
-- the Recent Sessions viewport "the ONLY elastic vertical band" for this
-- kind of internal adjustment.
local HISTORY_COLUMN_HEADER_HEIGHT = 16
local HISTORY_COLUMN_HEADER_GAP = 4
local HISTORY_VIEWPORT_HEIGHT = 140
local HISTORY_COLUMN_HEADER_Y = DETAIL_HISTORY_TOP_Y - HISTORY_HEADER_HEIGHT - HISTORY_HEADER_GAP
local HISTORY_VIEWPORT_Y = HISTORY_COLUMN_HEADER_Y - HISTORY_COLUMN_HEADER_HEIGHT - HISTORY_COLUMN_HEADER_GAP
assert(-(HISTORY_VIEWPORT_Y - HISTORY_VIEWPORT_HEIGHT) == -(DETAIL_HISTORY_TOP_Y - DETAIL_HISTORY_BAND_HEIGHT),
    "SessionUI Recent Sessions viewport must exactly fill its band")

-- Real, fixed-width columns for the primary line -- genuine table columns
-- anchored at these exact x offsets (shared by both the column-header row
-- and every data row), not a single bullet-joined string whose field
-- boundaries shifted with preceding text length.
local HISTORY_COL_X = { 0, 180, 300, 420, 540 }
local HISTORY_COL_WIDTH = { 170, 110, 110, 110, 180 }
local HISTORY_COL_LABELS = { "Date & Time", "Duration", "XP Gained", "XP/hr", "Net Gold" }

-- Two-line records (32px) are the default; a record whose secondary line
-- would be entirely empty (no level change, zero earned, zero spent)
-- collapses to a single-line ~20px record instead of showing a blank
-- second line.
local HISTORY_RECORD_HEIGHT = 32
local HISTORY_RECORD_HEIGHT_COLLAPSED = 20
local HISTORY_LINE_GAP = 3
local HISTORY_SCROLL_STEP = HISTORY_RECORD_HEIGHT
local HISTORY_ROW_EVEN_TINT = { 1, 1, 1, 0.04 }

--- Action bar -----------------------------------------------------------------
local BUTTON_WIDTH, BUTTON_HEIGHT = 96, 22
local BUTTON_GAP = 10
local BUTTON_SEPARATOR_GAP = BUTTON_GAP -- extra clearance around the Reset button
local BUTTON_ROW_Y = DETAIL_ACTION_TOP_Y + (DETAIL_ACTION_BAND_HEIGHT - BUTTON_HEIGHT) / 2

local CONFIRM_WIDTH, CONFIRM_HEIGHT = 260, 110
local CONFIRM_TEXT_WIDTH = CONFIRM_WIDTH - 32
local CONFIRM_BUTTON_WIDTH, CONFIRM_BUTTON_HEIGHT = 90, 22

-- Exposed so tests assert geometry against the one authoritative set of
-- numbers instead of re-deriving or hardcoding duplicates that could
-- silently drift from the real layout.
FDB.SessionUILayout = {
    detailWidth = DETAIL_WIDTH,
    detailHeight = DETAIL_HEIGHT,
    detailMargin = DETAIL_MARGIN,
    hudWidth = HUD_WIDTH,
    hudHeight = HUD_HEIGHT,
    kpiCardCount = KPI_CARD_COUNT,
    kpiCardWidth = KPI_CARD_WIDTH,
    kpiCardHeight = KPI_CARD_HEIGHT,
    groupPanelCount = GROUP_PANEL_COUNT,
    groupPanelWidth = GROUP_PANEL_WIDTH,
    groupPanelHeight = GROUP_PANEL_HEIGHT,
    historyViewportHeight = HISTORY_VIEWPORT_HEIGHT,
    historyRecordHeight = HISTORY_RECORD_HEIGHT,
    historyRecordHeightCollapsed = HISTORY_RECORD_HEIGHT_COLLAPSED,
    historyColumnCount = #HISTORY_COL_X,
    historyColumnX = HISTORY_COL_X,
    historyColumnWidth = HISTORY_COL_WIDTH,
    historyColumnLabels = HISTORY_COL_LABELS,
    panelRowHeight = PANEL_ROW_HEIGHT,
    characterRowTextHeight = CHARACTER_ROW_TEXT_HEIGHT,
    iconTexturePath = ICON_TEXTURE_PATH,
    headerIconSize = HEADER_ICON_SIZE,
    rowIconSize = ROW_ICON_SIZE,
    panelHeadingXWithIcon = PANEL_HEADING_X_WITH_ICON,
    panelColXWithIcon = PANEL_COL_X_WITH_ICON,
    xpBarWidth = XPBAR_WIDTH,
    xpBarHeight = XPBAR_HEIGHT,
    xpBarGapAbove = XPBAR_GAP_ABOVE,
    xpBarGapBelow = XPBAR_GAP_BELOW,
    actionBandHeight = DETAIL_ACTION_BAND_HEIGHT,
}

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

-- Exposed for tests and for SessionUI's own detailed-window code so
-- formatting logic is defined exactly once.
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

-- Restrained, not harsh: no channel fully saturated. RUNNING reads
-- greenish-positive, IDLE a muted neutral/sandy yellow, PAUSED a muted
-- orange/red -- distinct from each other without being alarming.
local STATUS_RUNNING_COLOR = { 0.45, 0.75, 0.45 }
local STATUS_IDLE_COLOR = { 0.75, 0.7, 0.35 }
local STATUS_PAUSED_COLOR = { 0.75, 0.45, 0.3 }

local function statusColor(status)
    if status == "RUNNING" then return STATUS_RUNNING_COLOR end
    if status == "IDLE" then return STATUS_IDLE_COLOR end
    if status == "PAUSED" then return STATUS_PAUSED_COLOR end
    return NEUTRAL_COLOR
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

-- A small flat-color card fill + thin restrained border, used for the KPI
-- band's six cards. "Interface\Buttons\WHITE8x8" is a plain recolorable
-- white texture bundled with the client (safe on any build), used purely
-- as a tintable rectangle for both the fill and the 1px edge.
local CARD_BACKDROP = {
    bgFile = "Interface\\Buttons\\WHITE8x8",
    edgeFile = "Interface\\Buttons\\WHITE8x8",
    edgeSize = 1,
    insets = { left = 0, right = 0, top = 0, bottom = 0 },
}

local function applyCardBackdrop(frame, fillColor, edgeColor)
    if frame.SetBackdrop then
        frame:SetBackdrop(CARD_BACKDROP)
        if frame.SetBackdropColor then
            frame:SetBackdropColor(fillColor[1], fillColor[2], fillColor[3], fillColor[4])
        end
        if frame.SetBackdropBorderColor then
            frame:SetBackdropBorderColor(edgeColor[1], edgeColor[2], edgeColor[3], edgeColor[4])
        end
        return
    end

    -- Guarded fallback for a client without backdrop mixin support: fill
    -- only, no border -- consistent with applyBackdrop()'s HUD/window
    -- fallback.
    local background = frame:CreateTexture(nil, "BACKGROUND")
    background:SetAllPoints(frame)
    if background.SetColorTexture then
        background:SetColorTexture(fillColor[1], fillColor[2], fillColor[3], fillColor[4])
    end
    frame.fallbackBackground = background
end

-- Prevents a FontString from wrapping to a second line: KPI cards and
-- history rows are laid out at fixed heights, so wrapped text would
-- either overflow a card or overlap the next history row. Guarded since
-- SetWordWrap is not guaranteed on every client build; its absence just
-- means the (short, formatted) values may wrap in that rare case rather
-- than erroring.
local function setSingleLine(fontString)
    if fontString.SetWordWrap then fontString:SetWordWrap(false) end
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
    setSingleLine(label)
    setSingleLine(value)
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

    frame.title = frame:CreateFontString(nil, "ARTWORK", FONT_SECTION_HEADING)
    frame.title:SetPoint("TOP", frame, "TOP", 0, HUD_TITLE_Y)
    frame.title:SetText("ForeverDB Session")

    -- Primary rate values (XP/hr, Gold/hr, Net/hr) use one font-weight
    -- step above the other three fields (XP gained, To level, Active),
    -- per the dimensioned spec -- no additional colors for this
    -- hierarchy, only the size/weight step already defined above.
    frame.xpHrLabel, frame.xpHrValue =
        createLabelValue(frame, FONT_LABEL, FONT_KPI_VALUE, HUD_COL1_X, HUD_ROW1_Y)
    frame.xpGainedLabel, frame.xpGainedValue =
        createLabelValue(frame, FONT_LABEL, FONT_BODY_VALUE, HUD_COL2_X, HUD_ROW1_Y)
    frame.goldHrLabel, frame.goldHrValue =
        createLabelValue(frame, FONT_LABEL, FONT_KPI_VALUE, HUD_COL1_X, HUD_ROW2_Y)
    frame.netHrLabel, frame.netHrValue =
        createLabelValue(frame, FONT_LABEL, FONT_KPI_VALUE, HUD_COL2_X, HUD_ROW2_Y)
    frame.toLevelLabel, frame.toLevelValue =
        createLabelValue(frame, FONT_LABEL, FONT_BODY_VALUE, HUD_COL1_X, HUD_ROW3_Y)
    frame.activeLabel, frame.activeValue =
        createLabelValue(frame, FONT_LABEL, FONT_BODY_VALUE, HUD_COL2_X, HUD_ROW3_Y)

    frame.xpHrLabel:SetText("XP/hr")
    frame.xpGainedLabel:SetText("XP gained")
    frame.goldHrLabel:SetText("Gold/hr")
    frame.netHrLabel:SetText("Net/hr")
    frame.toLevelLabel:SetText("To level")
    frame.activeLabel:SetText("Active")

    frame.statusText = frame:CreateFontString(nil, "ARTWORK", FONT_LABEL)
    frame.statusText:SetPoint("BOTTOMLEFT", frame, "BOTTOMLEFT", HUD_COL1_X, HUD_STATUS_Y)

    frame.characterText = frame:CreateFontString(nil, "ARTWORK", FONT_LABEL)
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
        frame.xpGainedValue:SetText("--")
        frame.toLevelValue:SetText("--:--")
        frame.goldHrValue:SetText("--")
        frame.netHrValue:SetText("--")
        frame.activeValue:SetText("--:--")
        frame.statusText:SetText("")
        frame.characterText:SetText("")
        return
    end

    frame.xpHrValue:SetText(formatCompactNumber(snapshot.xpPerHour))
    frame.xpGainedValue:SetText(formatCompactNumber(snapshot.xpGained))

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
    local sColor = statusColor(snapshot.status)
    frame.statusText:SetTextColor(sColor[1], sColor[2], sColor[3])

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

-- A small standalone KPI "card" panel: its own frame with a flat-color
-- fill and a thin restrained bronze edge, so the six figures read as
-- distinct blocks in a single row per the dimensioned spec. The card's
-- own size is fixed by SetSize and never changes with text content --
-- label/value are single-line (setSingleLine) so long text clips inside
-- the card rather than wrapping and resizing the visual grid.
local function createKPICard(parent, x, y, width, height, labelText)
    local card = CreateFrame("Frame", nil, parent, backdropTemplateName())
    card:SetSize(width, height)
    card:SetPoint("TOPLEFT", parent, "TOPLEFT", x, y)
    applyCardBackdrop(card, KPI_CARD_FILL_COLOR, KPI_CARD_EDGE_COLOR)

    local label = card:CreateFontString(nil, "ARTWORK", FONT_LABEL)
    label:SetPoint("TOP", card, "TOP", 0, -8)
    label:SetWidth(width - 8)
    label:SetJustifyH("CENTER")
    label:SetText(labelText)
    setSingleLine(label)

    local value = card:CreateFontString(nil, "ARTWORK", FONT_KPI_VALUE)
    value:SetPoint("TOP", label, "BOTTOM", 0, -4)
    value:SetWidth(width - 8)
    value:SetJustifyH("CENTER")
    setSingleLine(value)

    return { card = card, label = label, value = value }
end

-- A small caption above a block, purely for visual hierarchy -- adds
-- structure without needing new art or a heavier widget.
local function addSectionHeader(parent, x, y, text)
    local header = parent:CreateFontString(nil, "ARTWORK", FONT_SECTION_HEADING)
    header:SetPoint("TOPLEFT", parent, "TOPLEFT", x, y)
    header:SetText(text)
    return header
end

-- A small pictogram icon from the addon's own local Textures/Session
-- folder (never a guessed native atlas name). Purely decorative; callers
-- are responsible for reserving its gutter so surrounding text never
-- collides with it.
local function createIcon(parent, fileBaseName, x, y, size)
    local icon = parent:CreateTexture(nil, "ARTWORK")
    icon:SetPoint("TOPLEFT", parent, "TOPLEFT", x, y)
    icon:SetSize(size, size)
    icon:SetTexture(ICON_TEXTURE_PATH .. fileBaseName .. ".tga")
    return icon
end

-- One of the three group-band panels (Session Timing / Character /
-- Rates): an optional heading icon, a heading, 5px clear space, a 1px
-- restrained divider, 6px clear space, then content rows -- no heavy
-- outer panel box, per the dimensioned spec. When headingIcon is given,
-- the icon and heading share the same top-left Y (both start at
-- -PANEL_TOP_PADDING) and the heading shifts right by the icon's
-- reserved gutter; the divider is untouched either way.
local function createGroupPanel(parent, x, y, width, height, headingText, headingIcon)
    local panel = CreateFrame("Frame", nil, parent)
    panel:SetSize(width, height)
    panel:SetPoint("TOPLEFT", parent, "TOPLEFT", x, y)

    local icon
    local headingX = PANEL_SIDE_PADDING
    if headingIcon then
        icon = createIcon(panel, headingIcon, PANEL_SIDE_PADDING, -PANEL_TOP_PADDING, HEADER_ICON_SIZE)
        headingX = PANEL_HEADING_X_WITH_ICON
    end

    local heading = panel:CreateFontString(nil, "ARTWORK", FONT_SECTION_HEADING)
    heading:SetPoint("TOPLEFT", panel, "TOPLEFT", headingX, -PANEL_TOP_PADDING)
    heading:SetText(headingText)
    setSingleLine(heading)

    local divider = panel:CreateTexture(nil, "ARTWORK")
    divider:SetPoint("TOPLEFT", panel, "TOPLEFT", PANEL_SIDE_PADDING, PANEL_DIVIDER_Y)
    divider:SetSize(width - 2 * PANEL_SIDE_PADDING, PANEL_DIVIDER_HEIGHT)
    if divider.SetColorTexture then
        divider:SetColorTexture(DIVIDER_COLOR[1], DIVIDER_COLOR[2], DIVIDER_COLOR[3], DIVIDER_COLOR[4])
    end

    return { panel = panel, heading = heading, divider = divider, icon = icon }
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
    frame.title:SetPoint("TOP", frame, "TOP", 0, TITLE_TEXT_Y)
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
    frame.closeButton:SetPoint("TOPRIGHT", frame, "TOPRIGHT", -CLOSE_BUTTON_MARGIN, CLOSE_BUTTON_Y)
    frame.closeButton:SetScript("OnClick", function() frame:Hide() end)

    -- ESC-close via the standard UISpecialFrames mechanism, guarded since
    -- its availability on this custom client is not certain; skipping it
    -- entirely is a safe fallback (the close button and /fdb session
    -- still work either way).
    if UISpecialFrames and frame.GetName and frame:GetName() then
        table.insert(UISpecialFrames, frame:GetName())
    end

    --- KPI band: six cards in one row, per the dimensioned spec's order.
    frame.kpi = {}
    local kpiSpecs = {
        { key = "xpPerHour", text = "XP/hr" },
        { key = "xpGained", text = "XP gained" },
        { key = "toLevel", text = "To level" },
        { key = "goldEarned", text = "Gold earned" },
        { key = "goldSpent", text = "Gold spent" },
        { key = "netGold", text = "Net gold" },
    }
    for i, spec in ipairs(kpiSpecs) do
        local x = DETAIL_MARGIN + (i - 1) * (KPI_CARD_WIDTH + KPI_CARD_GAP)
        frame.kpi[spec.key] = createKPICard(frame, x, DETAIL_KPI_TOP_Y, KPI_CARD_WIDTH, KPI_CARD_HEIGHT, spec.text)
    end

    --- Three-column group band ------------------------------------------
    local sessionPanel = createGroupPanel(frame, GROUP_PANEL_X[1], DETAIL_GROUP_TOP_Y,
        GROUP_PANEL_WIDTH, GROUP_PANEL_HEIGHT, "Session Timing", "session_timing_clock")
    frame.timingPanel = sessionPanel.panel
    frame.timingHeader = sessionPanel.heading
    frame.timingHeaderIcon = sessionPanel.icon
    frame.timingDivider = sessionPanel.divider
    -- Four stacked single-column rows (Session, Active, Status, Started),
    -- not a 2-column grid: the live client showed the old 2x2 layout
    -- crowding/colliding, and giving every row the panel's full content
    -- width is far more robust against real font-metric variance. All
    -- four rows share the same icon-gutter-aware x offset (even Session,
    -- which has no icon of its own) so labels stay column-aligned.
    frame.timing = addKeyedRow(sessionPanel.panel, {
        { "session", PANEL_COL_X_WITH_ICON, PANEL_ROW1_Y },
        { "active", PANEL_COL_X_WITH_ICON, PANEL_ROW2_Y },
        { "status", PANEL_COL_X_WITH_ICON, PANEL_ROW3_Y },
        { "started", PANEL_COL_X_WITH_ICON, PANEL_ROW4_Y },
    }, FONT_LABEL, FONT_BODY_VALUE)
    frame.timing.session.label:SetText("Session")
    frame.timing.active.label:SetText("Active")
    frame.timing.status.label:SetText("Status")
    frame.timing.started.label:SetText("Started")

    frame.timing.active.icon = createIcon(sessionPanel.panel, "active_hourglass",
        PANEL_SIDE_PADDING, PANEL_ROW2_Y, ROW_ICON_SIZE)
    frame.timing.status.icon = createIcon(sessionPanel.panel, "status_pulse",
        PANEL_SIDE_PADDING, PANEL_ROW3_Y, ROW_ICON_SIZE)
    frame.timing.started.icon = createIcon(sessionPanel.panel, "started_flag",
        PANEL_SIDE_PADDING, PANEL_ROW4_Y, ROW_ICON_SIZE)

    local characterPanel = createGroupPanel(frame, GROUP_PANEL_X[2], DETAIL_GROUP_TOP_Y,
        GROUP_PANEL_WIDTH, GROUP_PANEL_HEIGHT, "Character", "character_panel_helmet")
    frame.characterPanel = characterPanel.panel
    frame.characterHeader = characterPanel.heading
    frame.characterHeaderIcon = characterPanel.icon
    frame.characterDivider = characterPanel.divider
    -- Order per the approved layout: Level, XP, XP bar, Gold -- the bar
    -- sits directly under the XP row (it visually belongs to XP), and
    -- Gold is the last row, below the bar, not interleaved with it. All
    -- three rows share the same icon-gutter-aware x offset (even Level
    -- and XP, which have no icon of their own) so labels stay aligned.
    frame.character = addKeyedRow(characterPanel.panel, {
        { "level", PANEL_COL_X_WITH_ICON, PANEL_ROW1_Y },
        { "xp", PANEL_COL_X_WITH_ICON, PANEL_ROW2_Y },
        { "gold", PANEL_COL_X_WITH_ICON, CHARACTER_GOLD_Y },
    }, FONT_LABEL, FONT_BODY_VALUE)
    frame.character.level.label:SetText("Level")
    frame.character.xp.label:SetText("XP")
    frame.character.gold.label:SetText("Gold")
    frame.character.gold.icon = createIcon(characterPanel.panel, "gold_coin",
        PANEL_SIDE_PADDING, CHARACTER_GOLD_Y, ROW_ICON_SIZE)

    -- The XP bar lives only inside this panel (228 x 7), never spanning
    -- the full window width. Its own x-anchor is deliberately left at
    -- PANEL_COL_X (not shifted for the icon gutter): it's a standalone
    -- bar, not a labeled row, and its exact Y-spacing was independently
    -- validated by Reviewer G -- this round touches nothing about it.
    frame.character.xpBar = CreateFrame("StatusBar", nil, characterPanel.panel)
    frame.character.xpBar:SetSize(XPBAR_WIDTH, XPBAR_HEIGHT)
    frame.character.xpBar:SetPoint("TOPLEFT", characterPanel.panel, "TOPLEFT", PANEL_COL_X, XPBAR_Y)
    frame.character.xpBar:SetStatusBarTexture("Interface\\TargetingFrame\\UI-StatusBar")
    if frame.character.xpBar.SetStatusBarColor then
        frame.character.xpBar:SetStatusBarColor(XPBAR_FILL_COLOR[1], XPBAR_FILL_COLOR[2], XPBAR_FILL_COLOR[3], 1)
    end
    frame.character.xpBarBackground = frame.character.xpBar:CreateTexture(nil, "BACKGROUND")
    frame.character.xpBarBackground:SetAllPoints(frame.character.xpBar)
    if frame.character.xpBarBackground.SetColorTexture then
        frame.character.xpBarBackground:SetColorTexture(XPBAR_TRACK_COLOR[1], XPBAR_TRACK_COLOR[2],
            XPBAR_TRACK_COLOR[3], XPBAR_TRACK_COLOR[4])
    end

    local ratesPanel = createGroupPanel(frame, GROUP_PANEL_X[3], DETAIL_GROUP_TOP_Y,
        GROUP_PANEL_WIDTH, GROUP_PANEL_HEIGHT, "Rates")
    frame.ratesPanel = ratesPanel.panel
    frame.ratesHeader = ratesPanel.heading
    frame.ratesDivider = ratesPanel.divider
    frame.rates = addKeyedRow(ratesPanel.panel, {
        { "earnedPerHour", PANEL_COL_X, PANEL_ROW1_Y },
        { "spentPerHour", PANEL_COL_X, PANEL_ROW2_Y },
        { "netPerHour", PANEL_COL_X, PANEL_ROW3_Y },
    }, FONT_LABEL, FONT_BODY_VALUE)
    frame.rates.earnedPerHour.label:SetText("Earned/hr")
    frame.rates.spentPerHour.label:SetText("Spent/hr")
    frame.rates.netPerHour.label:SetText("Net/hr")

    --- Recent Sessions band ----------------------------------------------
    frame.historyHeaderIcon = createIcon(frame, "recent_sessions_clock",
        DETAIL_MARGIN, DETAIL_HISTORY_TOP_Y, HEADER_ICON_SIZE)
    frame.historyHeader = addSectionHeader(frame, DETAIL_MARGIN + HEADER_ICON_SIZE + HEADER_ICON_GAP,
        DETAIL_HISTORY_TOP_Y, "Recent Sessions")

    -- A real, non-scrolling column-header row: labels sit at the exact
    -- same x offsets/widths as each data row's own columns below, so
    -- values genuinely line up under a heading -- a real table, not a
    -- single bullet-joined line, which the live client reported reading
    -- as cramped/collapsed.
    frame.historyColumnHeaders = {}
    for i, label in ipairs(HISTORY_COL_LABELS) do
        local header = frame:CreateFontString(nil, "ARTWORK", FONT_LABEL)
        header:SetPoint("TOPLEFT", frame, "TOPLEFT", DETAIL_MARGIN + HISTORY_COL_X[i], HISTORY_COLUMN_HEADER_Y)
        header:SetWidth(HISTORY_COL_WIDTH[i])
        header:SetJustifyH("LEFT")
        header:SetText(label)
        setSingleLine(header)
        frame.historyColumnHeaders[i] = header
    end

    local historyViewportWidth = DETAIL_WIDTH - 2 * DETAIL_MARGIN

    -- A plain, untemplated ScrollFrame -- deliberately NOT
    -- "UIPanelScrollFrameTemplate", whose auto-created scrollbar/arrow-
    -- button artwork was observed always visible in the live client even
    -- with zero or non-overflowing history, regardless of actual
    -- overflow. A plain ScrollFrame creates no such native child at all,
    -- so there is nothing to hide; scrolling is handled by this addon's
    -- own mouse-wheel handler below, and the pre-existing geometry-based
    -- overflow indicator (shown/hidden purely from real content vs.
    -- viewport height) is the only "more below" affordance.
    frame.historyScroll = CreateFrame("ScrollFrame", nil, frame)
    frame.historyScroll:SetPoint("TOPLEFT", frame, "TOPLEFT", DETAIL_MARGIN, HISTORY_VIEWPORT_Y)
    frame.historyScroll:SetSize(historyViewportWidth, HISTORY_VIEWPORT_HEIGHT)
    frame.historyScroll:EnableMouseWheel(true)

    frame.historyContent = CreateFrame("Frame", nil, frame.historyScroll)
    frame.historyContent:SetPoint("TOPLEFT", frame.historyScroll, "TOPLEFT", 0, 0)
    frame.historyContent:SetSize(historyViewportWidth, HISTORY_RECORD_HEIGHT) -- grows with row content on refresh
    if frame.historyScroll.SetScrollChild then
        frame.historyScroll:SetScrollChild(frame.historyContent)
    end
    frame.historyRows = {}
    -- Cached on every refresh so the wheel handler below can clamp
    -- scrolling from real, already-computed geometry instead of a
    -- possibly-unavailable GetVerticalScrollRange API.
    frame.historyContentHeight = HISTORY_RECORD_HEIGHT
    frame.historyViewportHeight = HISTORY_VIEWPORT_HEIGHT

    frame.historyScroll:SetScript("OnMouseWheel", function(scrollFrame, delta)
        if not (scrollFrame.SetVerticalScroll and scrollFrame.GetVerticalScroll) then return end
        local maxScroll = math.max(0, (frame.historyContentHeight or 0) - (frame.historyViewportHeight or 0))
        local current = scrollFrame:GetVerticalScroll() or 0
        local newScroll = current - delta * HISTORY_SCROLL_STEP
        if newScroll < 0 then newScroll = 0 end
        if newScroll > maxScroll then newScroll = maxScroll end
        scrollFrame:SetVerticalScroll(newScroll)
    end)

    -- Shown only when there is nothing retained yet, centered in the
    -- viewport -- an empty scrollable panel with no explanation reads as
    -- broken, not "nothing happened yet."
    frame.historyEmptyText = frame.historyScroll:CreateFontString(nil, "ARTWORK", FONT_MUTED_SMALL)
    frame.historyEmptyText:SetPoint("CENTER", frame.historyScroll, "CENTER", 0, 0)
    frame.historyEmptyText:SetText("No completed sessions yet.")
    frame.historyEmptyText:Hide()

    -- A minimal, self-built overflow indicator: shown/hidden purely from
    -- contentHeight vs. viewport height, computed in
    -- RefreshSessionHistoryRows from real GetHeight()/GetWidth() geometry
    -- -- this is the "recognizable scroll affordance" the live scrollbar
    -- fix requires, without any native scrollbar artifact.
    frame.historyOverflowIndicator = frame:CreateTexture(nil, "OVERLAY")
    frame.historyOverflowIndicator:SetPoint("TOPRIGHT", frame.historyScroll, "TOPRIGHT", 2, 0)
    frame.historyOverflowIndicator:SetSize(4, HISTORY_VIEWPORT_HEIGHT)
    if frame.historyOverflowIndicator.SetColorTexture then
        frame.historyOverflowIndicator:SetColorTexture(0.55, 0.45, 0.18, 0.6)
    end
    frame.historyOverflowIndicator:Hide()

    --- Action bar -----------------------------------------------------------
    -- Reset gets extra horizontal clearance from its neighbors (still the
    -- same plain button template/color as the rest -- never bright red)
    -- so it doesn't visually blend in with the non-destructive controls.
    local buttons = {
        { key = "pauseButton", text = "Pause", handler = function()
            FDB:PauseSession()
            FDB:RefreshSessionDetailWindow()
        end },
        { key = "resumeButton", text = "Resume", handler = function()
            FDB:ResumeSession()
            FDB:RefreshSessionDetailWindow()
        end },
        { key = "resetButton", text = "Reset", extraGapBefore = true, handler = function()
            FDB:ShowSessionResetConfirmation()
        end },
        { key = "lockButton", text = "Lock HUD", extraGapBefore = true, handler = function()
            FDB:ToggleSessionHUDLock()
            FDB:RefreshSessionDetailWindow()
        end },
        { key = "hudButton", text = "Hide HUD", handler = function()
            FDB:ToggleSessionHUD()
            FDB:RefreshSessionDetailWindow()
        end },
    }

    local totalButtonsWidth = (#buttons * BUTTON_WIDTH) + ((#buttons - 1) * BUTTON_GAP)
    for _, spec in ipairs(buttons) do
        if spec.extraGapBefore then totalButtonsWidth = totalButtonsWidth + BUTTON_SEPARATOR_GAP end
    end
    local x = (DETAIL_WIDTH - totalButtonsWidth) / 2
    for index, spec in ipairs(buttons) do
        if index > 1 then
            x = x + BUTTON_GAP
            if spec.extraGapBefore then x = x + BUTTON_SEPARATOR_GAP end
        end
        local button = CreateFrame("Button", nil, frame, "UIPanelButtonTemplate")
        button:SetSize(BUTTON_WIDTH, BUTTON_HEIGHT)
        button:SetPoint("TOPLEFT", frame, "TOPLEFT", x, BUTTON_ROW_Y)
        button:SetText(spec.text)
        button:SetScript("OnClick", spec.handler)
        frame[spec.key] = button
        x = x + BUTTON_WIDTH
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

    if count == 0 then
        frame.historyEmptyText:Show()
    else
        frame.historyEmptyText:Hide()
    end

    local y = 0
    for index = 1, count do
        -- GetSessionHistory() returns storage order (oldest-appended-
        -- first -- an internal detail the eviction logic relies on,
        -- `table.remove(char.history, 1)` evicts the oldest). Newest
        -- session must render at row 1 regardless, so read from the
        -- reversed position.
        local record = history[count - index + 1]

        local row = frame.historyRows[index]
        if not row then
            local background = frame.historyContent:CreateTexture(nil, "BACKGROUND")

            -- Real per-field columns, anchored at the exact same x offsets
            -- as the column-header row above, instead of one bullet-joined
            -- string whose field boundaries shifted with preceding text
            -- length.
            local columns = {}
            for i = 1, #HISTORY_COL_X do
                local column = frame.historyContent:CreateFontString(nil, "ARTWORK", FONT_BODY_VALUE)
                column:SetWidth(HISTORY_COL_WIDTH[i])
                column:SetJustifyH("LEFT")
                setSingleLine(column)
                columns[i] = column
            end

            local secondary = frame.historyContent:CreateFontString(nil, "ARTWORK", FONT_MUTED_SMALL)
            secondary:SetWidth(rowWidth)
            secondary:SetJustifyH("LEFT")
            setSingleLine(secondary)

            row = { columns = columns, secondary = secondary, background = background }
            frame.historyRows[index] = row
        end

        -- Level range is only meaningful across an actual level-up within
        -- the session; a same-level short session omits it entirely
        -- rather than showing a redundant "Lvl 12->12". Net Gold (primary
        -- column 5, derived as goldEarned - goldSpent by the tracker) is
        -- the ONLY gold metric Recent Sessions ever shows -- goldEarned
        -- and goldSpent are never rendered anywhere in this view, so the
        -- secondary line's only possible content is the level transition.
        local levelChanged = record.startLevel ~= nil and record.endLevel ~= nil
            and record.startLevel ~= record.endLevel
        local hasSecondary = levelChanged
        local rowHeight = hasSecondary and HISTORY_RECORD_HEIGHT or HISTORY_RECORD_HEIGHT_COLLAPSED

        -- Alternating tint by visible position (newest = row 1 = odd =
        -- transparent), not by any property of the record itself.
        row.background:ClearAllPoints()
        row.background:SetPoint("TOPLEFT", frame.historyContent, "TOPLEFT", 0, -y)
        row.background:SetSize(rowWidth, rowHeight)
        if index % 2 == 0 then
            if row.background.SetColorTexture then
                row.background:SetColorTexture(HISTORY_ROW_EVEN_TINT[1], HISTORY_ROW_EVEN_TINT[2],
                    HISTORY_ROW_EVEN_TINT[3], HISTORY_ROW_EVEN_TINT[4])
            end
            row.background:Show()
        else
            row.background:Hide()
        end

        -- Primary line: five real columns (Date & Time, Duration, XP
        -- Gained, XP/hr, Net Gold), each its own FontString anchored at a
        -- fixed x offset matching the column-header row above -- a genuine
        -- table, not one bullet-joined string. Net gold is the only
        -- colored column (green/red).
        local netGoldColor = netColor(record.netGold)
        local primaryValues = {
            formatTimestamp(record.endedAt or record.startedAt),
            formatHMS(record.trackedSeconds),
            "+" .. formatCompactNumber(record.xpGained),
            formatCompactNumber(record.xpPerHour) .. "/hr",
            formatCopperShort(record.netGold),
        }
        for i, column in ipairs(row.columns) do
            column:ClearAllPoints()
            column:SetPoint("TOPLEFT", frame.historyContent, "TOPLEFT", HISTORY_COL_X[i], -y)
            column:SetText(primaryValues[i])
            column:Show()
        end
        row.columns[5]:SetTextColor(netGoldColor[1], netGoldColor[2], netGoldColor[3])

        -- Secondary line: level transition only, never a gold breakdown.
        -- If there was no level-up, the line is hidden and the row
        -- collapses to a single compact line instead of showing an empty
        -- second line.
        if hasSecondary then
            row.secondary:ClearAllPoints()
            row.secondary:SetPoint("TOPLEFT", row.columns[1], "BOTTOMLEFT", 0, -HISTORY_LINE_GAP)
            row.secondary:SetText("Lvl " .. tostring(record.startLevel) .. "->" .. tostring(record.endLevel))
            row.secondary:Show()
        else
            row.secondary:Hide()
        end

        y = y + rowHeight
    end

    for index = count + 1, #frame.historyRows do
        for _, column in ipairs(frame.historyRows[index].columns) do
            column:Hide()
        end
        frame.historyRows[index].secondary:Hide()
        frame.historyRows[index].background:Hide()
    end

    -- The scroll child's height must track the actual (variable, since
    -- rows can collapse) total row height so retained records can
    -- genuinely scroll past a fixed-height viewport instead of being
    -- clipped or overlapping.
    local contentHeight = math.max(y, 1)
    frame.historyContent:SetSize(rowWidth, contentHeight)

    -- The overflow indicator (and the wheel-scroll clamp) are computed
    -- from real geometry rather than assumed from record count, so they
    -- stay correct if the viewport height constant ever changes.
    local viewportHeight = (frame.historyScroll.GetHeight and frame.historyScroll:GetHeight()) or HISTORY_VIEWPORT_HEIGHT
    if viewportHeight <= 0 then viewportHeight = HISTORY_VIEWPORT_HEIGHT end
    frame.historyContentHeight = contentHeight
    frame.historyViewportHeight = viewportHeight

    if contentHeight > viewportHeight then
        frame.historyOverflowIndicator:Show()
    else
        frame.historyOverflowIndicator:Hide()
    end

    -- Clamp any existing scroll position if the content shrank (e.g. a
    -- reset cleared rows below the current scroll offset).
    if frame.historyScroll.GetVerticalScroll and frame.historyScroll.SetVerticalScroll then
        local maxScroll = math.max(0, contentHeight - viewportHeight)
        local current = frame.historyScroll:GetVerticalScroll() or 0
        if current > maxScroll then
            frame.historyScroll:SetVerticalScroll(maxScroll)
        end
    end
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
    local statusColorValue = statusColor(snapshot.status)
    frame.timing.status.value:SetTextColor(statusColorValue[1], statusColorValue[2], statusColorValue[3])
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
