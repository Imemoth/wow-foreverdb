# Arcane Cartography — Phase 2-A architecture notes

Scope: the decorative "Arcane Cartography" treatment added to `/zones`, `/zone/[id]` and
`/database` (banners + `LocationPlot` styling), plus the Tirisfal Glades first-map prototype.
This covers P2-A only. P2-B (Guides/Arcane Library) and P2-C (Addon/Companion) are not
implemented and are out of scope for this document beyond the brief architecture notes below.

## Three-layer map architecture

| Layer | Purpose | Status in P2-A |
| --- | --- | --- |
| 1. Arcane Survey background | Neutral, original decorative chrome. Carries no geographic claim about any real zone. | **Implemented.** `ArcaneSurveyBanner.tsx` (page headers) and `LocationPlot.tsx`'s own background/border/corner-tick styling. |
| 2. Calibrated geographic background | A real, to-scale zone map image behind the observation markers, so marker position visually corresponds to an actual place in the zone. | **Not implemented.** See "Why no calibrated map ships" below. |
| 3. Observation overlay | The existing aggregated, privacy-thresholded marker/legend/text-summary system. | **Preserved unchanged.** See "What was and wasn't touched" below. |

### Why no calibrated map ships (Layer 2)

`docs/web/maps-and-assets.md`'s existing V1 decision already establishes the applicable
constraint: Blizzard's own zone map textures (`MapArtID` BLP tiles, resolved client-side by
the Companion/CASC) are Blizzard property with **no redistribution licence**, and are
explicitly marked "Not used. Do not host, proxy or hotlink." The only third-party asset
reviewed for maps, the `FullRevealOverlays-70009.json` numeric atlas, is MIT-licensed but
only describes *coordinates into* Blizzard's own textures — it grants no rights to any
image, so it cannot supply calibration *and* a lawful backing image at once.

No original, project-drawn, to-scale replacement zone map exists for Tirisfal Glades (or any
other zone), and none was supplied or approved by the owner for this round. Per the task's
explicit instruction, shipping a geographic-map background requires documented provenance,
rights, and verified coordinate calibration/alignment *before* any such asset ships — none of
that evidence exists today, so Layer 2 is correctly left unimplemented rather than
approximated.

**Verdict: MAP ALIGNMENT VERIFIED — NOT APPLICABLE.** No geographic-map calibration is
claimed or verified in this round. What ships is the neutral Arcane Survey background
(Layer 1) plus the unchanged observation overlay (Layer 3); `LocationPlot`'s coordinate
system was never touched by this round's styling changes (see below), so there is nothing to
misalign.

### What a future Layer 2 would need

1. An image the project has clear rights to use (original hand-drawn zone art, a
   compatibly-licensed community map with recorded attribution, or explicit written
   permission from a rights holder) — recorded in `docs/web/maps-and-assets.md` alongside
   the existing asset table, with hash/version pinned.
2. A documented coordinate transform from that image's own pixel/percent space to the
   `LocationPlot` `0–100` percent grid (the same space `pub.locations` already uses),
   verified against known reference points in the zone (e.g. a flight path node, a capital
   city gate) before any marker is drawn on top of it.
3. A visual alignment check (markers plotted over the new background vs. the same markers on
   the current neutral grid) captured as a screenshot pair, reviewed and approved before
   shipping to any zone beyond a single prototype.
4. The same privacy thresholds and aggregation this round preserved (1% grid cells, hidden
   sub-2-observation cells) continue to apply — a sharper background image must not imply
   more location precision than is actually authorized.

### Tirisfal Glades prototype

Tirisfal Glades was the nominated first-map zone for this phase. Since no calibrated
background exists (see above), its `/zone/[id]` page and `LocationPlot` render exactly the
same Layer 1 + Layer 3 treatment as every other zone — there is no zone-specific map asset or
code path. "Prototype" in this round means: this is the zone the owner should review first to
approve (or redirect) the overall Arcane Survey direction before it is considered final for
all zones; it does not mean a unique calibrated map was built for it.

### Feasibility note: Mulgore, Durotar, Silverpine Forest

Same blocker as above applies identically: no licensed, calibrated map source exists for any
of these zones. Extending Layer 1 (the neutral decorative treatment) to them requires no new
work — it is already zone-agnostic. Extending to Layer 2 for any of them is blocked on the
same prerequisite (rights + calibration evidence), not on anything zone-specific.

## What was and wasn't touched

**Touched (styling/markup only, paint order *before* markers):**
- New `ArcaneSurveyBanner.tsx` / `CartographyBanner.tsx` components (page-header chrome only;
  not rendered inside `LocationPlot`'s own `<svg>`).
- `LocationPlot.tsx`: added a radial glow `<rect>`, gold-tinted corner ticks, and a
  gold-tinted border/grid stroke — all painted before the data markers, inside the same
  `<svg>` element tree, using the existing `viewBox="-2 -2 104 104"` unchanged.
- `/zones` and `/zone/[id]` page headers and section structure (headings, wrapper markup).
- `/database` page header (compact banner only).

**Never touched:**
- `p.x` / `p.y` coordinate values, marker radius formula, `KIND_FILL` colors, or the SVG
  `viewBox`.
- Observation aggregation, 1% grid quantization, the sub-2-observation hide threshold, or any
  confidence/sample-quality calculation (all live outside this component, in the data layer).
- The zone/entity search, filter, sort, pagination, or entity-link behavior on `/zone/[id]`.
- The "Densest cells" accessible text-summary list.

Because the enhancement is confined to elements painted strictly before the markers in the
same SVG, and the coordinate-bearing props (`points`, `mapId`, `zoneName`) and their
consumers are unchanged, marker position cannot have been affected by this change.

## Artwork provenance

All new visual assets in this round (`ArcaneSurveyBanner.tsx`'s compass medallion, survey
arcs, and scattered points; the `LocationPlot` corner-tick and glow accents) are original,
hand-written inline SVG — no raster images, no third-party assets, no Blizzard-derived
imagery. They reuse the same illustration color palette already established in
`hero/themes.ts` (`#8B5CF6`, `#A78BFA`, `#D9B978`, `#E7C98A`, `#0D0F33`, `#07091C`) and the
same "hardcoded hex as SVG presentation attributes" technique used throughout the existing
hero art, consistent with `docs/web/maps-and-assets.md`'s existing asset table (no new row is
needed; these are additional instances of the already-documented "ForeverDB logo, category
glyphs, location plots: Original SVG... Project-owned" entry).

## Deferred: clustering, heatmap, zoom/pan, filters (architecture note only)

Not implemented this round; investigated at the architecture level only, per the task's
explicit request for "architecture only, not full implementation":

- **Clustering/heatmap**: `pub.locations` already carries per-cell `observations` counts, so a
  density heatmap is a presentation change over existing data (no new aggregation query) —
  likely a `<radialGradient>`-per-cell or canvas/WebGL density layer swapped in for the plain
  `<circle>` markers above some zone size/cell-count threshold.
- **Zoom/pan**: would need either a CSS-transform viewBox manipulation (cheap, works with the
  existing pure-SVG markers) or a dedicated library; the existing text-summary fallback
  ("Densest cells") should remain the non-interactive accessible alternative regardless.
- **Filters** (by loot kind, e.g. show only Mining cells): straightforward client-side toggle
  over the already-rendered `points` array grouped by `lootKind`, no data-layer change needed.

Each of the above is a separately-scoped, separately-estimated follow-up; none is started in
P2-A.
