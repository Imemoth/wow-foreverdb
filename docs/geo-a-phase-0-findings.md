# Geo A — Phase 0 attribution findings

**Scope:** static inspection of the addon collectors and simulated local Lua fixtures. This is not live `wowf` runtime evidence. No observation data or diagnostics were uploaded. The local workspace did not contain the WoW Forever executable or its API runtime.

## Evidence matrix

| Collector | Evidence present in addon | Location currently recorded | Source-map attribution | Phase 0 status |
| --- | --- | --- | --- | --- |
| Creature loot | `GetLootSourceInfo()` yields the loot source GUID; the addon resolves creature identity. | Player map and player position captured around the loot interaction. | No source-map API/result is used by the collector. Whether `wowf` can resolve a target/source GUID to its own map position remains unverified. | Source identity verified by code path; source map unsupported by current collector; live behavior unknown. Keep Unknown. |
| Skinning | Skinning spell flow captures `UnitGUID("target")` as creature identity. | Player map and player position at interaction time. | No creature map position is obtained. Target GUID is not evidence that the player coordinate is the creature coordinate. | Source identity verified by code path; source map unsupported by current collector; live behavior unknown. Keep Unknown. |
| Herbalism | Gathering spell IDs identify the collector type; `UnitGUID("npc")` can supply a gameobject GUID. | Player map/position stored as a pending interaction, currently with a 12-second expiry. | No map coordinate is derived from the gameobject GUID. Spell timing and proximity do not prove a source coordinate. | Collector/source identity verified by code path; source map unsupported by current collector; live behavior unknown. Keep Unknown. |
| Mining | Same gathering path as herbalism, with mining spell IDs and a gameobject GUID where exposed. | Player map/position stored as a pending interaction. | No map coordinate is derived from the gameobject GUID. | Collector/source identity verified by code path; source map unsupported by current collector; live behavior unknown. Keep Unknown. |
| Fishing | Tooltip cursor API may expose a gameobject GUID after secret/unavailable-value checks; cast, cursor, and catch events are correlated by time windows. | Player map/position at the interaction. If the player map is missing, existing code can use a synthetic negative map ID. | No verified pool/source map coordinate is obtained. A synthetic map ID is not geography. | Cursor/source evidence is conditional; source map unsupported by current collector; live behavior unknown. Keep Unknown. |

“Verified by code path” means only that the described addon branch and value exist; it does not establish runtime behavior on the Forever client. The game API may provide other source-position evidence not currently used by the addon. That possibility remains unknown until tested in game.

## Local fixture and test evidence

Local fixtures exercise loot source GUID parsing, interaction-location capture, gathering-window expiry and duplicate handling, plus synthetic per-kind inputs for creature loot, skinning, herbalism, mining, and fishing through the shared database/export path. There are no dedicated local `wowf` API fixtures for skinning or fishing tracker events yet. These fixtures emulate APIs; they do not measure gameplay coverage. No collector coverage percentage is claimed. The safe planning assumption for all five types is 100% Unknown until owner-run gameplay establishes source-map evidence.

The full addon smoke suite and syntax checks run under Lua 5.1 and Lua 5.4. Results are reported with the Geo A implementation PR. In-game source evidence requires owner participation because no WoW Forever client/runtime is available in this environment.

## Owner gameplay checks still required

For each available type (creature loot, skinning, herbalism, mining, fishing), capture at least 20 controlled interactions on `wowf` build `1.60.1.70862`, without syncing. Record only counts of evidence classes, not names, coordinates, GUIDs, or character identifiers:

1. Record the source GUID/API result and whether a source-specific map ID and source coordinate are available.
2. Record player map/position separately, including deliberate movement or map transitions between interaction start and result.
3. For herb/mining and fishing, test delayed/expired interactions, mismatched source GUIDs, hidden/secret tooltip data, and source objects that disappear before loot.
4. For creature loot and skinning, test source targets whose map position can be queried, if any supported API exists; distinguish target identity from source position.
5. Report verified source-map, interaction-only, unavailable, and ambiguous counts. Ambiguous cases remain Unknown. Do not use proximity or player location to increase geographic coverage.

## Geo A behavior

- Existing global source, item, and location counters remain intact for legacy compatibility.
- New `geographicStats.unknown` source/item counters aggregate every observation until source-map attribution is proven. They contain no coordinates or location rows.
- Export retains Companion header schema 9 and existing record types. Additive `Q|1|revision`, `Z|unknown|...`, and `Y|unknown|...` records carry revision and Unknown aggregates; the current Companion parser ignores unrecognized record types. No Companion or ingestion changes are part of Geo A.
- SavedVariables schema advances to 10. A schema-9 database receives an empty Unknown aggregate (no historical backfill) and revision 1.
- Every subsequent public snapshot mutation advances the persistent integer revision even when `updatedAt` remains in the same second. Export generation itself is read-only.
- A restored database with counters but no installation ID cannot silently receive a new identity or export those counters. Export is held until the user accepts `/fdb fork`; that action archives the old local SavedVariables and starts the new identity with zero active observations and cleared active Guildbook data. Existing server aggregates stay under the old identity; the fork uploads only new observations.
- Companion/server bootstrap comparison and server-side revision replay remain later-phase work; Geo A does not change ingestion behavior.
