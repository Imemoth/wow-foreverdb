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

## Safe repeatable gameplay acceptance

The addon diagnostic is read-only. It does not write SavedVariables, change revisions, reset counters, fork an installation, rebuild the export, or contact a network service.

The in-game command is `/fdb geodiag`. It prints the current persisted revision, `updatedAt`, SavedVariables schema, per-kind lifetime observation totals, and conservative evidence classes (`source-map`, `player-context-only`, and `no-location-context`). It then reports whether `player`, `target`, `npc`, and `mouseover` have a recognized source-GUID type and candidate map ID, plus whether the world-cursor API exposes a readable gameobject GUID candidate. The probe never prints GUIDs, names, tooltip strings, or coordinates. Unit map IDs are candidate readings only, not source attribution.

1. Keep Companion closed for the entire sample. Ensure Auto Sync is off before the test and leave it off; do not open a Companion sync flow afterward until the owner has decided what to do with the test observations. The addon itself does not upload.
2. Log in to a test character on `wowf 1.60.1.70862`. Do **not** run `/fdb fork`, `/fdb session reset`, or any counter reset. Existing counters and SavedVariables are retained.
3. At the start of the sample, run `/fdb geodiag`. Save a screenshot or transcribe only the collector event counts, Unknown/context counts, API availability and revision. Do not share names, GUIDs, coordinates, or character/account identifiers.
4. Perform 20 controlled events for one collector class at a time: creature loot (`mob`), skinning, herbalism, mining, and ordinary fishing catches. Run `/fdb geodiag` after each 20-event group. Compare the start/end `events` line for that class; for fishing, record `fishing` and `fishing_pool` separately and report both. A smaller difference means some interactions did not produce a collector observation. Repeat the baseline/end pair for every class.
5. During a creature or skinning sample, run `/fdb geodiag` while the source target is still available. During herb/mining, run it while the node is targeted/hovered and immediately after the gather interaction. During fishing, run it while hovering the pool and after the catch. Record whether the candidate `target`/`npc`/`mouseover` unit map matches the player map and whether `world-cursor evidence` reports a readable gameobject GUID candidate. The command prints candidate map IDs only; those readings are probes, **not proof** that the event source has that map.
6. Include deliberate failure/ambiguity trials: move maps between interaction and result when safe, let gathering/fishing windows expire, use a missing or secret tooltip value if naturally available, and interact with a different source after an expired pending event. Do not manufacture or expose secret values.
7. In each report, classify only the event counts as source-map-proven, interaction-context-only, map-unavailable, or ambiguous. In Geo A, the report must show `source-map: 0`; all events are Unknown. The `player-context-only` figure is a count of legacy location rows and never an attribution result. If the API appears to provide source-map evidence, retain the raw values locally and report only counts plus the API name/result shape for review.
8. Capture the ending revision. Re-running `/fdb geodiag` without gameplay should leave revision, counters, and export unchanged. Gameplay observations may advance the revision; the delta need not equal event count because map metadata or other exported records may also change.
9. Leave the test observations in SavedVariables. Do not restore an old file, reset counters, fork, export/upload them, or enable sync as part of this acceptance. Owner review of the anonymized evidence counts is the next gate.

The command displays a summary of lifetime persisted counters, so always compare start/end values. Existing global counters are not backfilled into the new Unknown bucket; on older characters, lifetime `events` may therefore exceed lifetime `unknown`. Compare each value with its own baseline. It does not create a disposable test bucket or provide an automatic “undo”; this keeps the existing installation identity and saved history intact.

## Geo A behavior

- Existing global source, item, and location counters remain intact for legacy compatibility.
- New `geographicStats.unknown` source/item counters aggregate every observation until source-map attribution is proven. They contain no coordinates or location rows.
- Export retains Companion header schema 9 and existing record types. Additive `Q|1|revision`, `Z|unknown|...`, and `Y|unknown|...` records carry revision and Unknown aggregates; the current Companion parser ignores unrecognized record types. No Companion or ingestion changes are part of Geo A.
- SavedVariables schema advances to 10. A schema-9 database receives an empty Unknown aggregate (no historical backfill) and revision 1.
- Every subsequent public snapshot mutation advances the persistent integer revision even when `updatedAt` remains in the same second. Export generation itself is read-only.
- A restored database with counters but no installation ID cannot silently receive a new identity or export those counters. Export is held until the user accepts `/fdb fork`; that action archives the old local SavedVariables and starts the new identity with zero active observations and cleared active Guildbook data. Existing server aggregates stay under the old identity; the fork uploads only new observations.
- Companion/server bootstrap comparison and server-side revision replay remain later-phase work; Geo A does not change ingestion behavior.
