# ForeverDB Roadmap

ForeverDB is developed in small, testable milestones. The roadmap is intentionally
ordered so that data correctness and WoW-client compatibility stay ahead of
polish and distribution work.

## Current baseline

### Addon
- Version: **0.5.0-alpha**
- Schema: **9**
- Forever interface: **16001**
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
- In-game Session Tracker (XP/hour, gold, active-time rates, compact HUD,
  detailed window): repo-complete; live Forever acceptance PENDING.

### Companion
- Version: **0.8.2-alpha**
- Authenticated Supabase sync
- Item/source search and detail navigation
- Multi-zone location browsing
- Native Forever map rendering from WoW CASC FileDataIDs
- Local-first CASC with exact-build Blizzard CDN fallback for streamed tiles
- Marker / cluster / heatmap overlays
- Persistent map metadata, resolution and PNG caches
- Sanitized map-resolution diagnostics
- Background map pre-warming for recently synced zones

Map asset pipeline acceptance status:
- Tirisfal Glades: PASS, 12/12 tiles
- Silverpine Forest: PASS, 12/12 tiles
- Validated product/source: `wow_classic_beta` / FileDataID

## 0.5.0-alpha — Session Tracker

Implementation status: **external review round 2 fixes applied and
repo-side re-verified; pending a fresh independent (Reviewer C) pass
before repo-complete is reconfirmed. Live Forever-client acceptance
PENDING regardless.** See the acceptance ledger's "Review round 2" and
"Verification snapshot" sections.

Goal: give players useful in-game leveling/farming feedback (XP/hour, time
to level, gold earned/spent/net, active-time-based rates) without requiring
the Companion, addon-only for V1.

- [x] Per-character session lifecycle: automatic start/resume, configurable
      offline timeout (default 60m), reload/relog re-baselining without
      backfill.
- [x] Manual pause/resume/reset; reset requires confirmation from both the
      detailed window and `/fdb session reset`.
- [x] XP accounting resilient to `PLAYER_XP_UPDATE`/`PLAYER_LEVEL_UP`
      event-order variance, with the canonical level-up wrap formula.
- [x] Integer-copper gold accounting (earned/spent/net) from `GetMoney()`.
- [x] Active-time-based rates with a configurable inactivity cutoff
      (default 5m); active time never backfills an idle gap.
- [x] Up to 30 retained completed sessions per character; short/empty
      sessions discarded.
- [x] Compact WoW-native HUD (movable, lockable, position/visibility
      persisted per character) and a detailed `/fdb session` window with
      KPI/timing/character/rates/history panels.
- [x] `/fdb session [pause|resume|reset|hud|lock|timeout <min>|idle <min>]`,
      calling the same tracker/UI APIs as their button equivalents.
- [x] Session state is local-only (`ForeverDB_Saved.sessions`); export
      schema remains **9** and `ForeverDB_Export` carries no session data.
- [x] Simulated Lua smoke coverage (`tests/session_tracker_smoke.lua`,
      `tests/session_ui_smoke.lua`) and CI compile/test steps.
- [ ] Live Forever client acceptance — **PENDING**, see the checklist in
      the acceptance ledger below.

Repo-side verification and the live-acceptance checklist:
[0.5 Session Tracker acceptance](0.5-session-tracker-acceptance.md).

## 0.7.0-alpha — Map UX & location intelligence

Implementation status: **complete; current-build runtime acceptance in progress.**

Goal: turn the working map renderer into a practical Gatherer/Wowhead-style
location browser.

- [x] Selecting a location row switches the map to that row's zone.
- [x] Preserve all zones for a detail result instead of silently showing only the
      highest-observation zone.
- [x] Make the current map/zone selection obvious in the Locations UI.
- [x] Improve marker tooltips with area, coordinates, acquisition kind and sample.
- [x] Improve cluster tooltips with unique-node and observation counts.
- [x] Reset breadcrumb/history when the user starts from a new search result.
- [x] Hide synthetic fishing-pool IDs from normal UI.
- [x] Label synthetic fishing-pool GameObjects as Fishing Pool instead of Object.
- [x] Pre-warm map art for recently synced zones in the background.
- [x] Keep first-load work deduplicated and all subsequent map loads cache-first.

Acceptance:
- one item/source may be browsed across multiple zones without reopening Search;
- selecting a different zone/location changes the map correctly;
- normal map revisit is effectively instant from cache;
- navigation breadcrumb contains only the active navigation chain.

Current acceptance procedure: [0.7 acceptance test](0.7-acceptance-test.md).

### 0.7.1-alpha — UI polish

- [x] Keep selected DataGrid rows readable after keyboard focus moves to the map.
- [x] Prevent map toolbar / zoom text clipping at narrower widths.
- [x] Replace raw location acquisition keys with user-facing labels.

## 0.7.x — Collector coverage closure

- [x] Herbalism / Disenchant repo-side acceptance preparation: tracker review,
      debug breadcrumbs and simulated Lua contract checks.
- [ ] Herbalism E2E test and fixes — **PENDING live client evidence**.
- [ ] Disenchant E2E test and fixes — **PENDING live client evidence**.
- [ ] Open-water fishing regression test.
- [ ] Chest/GameObject location regression test.
- [ ] Fishing-pool coordinate accuracy review and calibration.
- [ ] Validate map metadata across additional Eastern Kingdoms / Kalimdor zones.

Procedure and evidence ledger: [beta collector acceptance](BETA_TEST_PLAN.md#07x-herbalism--disenchant-collector-acceptance).
Repo preparation is not E2E acceptance: both collectors still require real
addon -> SavedVariables -> Companion -> Supabase -> search/details evidence.

## 0.8.0-alpha — Guildbook V1

Implementation status: **complete; runtime acceptance PASS.**

- [x] Schema 9 addon Guildbook collector.
- [x] Roster capture with name, GUID, class, level, rank, online state, zone and last-online age.
- [x] Guild-visible primary profession capture.
- [x] Current-character secondary profession capture.
- [x] Export/parser model for Guildbook records.
- [x] Private Supabase per-installation Guildbook tables and authenticated ingest.
- [x] Companion Guildbook tab with filtering.
- [x] Recipe/crafter lookup explicitly deferred because the current Forever build is runtime-limited.

Acceptance: **PASS** — see [0.8 Guildbook acceptance](0.8-guildbook-acceptance.md).

Validated runtime snapshot: 1 guild, 12 members, 4 online, 9 profession rows.

### 0.8.1-alpha — Guildbook polish

- [x] Dark-theme guild/profession ComboBoxes.
- [x] Filter placeholder text.
- [x] Online-only toggle.
- [x] Profession-specific filter.
- [x] WoW class colors in the roster.
- [x] Wrapped profession chips for denser/readable display.
- [x] Addon Guildbook refresh every 30 minutes while logged in.
- [x] Companion status explains the difference between in-client refresh and SavedVariables/Supabase persistence.

### 0.8.2-alpha — Guildbook visual polish

Implementation status: **implemented; build/runtime UI verification pending.**

- [x] Increase Guildbook roster row/header spacing for large displays.
- [x] Add compact Members / Online / Offline / 30m refresh summary cards.
- [x] Preserve visible/total counts while filters are active.
- [x] Increase primary vs secondary profession chip contrast.

## 0.8 — Companion hardening & distribution

- [ ] Settings polish and cache management.
- [ ] Sync-health/status panel.
- [ ] Diagnostic controls and retention policy.
- [ ] Installer validation.
- [ ] Startup/tray behavior final pass.
- [ ] Code-signing plan.
- [ ] Auto-update design.
- [ ] Remove obsolete legacy sync scripts/config after compatibility cleanup.
- [ ] Remove/restrict legacy public stats view after compatibility validation.

## Future — Guildbook

Research note: [Guildbook API options](GUILDBOOK-API.md)

- [x] Runtime capability probe for Forever guild roster/profession APIs (`/fdb guildapi`) — function availability + own-character professions PASS.
- [x] Guilded-character roster/member profession acceptance — PASS (expanded member rows returned).
- [x] Targeted guild recipe-query acceptance completed — current Forever build is RUNTIME LIMITED for guild recipe/crafter lookup; defer to a later compatibility pass.
- [x] Guild roster SavedVariables contract — schema 9.
- [x] Character + profession model and private per-installation Supabase storage.
- [x] Companion Guildbook tab with guild selector, filter, roster/status/profession columns.
- [ ] Optional Battle.net enrichment if Forever realm/profile support is verified.

## 0.9 — Farming intelligence

- [ ] “Where should I farm this?” view.
- [ ] Combine observed rate, sample quality and location density.
- [ ] Per-zone source comparison.
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
2. Blizzard/WoW artwork is resolved from the user's exact WoW build. Local CASC is
   preferred; streamed files may be fetched from Blizzard's CDN and cached locally.
   ForeverDB does not redistribute map textures through Supabase.
3. Supabase stores observations/statistics/metadata, not copyrighted client art.
4. New map/resolver behavior must keep structured diagnostics until the pipeline is
   considered stable.
5. Failed expensive work should be cached or deduplicated so normal UI navigation
   never repeatedly scans CASC.
6. Every collector type must pass an end-to-end addon -> SavedVariables ->
   Companion -> Supabase -> search/details verification before being called done.
