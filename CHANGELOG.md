# Changelog

ForeverDB versions the **Addon** and **Companion** independently. The current
version contract and release checklist are documented in
[docs/VERSIONING.md](docs/VERSIONING.md).

## Current versions

- Addon: **0.3.3-alpha**
- Export schema: **8**
- Companion: **0.7.1-alpha**

# Companion

## 0.7.1-alpha — 2026-09-25

- Fixed selected DataGrid rows becoming unreadable after focus moved to the map.
- Made the map header controls wrap responsively instead of clipping the zoom/status area.
- Replaced raw acquisition keys such as `fishing_pool` with user-facing location labels.

## 0.7.0-alpha — 2026-09-25

- Added multi-zone location browsing: selecting a location row changes the active map.
- Preserved all zones associated with a detail result.
- Reset stale navigation history when starting from a new Search result.
- Improved fishing-pool labeling and hid synthetic pool IDs from normal UI.
- Added background map pre-warming after successful sync.
- Kept map resolution cache-first and concurrent resolutions deduplicated.

## 0.6.9-alpha — 2026-09-25

- Pinned and built a current upstream CascLib native runtime during Windows publish.
- Replaced the older native DLL bundled by the managed package.
- Updated resolver/cache generation for the current native runtime.
- Added CMake compatibility/build fixes required by the pinned CascLib commit.

## 0.6.8-alpha — 2026-09-25

- Corrected CascLib online product parameter handling.
- Added CDN-open diagnostics for map resolver failures.

## 0.6.7-alpha — 2026-09-25

- Corrected local CASC product-selection syntax.

## 0.6.6-alpha — 2026-09-24

- Added exact installed-build Blizzard CDN fallback for streamed/missing map tiles.
- Preferred exact local FileDataIDs before remote fallback.
- Deduplicated concurrent map resolutions.

## 0.6.5-alpha — 2026-09-24

- Added sanitized map-resolution diagnostics uploaded to Supabase.
- Added safe installed build/product metadata to resolver diagnostics.

## 0.6.4-alpha — 2026-09-24

- Added persistent map-resolution cache.
- Cached both successful and failed resolution attempts.
- Added per-map cache reset/manual retry.
- Remembered the preferred WoW CASC product across runs.

## 0.6.3-alpha — 2026-09-24

- Added installed-product discovery.
- Added classic world-map texture path fallback.

## 0.6.2-alpha — 2026-09-24

- Added individual CASC product probing.
- Fixed selection of the Forever `wow_classic_beta` product using map-tile probes.

## 0.6.1-alpha — 2026-09-24

- Fixed BLP1 JPEG and BLP2 map decoding.
- Added map tile open/decode diagnostics.

## 0.6.0-alpha — 2026-09-24

- Added interactive WoW map preview.
- Added local CASC map extraction and BLP tile stitching.
- Added markers, weighted clusters and heatmaps.
- Added zoom, pan and Fit controls.

## 0.5.0-alpha — 2026-09-24

- Added Back/Forward/breadcrumb detail navigation.
- Added fishing-pool and disenchant acquisition handling.
- Added map-art metadata persistence/export/parsing.
- Added per-user installer workflow.
- Expanded location-backed details for gathering sources.

## 0.4.0-alpha — 2026-09-24

- Added aggregated location API integration and location map preview.
- Added confidence/sample context to detail views.
- Completed dark window chrome and detail navigation improvements.

## 0.3.0-alpha — 2026-09-24

- Added single-instance/tray restore behavior.
- Added dark/gold Companion redesign.
- Established the search/detail UI baseline.

# Addon

## 0.3.3-alpha — 2026-09-25

- Fixed a Forever 1.60.1 Secret Value crash in the fishing-pool tooltip tracker.
- Fishing-pool tooltip text is now checked with `issecretvalue()` before comparison or string operations.
- When the tooltip name is secret but a real GameObject GUID is readable, ForeverDB keeps a short-lived generic Fishing Pool candidate instead of touching the restricted text.
- Restricted-name candidates expire after 2 seconds to reduce false-positive pool attribution.
- Export schema remains **8**.

## 0.3.2-alpha — 2026-09-25

- Added the non-persistent `/fdb guildapi` Guildbook capability probe.
- Reports availability of guild roster, profession and guild-recipe APIs.
- Samples the current character's professions and cached/refreshed guild roster without storing or uploading guild data.
- Requests a guild roster refresh and listens for `GUILD_ROSTER_UPDATE` with a timeout fallback.
- Export schema remains **8** because the probe does not change SavedVariables/export data.

## 0.3.1-alpha — 2026-09-24

- Added/exported map-art metadata required by the Companion map pipeline.
- Expanded gathering, fishing-pool and disenchant tracking.
- Preserved source level and location metadata across the new collector paths.
- Refreshed map metadata for current Forever client builds.

## 0.2.7 — 2026-09-24

- Added zone, subzone and map-coordinate observations.
- Added level-aware creature statistics and zone-separated fishing introduced in
  the preceding 0.2.x collector work.

## 0.1.1 — 2026-09-24

- Early collector stabilization after the initial repository/addon bootstrap.

## Initial alpha — 2026-09-24

- Added the initial ForeverDB addon and observed-data model.
