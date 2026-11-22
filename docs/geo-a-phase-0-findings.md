# Geo A — Phase 0 attribution findings

**Historical scope:** the initial section records static inspection of addon collectors and simulated local Lua fixtures; it was not live runtime evidence. The later dated updates record owner gameplay results. No observation data or diagnostics were uploaded to a server. The local workspace did not contain the WoW Forever executable or API runtime.

## Evidence matrix

| Collector | Evidence present in addon | Location currently recorded | Source-map attribution | Phase 0 status |
| --- | --- | --- | --- | --- |
| Creature loot | `GetLootSourceInfo()` yields the loot source GUID; the addon resolves creature identity. | Player map sampled synchronously around the loot event, with map identity and normalized coordinate validity checked; the player point is not retained as source position. | The event supports zone-only `verified_interaction_zone` when one source GUID and stable valid map/zone evidence pass. It does not prove the creature's exact coordinates or spawn location. | Owner accepted 36 positive interaction-zone observations; no source-map claim. |
| Skinning | Skinning flow correlates creature identity with the opened loot source. | Player map sampled synchronously around loot; pending interaction also carries event-time map. | A fresh matching source GUID and stable valid map support interaction-zone only, not creature coordinates. | Owner accepted 33 positive interaction-zone observations. |
| Herbalism | Gathering spell and cast/loot flow correlate to the loot source. | Event-time player map/zone sampled at gather and loot; coordinates are only used to validate map availability. | Bounded successful cast/unique loot correlation with stable zone supports correlated interaction-zone only. | Owner accepted 4 positive correlated-interaction-zone observations. |
| Mining | Mining spell 2575 and SENT/SUCCEEDED are correlated separately from the GameObject GUID. | Event-time player map/zone sampled at send, success, and loot; coordinates only validate map availability. | Bounded successful cast/unique loot correlation with stable zone supports correlated interaction-zone only. | Owner accepted 2 positive correlated-interaction-zone observations. |
| Ordinary fishing | Fishing channel start/stop are correlated to a unique direct bobber source; both loot callback orders are supported. | Validated map/zone sampled at channel start, channel stop, loot open and capture. Player coordinates are not retained. | A unique bobber source, completed single-use channel and stable zone support correlated interaction-zone only. | Owner accepted 1 positive correlated-interaction-zone observation, including READY-before-OPENED handling. |
| Fishing pools | Tooltip cursor API may expose a pool GameObject GUID after secret/unavailable-value checks; existing pool hover/cast handling remains separate. | Existing best-effort projected position is retained only for the legacy pool marker flow. | Ordinary fishing channel correlation does not relabel a pool as ordinary fishing or create a pool source-map coordinate. | Pool behavior is unchanged and must be tested separately from ordinary water catches. |

“Verified by code path” means only that the described addon branch and value exist; it does not establish runtime behavior on the Forever client. The game API may provide other source-position evidence not currently used by the addon. That possibility remains unknown until tested in game.

The matrix status cells were updated after owner acceptance on
`wowf 1.60.1.70862`; earlier sections below preserve the chronological failure
and correction history. The accepted live evidence is positive-only and does
not validate every negative event path.

## Mining live acceptance follow-up — 2026-11-11

The owner reported mining events 0→5, player-context-only 0→5, interaction-zone 0, source-map 0, duplicate source suppression working, and mining spell 2575 detected. This shows gathering and loot were each recognized. It does not show that a GameObject GUID was available at cast time. The code-path gap was that `GetPendingGatheringKind()` allowed the mining kind when no GUID was captured, but `resolveLootInteractionZone()` required a cast-time `pending.guid` to equal the unique `GetLootSourceInfo()` GUID. A source GUID first available at loot therefore could not be safely linked by the old resolver.

The targeted mining/herbalism fix adds a separate `correlated_interaction_zone` class. It requires player `UNIT_SPELLCAST_SENT` → matching `UNIT_SPELLCAST_SUCCEEDED` → one unique direct GameObject loot source within four seconds, no conflicting observed source GUID, a single non-overlapping pending operation, and the same validated map/zone at send, success and loot capture. When both events expose a CastGUID they must match; CastGUID and GameObject GUID are separate identities. If neither event exposes CastGUID, only the one ordered same-spell operation is eligible. A one-sided or mismatched CastGUID, failed/interrupted spell, overlap, unrelated event, expired window, map change, invalid map evidence, ambiguous sources or source conflict remains Unknown (or unresolved where source identity is ambiguous). The existing 12-second pending lifetime remains the outer bound.

## Fishing live acceptance follow-up — 2026-11-11

The owner reported a real Old Skull catch on map 1420 (Tirisfal Glades): fishing observations 65→66, Unknown 0→1, and player-context-only 0→1. The loot observation and item were recorded, but geography was not assigned. The cause was that `LootTracker.lua` changed ordinary bobber loot into a synthetic `fishing:<mapId>` source before the generic direct-source resolver ran. The fishing tracker only maintained pool hover/cast state; it did not retain a unique ordinary cast/channel operation. Thus the available player zone context had no accepted event-to-source link and correctly remained Unknown.

The targeted fix adds a dedicated, one-use ordinary-fishing channel correlator. It requires one fishing channel start and its matching stop (matching CastGUID when exposed; a missing token is accepted only when both ends lack one and the pending operation is unique), a directly identified single bobber GUID, a valid matching map/zone at start, stop, loot open and capture, and loot opened/captured within five seconds after channel stop. The map is sampled only as zone identity. Player coordinates are used transiently to verify a usable normalized map and are never stored as fishing-source coordinates. Failure, interruption, a new overlapping operation, unrelated player cast/loot, timeout, map transition, invalid/ambiguous source, or a missing `LOOT_OPENED` event cannot earn the correlated class. The first loot window consumes the pending operation even when it does not qualify. Existing `fishing_pool` hover/source behavior is separate and unchanged.

The five-second bound and channel event sequence follow the behavioral shape observed in GatherTogether 0.6.4, not a measured Forever latency. Runtime availability, argument order, bobber source GUID behavior, and event order on `wowf 1.60.1.70862` remain unverified until owner retest. The current live observation remains Unknown; no historical row is reclassified. The collector continues to record exactly one ordinary fishing observation and its items, including zero-drop windows, independently of whether geography qualifies.

## Final owner acceptance update — 2026-11-16

The owner accepted positive live results on `wowf 1.60.1.70862`, Addon
`0.7.3-alpha`, build marker `geo-a-fishing-event-order-3`. Accepted lifetime
class totals were creature loot 36 interaction-zone, skinning 33
interaction-zone, mining 2 correlated-interaction-zone, herbalism 4
correlated-interaction-zone and ordinary fishing 1 correlated-interaction-zone.
The final fishing delta was 78→79 observations and 0→1 correlated-zone;
Unknown/player-context-only stayed 13, legacy/unclassified stayed 65, and the
owner reported that READY/OPENED order handling emitted the correlated result.
The owner also reported the protected-action/taint retest PASS.

The historical 11-15 report of fishing UNKNOWN due to incomplete timestamps
identified the actual edge case: READY could be captured before OPENED, leaving
the resolver without the second real event timestamp. The fix retains the two
actual timestamps and accepts either callback order. When a callback is
missing, correlation remains ineligible; the observation can still be counted
globally/Unknown when its source is otherwise resolvable. The five-second
window, direct unique bobber GUID, stable zone, one-use pending operation and
fishing-pool separation remain unchanged. Simulated Lua 5.1/5.4 tests cover
both event orders, missing callbacks, duplicates, expiry, map changes and
unrelated/ambiguous loot; live negative cases remain unverified.

See [Geo A final acceptance and implementation report](geo-a-acceptance.md)
for the full invariants, privacy review, data preservation, test matrix and
remaining limitations.

## Fishing LIVE failure follow-up — 2026-11-15

The owner reported two further ordinary catches (Raw Longjaw Mud Snapper): fishing 66→68, Unknown 1→3, player-context-only 1→3, correlated interaction-zone unchanged at 0, and legacy unchanged at 65. Herbalism correlation still works. This confirms that the fishing observations/items are counted and that the failure is confined to the optional geography link. These aggregate counters do **not** identify whether Forever omitted a channel callback, used an unrecognized event tuple, invalidated the pending channel/map, omitted a unique bobber GUID, or delivered loot outside the five-second ordering window. The exact live rejection cause is therefore not established; no attribution gate was relaxed.

Review of the prior diagnostics found two verification gaps: the addon's displayed version remained `0.7.3-alpha`, so `/fdb status` could not identify the instrumented revision, and `/fdb debug` toggled state instead of allowing a read-only check. `/fdb status` now includes a unique `geo-a-fishing-diagnostics-2` build marker and current debug state. `/fdb debug status`, `/fdb debug on`, and `/fdb debug off` provide explicit status/control; the existing no-argument toggle remains supported. Fishing-only rejection lines go through a dedicated reason-only printer and do not include cast tokens, source GUIDs, character names, or coordinates. An early return on unparseable loot source now logs a fishing rejection reason when a pending fishing channel exists. Other unrelated debug output behavior is unchanged.

Local Lua 5.1/5.4 regression fixtures confirm that a successful-cast-only trace and a channel-start-without-stop trace remain Unknown, preserve one global observation/item count, produce a diagnostic reason, and do not include fixture GUIDs or coordinates. The fixtures do not establish which event shape the live Forever client produces. No code change changes attribution semantics, item/global counts, pool separation, zero-drop behavior, deduplication or snapshot revisions.

## Fishing loot timestamp ordering follow-up — 2026-11-16

The owner observed accepted CHANNEL_START, SUCCEEDED, and CHANNEL_STOP events, a recorded fishing item, and the rejection `loot event timestamps are incomplete`. This isolates the live failure to missing loot-event timing rather than cast recognition, map identity, or bobber classification. The defect was confirmed in the event handler: `LOOT_READY` called capture immediately, while `LOOT_OPENED` only populated its timestamp; when READY arrived first, later OPENED could not retry because the window was already marked captured.

The loot tracker now stores the first real LOOT_READY and LOOT_OPENED timestamps independently and captures after both are observed, regardless of their order. For a completed pending fishing operation, if READY arrives first it waits only to the existing five-second fishing correlation deadline for OPENED. LOOT_CLOSED flushes an incomplete pair; the deadline also flushes it. In either case, missing OPENED remains `nil`, so the loot observation is conserved globally but geography safely remains Unknown. A missing READY never creates a synthetic observation. `lootWindowCaptured` still guards one capture per window, and duplicate callbacks do not refresh the first timestamp or double count.

The fishing resolver now validates the actual READY and OPENED timestamps independently: both must be at or after channel stop, both must fall inside the existing five-second bound, the map must remain stable, and the source must remain one unique direct bobber GUID. It supports READY before OPENED without substituting processing time for event time. Missing, reversed-before-stop, stale, expired, ambiguous, or map-changing evidence fails closed. Fishing pools and all aggregate/item/zero-drop/revision semantics remain unchanged. Spell diagnostics now report recognized fishing callbacks and pending-operation conflicts only; unrelated wand/spell casts no longer generate fishing log lines.

New Lua fixtures cover both event orders, missing OPENED with timeout and close flush, missing READY, duplicate READY/OPENED callbacks, expired reversed-order loot, invalid existing correlation cases, and unrelated wand casts. The build marker is now `geo-a-fishing-event-order-3`, shown by `/fdb status`.

### Single owner LIVE retest

With Auto Sync disabled and without resetting, reloading, or syncing SavedVariables, run `/fdb status` and confirm build marker `geo-a-fishing-event-order-3`. Run `/fdb debug status`; if it reports off, use `/fdb debug on`. Make exactly one ordinary-water fishing catch. Record the `fishing attribution:` reason lines and whether channel start/stop and loot appear in order; do not send the full debug log. Record before/after `/fdb geodiag` counts for fishing Unknown, player-context-only, and correlated interaction-zone. Turn debug off afterward if enabled for this test. A qualifying catch must add exactly one correlated interaction-zone observation; a rejected catch must remain one Unknown observation with unchanged item count. Do not sync or reset data.

The four-second success-to-loot interval is a conservative engineering choice, not a live latency measurement. GatherLite's one-second and GatherTogether's five-second windows were behavior references only; no code or library was copied. If `UNIT_SPELLCAST_SENT` is unavailable, the existing success-only global classification may continue but cannot earn correlated geography. No source coordinate is available in this collector: `GetLootSourceInfo()` identifies the loot source, while map/position APIs are player-context. This class supports zone totals only and never source-map points.

`player-context-only` remains a diagnostic subset of Unknown, not a peer evidence class. Every new observation adds exactly one global observation and one geographic class; historical Unknown and legacy events are not reclassified. A loot window with a known source and no items still counts one observation with zero item drops; a window without a source identity remains unresolved. The 600-second per-source duplicate guard is unchanged.

Live event argument order and latency on Forever 1.60.1.70862 remain unverified here. The owner should retest this path before relying on coverage changes; the local Lua fixtures emulate APIs and are not live acceptance.

## Local fixture and test evidence

Local fixtures exercise exact loot source GUID parsing, verified and correlated interaction-zone evidence, CastGUID/GameObject GUID separation, missing CastGUID, cast mismatch, cast/source conflict, success-only fallback, failures/interruption, overlap/unrelated casts, timeout, before/after map stability, map/zone disagreement, map hierarchy/coordinate validity, duplicate handling and synthetic per-kind Unknown inputs. They verify global/geographic conservation, zero-drop behavior, multi-slot aggregation, export evidence labels and absence of source coordinates. These fixtures emulate APIs; they do not measure live gameplay coverage. The owner-reported 20 creature-loot events and five mining events remain historical and are not reclassified or backfilled.

The full addon smoke suite and syntax checks run under Lua 5.1 and Lua 5.4. Results are reported with the Geo A implementation PR. In-game source evidence requires owner participation because no WoW Forever client/runtime is available in this environment.

## Third-party behavior-reference comparison

The supplied archives and public GatherLite repository were inspected outside the ForeverDB tree. No reference source, library, or copied implementation was added to this repository.

| Reference path | Observed correlation behavior | Identity and location assumptions | ForeverDB implication |
| --- | --- | --- | --- |
| GatherLite 8.4.5 `scripts/methods.lua` (the public repository inspected was commit `8581b01`, version 8.4.4) | Tracks `UNIT_SPELLCAST_SENT`, then matching `UNIT_SPELLCAST_SUCCEEDED`; associates `LOOT_OPENED` only when success was within about one second. | Carries cast GUID as a cast token and uses the player's captured map/coordinates as the node location. It does not match the loot GameObject GUID to the cast GUID. | Useful event-order reference only. ForeverDB keeps CastGUID distinct, waits for one unique loot-source GUID, and never stores player coordinates as source coordinates. Four seconds is an explicit unmeasured Forever compromise, not copied timing behavior. |
| Gatherer 7.3.1 `Swag/LibSwag.lua`, `GatherEvent.lua`, `GatherApi.lua`, `GatherDropRates.lua` | Tracks gathering spell/name and success time, then accepts loot-opened results within roughly one second; loot text/tooltip data helps classify nodes and outputs. | Does not use a modern CastGUID/GameObject GUID identity join in the inspected path. Position is derived from player position. Its drop-rate denominator is based on observed loot output, so an empty loot window is not retained as a zero-drop observation. | Do not adopt tooltip/name heuristics as source proof. Preserve ForeverDB's unique-source and zone validation, and retain zero-drop observations only when independent source identity exists. |
| GatherTogether 0.6.4 `Core.lua` | Fishing tracks cast/channel start and stop, then correlates the catch at `LOOT_OPENED` while casting or within about five seconds. | Its location is player-derived and is not proof of pool identity or exact source coordinates. | Behavioral reference for a bounded channel-to-loot event sequence only. ForeverDB additionally requires one direct bobber loot GUID and stable validated zone identity; it stores no source point. |

These projects are behavioral references rather than evidence of WoW Forever 1.60.1.70862 runtime semantics. The actual event availability, argument tuples, event ordering and cast-to-loot latency must be confirmed by the owner in-game. The chosen collector fails closed when those runtime values do not satisfy its checks.

## Owner gameplay checks still required

For each available type (creature loot, skinning, herbalism, mining, fishing), capture at least 20 controlled interactions on `wowf` build `1.60.1.70862`, without syncing. Record only counts of evidence classes, not names, coordinates, GUIDs, or character identifiers:

1. Record the source GUID/API result and whether a source-specific map ID and source coordinate are available.
2. Record player map/position separately, including deliberate movement or map transitions between interaction start and result.
3. For herb/mining and fishing, test delayed/expired interactions, mismatched source GUIDs, hidden/secret tooltip data, and source objects that disappear before loot.
4. For creature loot and skinning, test source targets whose map position can be queried, if any supported API exists; distinguish target identity from source position.
5. Report verified source-map, verified interaction-zone, correlated interaction-zone, Unknown (including the player-context-only subset), unavailable, and ambiguous counts. Herb/mining may support the correlated tier only when the sent/succeeded sequence, unique loot source, four-second bound, and stable zone pass. Ordinary fishing requires a unique completed channel, direct bobber GUID, and stable zone with loot opened/captured within five seconds after channel stop. These mean an interaction was correlated to loot in that zone, not that the node, fish, or bobber has the player's coordinates. Ambiguous cases remain Unknown; multiple source GUIDs remain unresolved. The interaction map never supplies exact creature coordinates.

## Safe repeatable gameplay acceptance

The addon diagnostic is read-only. It does not write SavedVariables, change revisions, reset counters, fork an installation, rebuild the export, or contact a network service.

The in-game command is `/fdb geodiag`. It prints the current persisted revision, `updatedAt`, SavedVariables schema, per-kind lifetime observation totals, and evidence counts (`unknown`, `interaction-zone`, `correlated-interaction-zone`, `source-map`, `player-context-only`, `legacy/unclassified`, and `no-location-context`). It then reports whether `player`, `target`, `npc`, and `mouseover` have a recognized source-GUID type and candidate map ID, plus whether the world-cursor API exposes a readable gameobject GUID candidate. The probe never prints GUIDs, names, tooltip strings, or coordinates. Unit map IDs are candidate readings only, not source attribution.

1. Keep Companion closed for the entire sample. Ensure Auto Sync is off before the test and leave it off; do not open a Companion sync flow afterward until the owner has decided what to do with the test observations. The addon itself does not upload.
2. Log in to a test character on `wowf 1.60.1.70862`. Do **not** run `/fdb fork`, `/fdb session reset`, or any counter reset. Existing counters and SavedVariables are retained.
3. At the start of the sample, run `/fdb geodiag`. Save a screenshot or transcribe only the collector event counts, Unknown/context counts, API availability and revision. Do not share names, GUIDs, coordinates, or character/account identifiers.
4. Perform 20 controlled events for one collector class at a time: creature loot (`mob`), skinning, herbalism, mining, and ordinary fishing catches. Run `/fdb geodiag` after each 20-event group. Compare the start/end `events` line for that class; for fishing, record `fishing` and `fishing_pool` separately and report both. A smaller difference means some interactions did not produce a collector observation. Repeat the baseline/end pair for every class.
5. During a creature or skinning sample, run `/fdb geodiag` while the source target is still available. During herb/mining, run it while the node is targeted/hovered and immediately after the gather interaction. During fishing, run it while hovering the pool and after the catch. Record whether the candidate `target`/`npc`/`mouseover` unit map matches the player map and whether `world-cursor evidence` reports a readable gameobject GUID candidate. The command prints candidate map IDs only; those readings are probes, **not proof** that the event source has that map.
6. Include deliberate failure/ambiguity trials: move maps between interaction and result when safe, let gathering/fishing windows expire, interrupt a fishing channel, open unrelated loot after a catch, use a missing or secret tooltip value if naturally available, and interact with a different source after an expired pending event. Do not manufacture or expose secret values.
7. For creature-loot retest on Tirisfal, compare the `mob events`, `interaction-zone`, `unknown`, and `legacy/unclassified` deltas. `verified_interaction_zone` may increase only when the loot GUID is unique and the live API returns valid map metadata for the player's event-time map, with matching `GetZoneText`, stable before/after map identity, and a valid normalized map position. Record only class counts and whether map ID 1420 appeared; share no coordinates/GUIDs/names. A successful interaction-zone classification says “loot interaction recorded in Tirisfal Glades,” not “creature was at the player's coordinates.” If any check fails, it must increment Unknown. `source-map` remains 0 unless a source-specific map API is independently demonstrated.
8. For herbalism and mining, compare global `events`, both interaction-zone classes, `unknown`, and `legacy/unclassified` before and after a controlled event. Every new accepted event must add exactly one geographic class; it must not add both. The correlated tier can rise only after a successful SENT→SUCCEEDED→unique loot-source sequence within the event bounds. Existing global-only rows are not geographically backfilled. If the event total rises while all geographic deltas remain zero, record addon version and revision for local diagnosis before treating the result as a defect.
9. Capture the ending revision. Re-running `/fdb geodiag` without gameplay should leave revision, counters, and export unchanged. Gameplay observations may advance the revision; the delta need not equal event count because map metadata or other exported records may also change.
10. Leave the test observations in SavedVariables. Do not restore an old file, reset counters, fork, export/upload them, or enable sync as part of this acceptance. Owner review of the anonymized evidence counts is the next gate.

The command displays lifetime counters, so always compare start/end values. Existing global counters are not backfilled into Unknown or interaction-zone buckets; on older characters, `legacy/unclassified` can explain why global totals exceed the sum of current geographic buckets. Compare each value with its own baseline. The collector emits one geographic class for each newly recorded observation; if a fresh event changes a global bucket while Unknown and both interaction-zone classes stay unchanged, verify addon build and SavedVariables/revision identity before interpreting the report. Diagnostics do not create a disposable test bucket or provide an automatic “undo.”

## Geo A behavior

- Existing global source, item, and location counters remain intact for legacy compatibility.
- New `geographicStats.unknown` source/item counters aggregate observations without named geographic evidence. They contain no coordinates or location rows.
- New `geographicStats.interactionZone` and `geographicStats.correlatedInteractionZone` counters distinguish direct loot-event zone evidence from a gathering-cast/loot-source correlation. Both are zone-only; no player coordinates are copied into them or rendered as source markers. The correlated class requires the bounded, stable SENT→SUCCEEDED→unique-source path documented above; a cast-time GameObject GUID is optional if none was available, but any candidate actually observed must match.
- Export retains Companion header schema 9 and existing record types. Additive `Q|1|revision`, `Z|...`, and `Y|...` records carry explicit evidence-class labels; the current Companion parser ignores these unrecognized extensions. No Companion or ingestion changes are part of Geo A.
- SavedVariables schema advances to 11. Older databases receive empty new geographic buckets on migration (no historical backfill); snapshot revision behavior and installation identity remain unchanged.
- Every subsequent public snapshot mutation advances the persistent integer revision even when `updatedAt` remains in the same second. Export generation itself is read-only.
- A restored database with counters but no installation ID cannot silently receive a new identity or export those counters. Export is held until the user accepts `/fdb fork`; that action archives the old local SavedVariables and starts the new identity with zero active observations and cleared active Guildbook data. Existing server aggregates stay under the old identity; the fork uploads only new observations.
- Companion/server bootstrap comparison and server-side revision replay remain later-phase work; Geo A does not change ingestion behavior.

## Deferred UI acceptance backlog

Confirmation modal readability remains a separate follow-up: use a 95–100% opaque dialog surface, a dark backdrop, higher-contrast warning text with improved spacing, separated confirm/cancel buttons, shared styling for Session Reset and Installation Fork, and blocked interaction with the underlying Session UI. Preserve current confirmation logic and data-safety guards. Prioritize the current taint fix and Geo A gameplay acceptance before this unrelated UI work; this collector change does not modify the modal.

## Final owner LIVE confirmation — 2026-11-22

On WoW Forever `wowf 1.60.1.70862`, the owner confirmed positive acceptance for
all five collector classes using Addon `0.7.3-alpha`, marker
`geo-a-fishing-event-order-3`. The final ordinary fishing catch was Raw
Brilliant Smallfish in Tirisfal Glades (map ID 1420). Fishing observations
advanced 78→79, correlated interaction-zone 0→1, Unknown 13→13,
player-context-only 13→13, and Legacy/unclassified 65→65. The owner reported
CHANNEL_START, SUCCEEDED and CHANNEL_STOP recognized and the event classified
as correlated interaction-zone. The event establishes zone correlation only;
it does not establish fish/bobber coordinates or a source-map identity.

The installed build is associated with source commit
`e6c3fab6cc5e41c2fc5e8aa015ea08dbc81a20e8`. Current PR implementation commit
`1e456eb0834890532d4295c5ebb937511943cd2c` carries the matching feature, and
`02ca51fd389fa7df9fac86c2e04cb51c5c94c3b1` adds the tested no-op-save revision
fix after the LIVE binary. Historical Unknown and Legacy observations were
preserved. The taint result is owner-reported; negative map, interruption,
ambiguity, timeout, zero-drop and duplicate cases are covered only by
simulated regression fixtures, not independent LIVE trials.
