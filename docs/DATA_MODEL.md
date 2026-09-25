# ForeverDB data model

## Current contract

- Addon: **0.3.1-alpha**
- Export / SavedVariables schema: **8**
- Companion: **0.7.0-alpha**

ForeverDB stores **observations**, not asserted canonical drop rates. Percentages
are always derived from explicit sample counters.

## Source identity

A statistical source is identified by:

`(source_type, source_id, source_level)`

The model supports creature, virtual fishing-zone, GameObject and item-backed
sources. Exact source types are emitted by the addon; acquisition semantics are
kept separately in the bucket `kind`.

Creature sources use the exact observed level when available. Historical rows
that predate level-aware collection remain at source level `0`.

## Acquisition buckets

Each source contains one or more acquisition buckets. Current kinds include:

- `mob`
- `skinning`
- `mining`
- `herbalism`
- `fishing`
- `fishing_pool`
- `chest`
- `gameobject`
- `disenchant`

Each bucket stores:

- `observations`
- zero or more item counters
- zero or more aggregated locations

This keeps, for example, normal creature loot and skinning observations separate
even when they refer to the same NPC.

## Item counters

For each source/bucket/item combination ForeverDB stores:

- `item_id`
- observed item name
- `drops` — number of observed sources associated with the item
- `quantity` — total item quantity
- `quest_drops`
- observed `quest_ids`

Derived values are not persisted as truth:

- observed drop rate = `drops / observations`
- average stack when dropped = `quantity / drops`

## Locations

Location rows are aggregated by source and acquisition kind and contain:

- `map_id` / uiMapID
- zone name
- subzone name
- quantized x/y coordinates
- observation count

The addon currently quantizes positions to a 0.5% map grid. The database stores
the resulting aggregate counts rather than individual movement history.

Fishing-pool coordinates are projected/best-effort observations, not exact
server-side GameObject coordinates.

## Map metadata

Schema 8 also exports map-art metadata separately from statistical sources:

- uiMapID
- map name
- parent map ID
- MapArtID
- layer dimensions
- tile dimensions
- scale metadata
- tile texture references / FileDataIDs

The Companion stores this metadata locally and uses it to resolve Blizzard map
art from the user's WoW build. Map artwork itself is not uploaded to Supabase.

## Snapshot semantics

A Companion upload is a complete snapshot for one anonymous authenticated
installation.

The server:

1. rejects unauthenticated ingest;
2. prevents another authenticated user from taking ownership of an existing
   installation ID;
3. ignores a snapshot older than the last accepted snapshot;
4. replaces that installation's prior source/item/location statistics with the
   new snapshot.

This makes normal re-syncs idempotent and prevents an older SavedVariables copy
from rolling central data backwards.

## Statistical limitation

`GetLootSourceInfo()` can associate visible loot slots with source GUIDs, but a
completely empty corpse may not expose an equivalent loot-source record. Unless
the current Forever client behavior provides a reliable empty-source signal,
ForeverDB's loot percentages remain **observed sample rates**, not authoritative
canonical drop probabilities.

This limitation must remain visible anywhere percentages are interpreted as
drop-rate evidence.
