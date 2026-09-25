# ForeverDB Roadmap

ForeverDB is developed in small, testable milestones. The roadmap is intentionally
ordered so that data correctness and local WoW-client compatibility stay ahead of
polish and distribution work.

## Current baseline

### Addon
- Version: 0.3.1-alpha
- Schema: 8
- Forever interface: 16001
- Observed pipelines:
  - mob loot
  - skinning
  - mining
  - fishing
  - fishing pools
  - chest / GameObject
- Experimental / pending E2E:
  - herbalism
  - disenchant

### Companion
- Version: 0.6.9-alpha
- Authenticated Supabase sync
- Item/source search and detail navigation
- Location tables
- Native Forever map rendering from local WoW CASC FileDataIDs
- Marker / cluster / heatmap overlays
- Persistent local map cache
- Sanitized map-resolution diagnostics

Map asset pipeline acceptance status:
- Tirisfal Glades: PASS, 12/12 tiles
- Silverpine Forest: PASS, 12/12 tiles
- Source: wow_classic_beta / FileDataID

## 0.7.0-alpha — Map UX & location intelligence

Goal: turn the working map renderer into a practical Gatherer/Wowhead-style
location browser.

- [ ] Selecting a location row switches the map to that row's zone.
- [ ] Preserve all zones for a detail result instead of silently showing only the
      highest-observation zone.
- [ ] Make the current map/zone selection obvious in the Locations UI.
- [ ] Improve marker tooltips with area, coordinates, acquisition kind and sample.
- [ ] Improve cluster tooltips with unique-node and observation counts.
- [ ] Reset breadcrumb/history when the user starts from a new search result.
- [ ] Hide synthetic fishing-pool IDs from normal UI.
- [ ] Label synthetic fishing-pool GameObjects as Fishing Pool instead of Object.
- [ ] Pre-warm map art for recently synced zones in the background.
- [ ] Keep first-load work deduplicated and all subsequent map loads cache-first.

Acceptance:
- one item/source may be browsed across multiple zones without reopening Search;
- selecting a different zone/location changes the map correctly;
- normal map revisit is effectively instant from cache;
- navigation breadcrumb contains only the active navigation chain.

## 0.7.x — Collector coverage closure

- [ ] Herbalism E2E test and fixes.
- [ ] Disenchant E2E test and fixes.
- [ ] Open-water fishing regression test.
- [ ] Chest/GameObject location regression test.
- [ ] Fishing-pool coordinate accuracy review and calibration.
- [ ] Validate map metadata across additional Eastern Kingdoms / Kalimdor zones.

## 0.8 — Companion hardening & distribution

- [ ] Settings polish and cache management.
- [ ] Sync-health/status panel.
- [ ] Diagnostic controls and retention policy.
- [ ] Installer validation.
- [ ] Startup/tray behavior final pass.
- [ ] Code-signing plan.
- [ ] Auto-update design.
- [ ] Retire obsolete shared-token sync tooling.
- [ ] Remove/restrict legacy public stats view after compatibility validation.

## 0.9 — Farming intelligence

- [ ] “Where should I farm this?” view.
- [ ] Combine observed rate, sample quality and location density.
- [ ] Per-zone source comparison without arbitrary winner labels.
- [ ] Route-friendly node density summaries.
- [ ] Source/location filters by acquisition type.
- [ ] Data-quality/confidence visualization.

## 1.0 readiness

- [ ] Stable addon data contract.
- [ ] Stable Companion local cache format or migration path.
- [ ] Full supported collector E2E matrix.
- [ ] Security/advisor review with no critical findings.
- [ ] Signed installer/update story.
- [ ] Recovery behavior for malformed SavedVariables, auth failures and stale builds.
- [ ] User-facing privacy/data collection documentation.

## Engineering rules

1. The addon never performs HTTP.
2. Blizzard/WoW artwork is read from the user's own client and cached locally;
   ForeverDB does not redistribute map textures through Supabase.
3. Supabase stores observations/statistics/metadata, not copyrighted client art.
4. New map/resolver behavior must keep structured diagnostics until the pipeline is
   considered stable.
5. Failed expensive work should be cached or deduplicated so normal UI navigation
   never repeatedly scans CASC.
6. Every collector type must pass an end-to-end addon -> SavedVariables ->
   Companion -> Supabase -> search/details verification before being called done.
