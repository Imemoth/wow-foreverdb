# ForeverDB beta test plan

The first goal is not to prove drop rates. It is to prove that the Forever client exposes enough source data to count observations correctly.

## Install

Copy `addon/ForeverDB` into the Forever beta AddOns directory so the client sees:

```text
Interface/AddOns/ForeverDB/ForeverDB.toc
```

Enable **ForeverDB** on the character-select AddOns screen.

## Sanity check

After login:

```text
/fdb status
```

Expected: version, schema version, observation counters, and an anonymous installation ID.

## Test A — one mob, one item

1. Kill a single creature.
2. Loot it normally.
3. Run `/fdb status`.
4. Log out normally.
5. Inspect `WTF/.../SavedVariables/ForeverDB.lua`.

Record:
- NPC ID was created
- normal observation count
- item ID
- drops
- quantity

## Test B — one mob, multiple item slots

Verify the source GUID is deduplicated for the observation count while every item slot is recorded.

## Test C — empty corpse

This is the critical denominator test.

Kill and loot a creature that yields no item/currency slot if possible. Determine whether Forever exposes that corpse through any usable loot-source API.

If it does not, the alpha must not claim an exact drop-rate denominator from loot events alone.

## Test D — skinning

1. Loot a skinnable corpse normally.
2. Skin it.
3. Confirm the skinning loot is stored under `skinning`, not `normal`.
4. Confirm the same NPC ID is used.

## Test E — persistence

Because Forever beta has reported SavedVariables restore issues:

1. Generate observations.
2. `/reload`.
3. Run `/fdb status`.
4. Fully exit the client and relaunch.
5. Run `/fdb status` again.
6. Compare with the on-disk SavedVariables file.

## Acceptance gate for v0.1 collector

Do not build the public website around calculated percentages until:

- normal single-source loot attribution works
- skinning is distinguishable from normal loot
- empty-corpse denominator behavior is understood
- SavedVariables persistence behavior is documented for the current beta build
