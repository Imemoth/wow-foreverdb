# Geo A final acceptance and implementation report

**Status:** Geo A positive LIVE acceptance PASS; final repository integration
is BLOCKED by the required web dependency audit and dependent release gate.
The independent code review found no confirmed Geo A implementation blocker.

**Scope:** Addon-only geographic collection and local diagnostic evidence.
Companion parsing, database ingestion, scoped RPCs and Search UI are not part
of Geo A.

## Accepted live evidence

The owner tested WoW Forever `wowf 1.60.1.70862` using Addon version
`0.7.3-alpha`, SavedVariables schema 11, Companion export schema 9, and build
marker `geo-a-fishing-event-order-3`. The source implementation was at
`e6c3fab6cc5e41c2fc5e8aa015ea08dbc81a20e8` before dependency reconciliation.
The live counts are owner-reported acceptance evidence; the repository does
not contain SavedVariables or private diagnostics.

| Collector | Result | Accepted count / class |
| --- | --- | ---: |
| Creature loot | PASS | 36 `verified_interaction_zone` |
| Skinning | PASS | 33 `verified_interaction_zone` |
| Mining | PASS | 2 `correlated_interaction_zone` |
| Herbalism | PASS | 4 `correlated_interaction_zone` |
| Ordinary fishing | PASS | 1 `correlated_interaction_zone` |
| Blizzard protected-action / taint retest | PASS | Owner reports clean taint log |

The final fishing sample produced Raw Brilliant Smallfish in Tirisfal Glades
(map ID 1420). Fishing observations advanced 78→79 and correlated
interaction-zone 0→1; Unknown and player-context-only remained 13, and
legacy/unclassified remained 65. The owner reported CHANNEL_START, SUCCEEDED,
CHANNEL_STOP, loot capture and the correlated-zone diagnostic. The installed
addon marker was `geo-a-fishing-event-order-3`.

### Build and commit identity

- Owner-tested client: WoW Forever `wowf 1.60.1.70862`.
- Owner-tested addon: `0.7.3-alpha`, marker `geo-a-fishing-event-order-3`.
- Owner-associated live source commit: `e6c3fab6cc5e41c2fc5e8aa015ea08dbc81a20e8`
  (`Handle reversed fishing loot event timestamps`).
- Current reconstructed implementation commit on the reviewed PR branch:
  `1e456eb0834890532d4295c5ebb937511943cd2c` (`feat(addon): complete Geo A
  attribution and acceptance record`).
- Later no-op-save revision correction: commit
  `02ca51fd389fa7df9fac86c2e04cb51c5c94c3b1`; it was not present in the
  owner-tested binary.

The tested source and the current PR commits are distinguished deliberately:
owner acceptance validates the event-order implementation in the tested
build; automated tests validate the later no-op-save revision correction.

These results establish positive classification for the listed live events.
They do not establish a source map or source coordinates, and they do not prove
that all negative edge cases have been exercised against the live client.

## Evidence classes and claims

- `verified_source_map`: source identity is associated with a validated source
  map. Geo A emits no observations in this class; no live source-coordinate
  evidence was accepted.
- `verified_interaction_zone`: a unique direct loot source and synchronous,
  stable validated map/zone evidence identify where the loot interaction was
  recorded. This does not identify the creature's or node's location.
- `correlated_interaction_zone`: a bounded, unique cast/channel-to-loot
  sequence and stable map/zone evidence associate the recorded interaction
  with a zone. It does not identify node, fish, bobber or source coordinates.
- `unverified_player_position`: diagnostic context only. It never contributes
  to a named geographic aggregate.
- `Unknown`: missing, stale, conflicting, unsupported or ambiguous evidence.

Coordinates are sampled only transiently to check that a map is usable; they
are not written to scoped geography as source coordinates. A map ID alone is
not enough to resolve a zone. Multiple sources, mismatched map/zone names,
map transitions, invalid map metadata, interrupted or overlapping operations,
expired windows, duplicate callbacks, unrelated loot and missing required
event timestamps fail closed or remain unresolved.

The fishing READY-before-OPENED fix stores the actual timestamps of both events
and supports either order. It does not synthesize a missing timestamp. The
five-second stop-to-open/capture limit, unique direct bobber-source check,
stable zone validation, single-use pending cast and Unknown fallback remain in
force. Fishing-pool handling is separate from ordinary fishing correlation.

## Data integrity, compatibility and privacy review

- Successfully recorded new observations keep the legacy global source/item
  totals and add exactly one geographic class. Unresolvable loot windows stay
  unresolved. Zero-drop observations retain their observation denominator and
  do not gain fabricated item rows.
- Duplicate source/window suppression and loot-item quantity/drop semantics
  are independent of geographic eligibility. A rejected geography link does
  not erase an otherwise recorded global observation.
- Old observations are not backfilled. Existing Unknown and
  legacy/unclassified counts were preserved through owner acceptance.
- SavedVariables schema 11 adds geography and snapshot revision state while
  preserving the installation identity and existing saved data. `/fdb fork`
  requires explicit confirmation, archives previous history locally and starts
  the active installation with empty counters. Missing installation identity
  with historical counters pauses export until recovery; there is no automatic
  re-upload under a fresh identity.
- Final code review found that logout save preparation advanced the revision
  even when the exported snapshot was unchanged. The unconditional bump is
  removed; actual state mutations continue to advance it. A Lua regression
  verifies both unchanged save and changed-observation behavior.
- Export keeps Companion schema 9 and existing record types. Additive `Q`, `Z`
  and `Y` records are optional extensions ignored by the current Companion.
  This does not implement upload or scoped server ingestion.
- Addon networking is not used. The owner left Companion closed and Auto Sync
  disabled for acceptance. No observations, SavedVariables or diagnostics were
  uploaded, and no production database or deployment was changed.
- The taint correction removes addon references to Blizzard `StaticPopup*`
  globals and uses the local confirmation frame. The owner reports a clean
  protected-action/taint retest. Lua UI/static fixtures cover the forbidden
  global references; broader live taint permutations were not independently
  tested in this review.

## Automated verification and limits

Lua 5.1 and 5.4 local container runs passed the collector suite (50 simulated
cases after the save-revision regression was added), session
tracker (54), session UI (76), quest API (5), quest tracker (29), quest kill
tracker, Guildbook capture, and Lua syntax checks. CI will be rerun after
final documentation/rebase updates; only checks on the final exact PR heads
count for integration. The reviewed prior heads passed all required checks
except `Dependency audit (web)` and its dependent `Web release gate`. The audit
blocked inherited Next.js `16.3.0–16.4.4`, advisory
`GHSA-mfr8-8qww-v76h` (patched release reported as `16.4.6`). The audit failure
is outside Geo A scope and is not suppressed or waived.

Fixtures cover zero drops, conservation, legacy data preservation, revision
increments within one second, installation recovery, duplicate suppression,
source ambiguity, cast identity mismatch, interruption, overlap, unrelated
casts/loot, timeouts, map changes, invalid map data, missing fishing events,
both READY/OPENED event orders, callback duplication, fishing-pool separation,
and no source-coordinate leakage. These are simulated tests, not live negative
acceptance. Live negative trials for every collector, fishing pools, and
additional protected-action interactions remain **NOT TESTED**.

## Remaining scope and backlog

- `verified_source_map` remains unsupported by this implementation.
- Live positive acceptance does not establish the false-positive rate across
  all Forever event/API shapes.
- Companion geographic parsing, revision replay and recovery UI, migration
  0019-dependent ingestion, safe aggregate RPCs and scoped Search UI remain
  later Geo B–E phases. Geo B has not started.
- Migration 0019 is a hard prerequisite for future Geo C ingestion. No
  migration was applied here.
- The Session Reset / Installation Fork modal opacity/readability polish
  remains a deferred UX backlog item. Existing confirmation logic and
  data-safety behavior were not weakened.
- No production merge automatically deploys a service. No deployment or live
  database change is included in Geo A acceptance.
