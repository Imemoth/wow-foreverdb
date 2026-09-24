# ForeverDB data model

## Principle

ForeverDB stores observed data, not asserted canonical drop rates. Every percentage shown later must be derived from an explicit sample count.

## Addon-side identity

- NPCs are keyed by numeric NPC ID extracted from creature/vehicle GUIDs.
- Items are keyed by numeric item ID extracted from item links.
- Normal loot and skinning are separate observation domains.

## Counters

For each `(npc_id, item_id, mode)` pair:

- `observations`: number of source mobs observed for that mode
- `drops`: number of observed sources associated with that item
- `quantity`: total item quantity attributed to those sources

Derived values are never persisted as truth:

- observed drop rate = `drops / observations`
- average stack when dropped = `quantity / drops`

## Known alpha limitation

`GetLootSourceInfo()` associates visible loot slots with source GUIDs. A completely empty corpse may not appear in this source list. Until Forever beta behavior is verified, observation counting is intentionally conservative and must not be presented as an authoritative drop percentage.

## Persistence warning

During the Forever beta, third-party addon authors have reported that SavedVariables can be written to disk but may fail to restore after reload/restart. The uploader/backend design therefore must treat each uploaded batch as independently durable and idempotent.
