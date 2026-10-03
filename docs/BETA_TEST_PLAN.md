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

## 0.7.x Herbalism / Disenchant collector acceptance

**Repo preparation: COMPLETE. Live acceptance: PENDING for both collectors.**
The 0.7.x label is the roadmap milestone, not the addon version. This procedure
was prepared against main `7aa400582be4ad32287b4a1274ddb0db50724750`:
addon **0.4.0-alpha**, schema **9**, Companion **0.8.0-alpha**, interface **16001**.
Repo checks were rerun on 2026-09-28 after integrating main
`e2a28c94a2b79ba2757e0c527d02ec00980afdf5`: addon **0.4.1-alpha**,
schema **9**, Companion **0.8.2-alpha**, interface **16001**.
Record the actual commit and Forever client build used for every run. Offline
checks below do not establish compatibility with that client build.

### Shared starting state and evidence

1. Install the addon from the commit under test; ensure only one ForeverDB copy
   is loaded. Record `/dump GetBuildInfo()`, locale, addon/Companion versions and
   whether other bag/loot addons and Auto Loot are enabled.
2. With WoW closed, back up `WTF/Account/<account>/SavedVariables/ForeverDB.lua`
   (and `.bak` if present) under the actual Forever product directory. Preserve
   the installation ID and historical samples; no database reset is required.
3. Use an appropriately skilled herbalist for H cases and an enchanter with
   Disenchant for D cases; these may be different characters. Provide free bag
   slots and expendable disenchantable items. Start with default bags, no bag/loot
   addons, Auto Loot **off**. Test the normal addon/Auto Loot setup separately.
4. Close loot windows, clear the target, cancel any spell cursor and wait more
   than 20 seconds without gathering, fishing, skinning or disenchanting.
5. Enable script errors (`/console scriptErrors 1`). Debug defaults to on after
   loading this build; `/fdb debug` **toggles**, so use it only as needed and
   confirm `debug: on`. Retain chat output and any Lua error/stack trace.
6. Run `/fdb status`, `/fdb last`, `/fdb export`. Record baseline counters
   `H0 = herbalism`, `D0 = disenchant`, `U0 = unresolved loot windows`, source
   count, installation ID and last observation. A fresh database may correctly
   report `no observation recorded yet`. Flush/copy a baseline snapshot if exact
   per-item deltas will be needed.
7. Run one case at a time; check status/last immediately, before unrelated loot
   overwrites `lastObservation`. Record input source ID, each output item ID,
   visible stack quantity, zone/subzone and time. Compare **deltas**, not assumed
   zero totals, and repeat the starting state between independent cases.

Counting contract: the collector captures at `LOOT_READY`, before actual pickup.
One captured window adds one bucket observation; each distinct output item adds
one `drops`, while `quantity` adds the sum of that item's visible slot quantities.
`/fdb last` reports distinct `items`, total `quantity`, `quest items` and `level`.
For these non-creature sources, stored/exported source level is **0**, displayed
by `/fdb last` as **?** (not player level, profession skill or input item level).
Opening and abandoning a loot window can therefore still create an observation;
these are observed loot samples, not successful inventory-transfer counts.

### Test H1 — one herb node, manual loot — PENDING

Starting state: shared setup; identify one usable herb node and note its name and
player position. No creature loot, fishing pool or chest interaction in between.

1. Gather the node normally. Let the cast succeed; inspect the loot window and
   note each output item/quantity, then take all items and let the window close.
2. Immediately run `/fdb status` and `/fdb last`.
3. Run `/fdb export`, then complete the save/export checks below for this case.

Expected:
- Debug contains `herbalism interaction detected spell <id> source ...`, then
  `captured herbalism gameobject <nodeID> ...`. Spell ID **2366** or the exact
  English spell name **Herb Gathering** is currently recognized. Other ranks or
  localized IDs/names need client evidence; do not assume they work.
- `herbalism = H0 + 1`, `disenchant = D0`, `unresolved loot windows = U0`;
  unrelated kind counters are unchanged. Source count increases only if this
  node's **GameObject type ID** has never been seen, not for every physical spawn.
- `/fdb last`: `last: herbalism gameobject <nodeID> <name if available>`;
  `items` equals distinct output IDs and `quantity` their summed stacks.
  Ordinary non-quest herbs have `quest items: 0`; record actual quest flags if any.
- Source key `gameobject:<nodeID>`, bucket kind **herbalism**. A generic
  `gameobject`, `chest`, `mining` or `mob` bucket is an attribution failure.
- Location comes from the player's gathering position, quantized to a 0.5% map
  grid. It is not a claim of exact server-side node coordinates. With working
  map APIs, check the correct map/zone/subzone and plausible x/y in 0–100.
  Missing map/position data must be reported as a location limitation, not
  invented. Source attribution and location acceptance are recorded separately.

### Test H2 — repeat, multiple outputs, Auto Loot — PENDING

Starting state: H1 evidence saved; record a fresh baseline.

1. Gather a second node of the same type, fully closing each loot window.
2. If available, gather a node yielding a stack >1 or multiple output item IDs.
3. Enable Auto Loot and gather another fresh node; record that setting and restore
   the preferred setting afterwards. Repeat with the user's bag/loot addons if used.

Expected for **each new window**: herbalism +1, unresolved +0, unchanged D counter;
`last: herbalism gameobject <nodeID>`, correct distinct item and quantity totals.
Same node type aggregates into the existing source/bucket; item `drops` rises once
per window containing that item, not once per unit or slot. If the same item
occupies two slots, quantities sum but `drops` rises only once. Capture status,
last, export and SavedVariables deltas for each variant. Multi-output variants
that cannot be obtained remain PENDING, not silently PASS.

### Test H3 — interruption, expiry, unrelated loot, reopen — PENDING

Starting state: shared setup for each subcase; record new counters/last.

- **Interrupted/failed gather:** interrupt a fresh gathering attempt before
  success (or record an actual failed attempt). Without a loot window, all
  observation counters, U and last remain unchanged; no herb B/I delta appears
  in export or SavedVariables. Next unrelated chest/mob loot must retain its own
  kind, with no herbalism increment.
- **Unconsumed success/expiry, if reproducible:** after a successful gather that
  does not immediately produce a captured window, wait **>12 seconds**, then loot
  an unrelated source. The stale gathering kind must not label it herbalism.
  Expiry is checked lazily on the next pending-state read, not by a timer; expect
  `herbalism pending gathering expired before loot` then. If the client always
  produces loot immediately, retain this live variant as PENDING/not reproducible;
  do not manufacture success by editing addon state.
- **Partial loot/reopen:** where the node permits it, take only part of the loot,
  close, then reopen the **same** node. Compare all bucket/export/SavedVariables
  deltas and last after each open. Reopening remaining loot must not be accepted
  as an independent fresh node sample. Current code deduplicates repeated
  `LOOT_READY` only until `LOOT_CLOSED`; it has no cross-window source-instance
  deduplication. Extra observations or generic-bucket leakage are a **FAIL/known
  limitation to resolve before closure**, not a PASS justified by current code.

For unrelated loot, `/fdb last` should describe that new source/kind. The normal
observation may increment its own counter; only H/D deltas must remain zero.
Inspect export for generic/chest buckets too: `/fdb status` does not print every
possible bucket kind. Collect any Lua error and the surrounding debug sequence.

### Test D1 — one input item, manual Disenchant — PENDING

Starting state: shared setup; select an expendable, disenchantable bag item.
Record its **input item ID/link/name** before destroying it. Output dust/essence/
shard IDs are different entities. Use spellbook/action-bar Disenchant followed by
a bag click first; macros and alternative bag UIs are separate compatibility cases.

1. Activate Disenchant, click the input item within **10 seconds**, let the cast
   succeed, inspect output slots, then take all materials and close the window.
2. Immediately run `/fdb status` and `/fdb last`.
3. Run `/fdb export`, then complete the save/export checks below for this case.

Expected debug chain (client order must be verified):
`disenchant cursor detected` -> `disenchant target <inputID> ...` ->
`disenchant armed <inputID>` -> `captured disenchant item <inputID> ...` ->
`disenchant consumed <inputID>`.
The input is learned through a secure post-hook on `C_Container.UseContainerItem`
or legacy `UseContainerItem`; spell success **13262** arms it. There is no
speculative fallback that infers the input from the resulting materials.

Expected results:
- `disenchant = D0 + 1`, `herbalism = H0`, `unresolved loot windows = U0`;
  unrelated kind counters unchanged. Source count rises only for a new input ID.
- `/fdb last`: `last: disenchant item <inputID> <inputName>`; fallback name
  `Item <inputID>` is allowed when item info is unavailable. `items`/`quantity`
  describe outputs, `quest items: 0` for normal materials, `level: ?`.
- Source key `item:<inputID>`, bucket **disenchant**. The input item must **not**
  appear as an output merely because it was consumed; the output IDs belong to
  this input's `bucket.items`. No output material ID may substitute as source ID.
- Disenchant currently records **no location**. A new D-only bucket has an empty
  `locations` table and no `L` export row; the absence of a map marker is expected.

### Test D2 — repeated input, multiple outputs, Auto Loot — PENDING

Starting state: D1 saved; new baseline and another expendable input of the same ID.

1. Disenchant it normally with a completely new cast/window.
2. If available, test a result with a stack >1 or multiple distinct materials.
3. Repeat on another input ID, then test Auto Loot. Test any usual macro/bag addon
   separately and record the exact invocation; working default bags do not prove
   every bag UI calls the hooked API.

Each successful window adds exactly one D observation, with H/U unchanged and
`last: disenchant item <this inputID>`. Same input ID aggregates, different input
IDs remain separate sources. Each output gets `drops +1`, quantity adds its stack
sum, and `/fdb last` matches that window. Export/SavedVariables must preserve the
input/output distinction in every variant. Unobtainable output variants remain
PENDING; a missing target on a tested invocation is a failure for that invocation.

### Test D3 — cancel, failed cast, timeout and isolation — PENDING

Starting state: shared setup separately for each subcase; fresh baseline/last.

- Activate then cancel the Disenchant cursor without selecting an item. Open/use
  an ordinary bag item or loot an unrelated source within 10 seconds. No D sample
  may be recorded. This specifically probes stale cursor timestamps after cancel;
  current code only stamps positive cursor detection, so client behavior matters.
- Start Disenchant on an expendable item and interrupt before success; also record
  an invalid/failed target attempt if the client allows it. No loot means counters,
  U and last unchanged. A delivered failed/interrupted event for spell 13262 should
  log `disenchant cleared <event>`. The next herb/chest/mob loot must not inherit D.
- Activate the cursor and wait **>10 seconds** before selecting the item. If the
  client still allows destruction, the tracker cannot capture that late selection;
  expect no new target breadcrumb and possibly success-without-target/unresolved
  loot. Record this as a timeout limitation, never a successful D1 run. Re-arm the
  cursor and retry promptly with another expendable item.
- If reproducible, delay success **>12 seconds** after target capture or delay
  loot **>20 seconds** after success. Expect target/active expiry diagnostics on
  the next relevant call, no stale D attribution to unrelated loot, and no D bucket
  delta from the expired context. These are different time windows, not an E2E SLA.
- Where possible close a partially looted disenchant result and reopen it. Check
  for duplicates, unresolved windows and wrong-source attribution. As with H3,
  same-window deduplication does not establish safe reopening; a duplicated or
  misattributed sample fails the collector gate.

After each subcase run status/last/export and the SavedVariables checks. On a
negative case without loot, no new B/I rows or count deltas are expected. If an
unattributable loot window actually opens, U may rise and last may stay unchanged;
that is evidence of a failed capture, not evidence that nothing happened.

### Export and SavedVariables checks — apply to every H/D case — PENDING

`/fdb export` prints `export snapshot rebuilt: <N> bytes` and rebuilds
`ForeverDB_Export` **in memory**; it neither opens an export UI nor flushes the
file. `/fdb status` reports export bytes, but a positive/growing byte count alone
is not acceptance. Observations already rebuild the snapshot automatically.

1. After collecting case evidence, run `/fdb export` and `/reload` (or normal
   logout). Confirm status/last after reload **before any other loot**.
2. Inspect/copy `WTF/Account/<account>/SavedVariables/ForeverDB.lua` from the
   correct Forever product/account. Do not edit it while WoW is running. Confirm
   file timestamp and both globals, `ForeverDB_Saved` and `ForeverDB_Export`.
3. Check schema 9, the same installation ID and these exact Lua table paths:

| Collector | Source table | Bucket | Item table |
|---|---|---|---|
| Herbalism | `ForeverDB_Saved.sources["gameobject:<nodeID>"]` | `.buckets.herbalism` | `.items["<outputID>"]` |
| Disenchant | `ForeverDB_Saved.sources["item:<inputID>"]` | `.buckets.disenchant` | `.items["<materialID>"]` |

Verify sourceType/sourceId/sourceLevel (level 0), bucket observations, item
`itemId`, `drops`, `quantity`, `questDrops` and `questIds` against baseline deltas.
Check `ForeverDB_Saved.lastObservation` and
`ForeverDB_Saved.diagnostics.unresolvedLootWindows`. Herbalism location rows carry
`mapId`, `zoneName`, `subZoneName`, `x`, `y`, `observations` when available;
disenchant adds none. Do not confuse a numeric item ID with its **string** map key.

4. Inspect the logical lines of `ForeverDB_Export` (Lua may serialize newlines
   using escapes). Placeholders below represent actual measured values, not
   literal text to search for. Counts are cumulative bucket/item totals:

```text
H|9|<addonVersion>|<installationID>|<updatedAt>
S|gameobject|<nodeID>|0|<nodeName-or-empty>
B|gameobject|<nodeID>|0|herbalism|<observations>
I|gameobject|<nodeID>|0|herbalism|<outputID>|<name>|<drops>|<quantity>|<questDrops>|<questIDs>
L|gameobject|<nodeID>|0|herbalism|<mapID>|<zone>|<subzone>|<x>|<y>|<locationObservations>
S|item|<inputID>|0|<inputName>
B|item|<inputID>|0|disenchant|<observations>
I|item|<inputID>|0|disenchant|<materialID>|<name>|<drops>|<quantity>|<questDrops>|<questIDs>
```

`L` exists only with captured location metadata; no `L|item|<inputID>|0|disenchant|`
is expected for a new D-only source. Each distinct output has its own I row.
Exporter order is S, B, L, I (the field reference above is not an ordering
assertion). Text escapes `%`, `|`, CR/LF and comma as `%25`, `%7C`, `%0D`, `%0A`,
`%2C`. Never judge item counts from raw line order or byte length. Other historical
S/B/I/L and map/Guildbook records may coexist.

5. Fully exit WoW normally and relaunch. Compare H/D/U, installation ID, last and
   bucket/item/location totals again. Rebuilding/exporting/reloading without new
   loot must not add observations. Timestamps/byte lengths can change. A successful
   in-memory check without matching saved/reloaded data is **not** persistence PASS.

### Companion -> Supabase -> search/details gate — PENDING

The roadmap's collector closure includes the entire path, not only addon capture.
For **each** collector after its real SavedVariables snapshot has been flushed:

1. Point Companion at the tested Forever installation/account, authenticate and
   trigger/observe sync. Record snapshot time, installation ID, success/error and
   relevant logs. A simulated Lua fixture is not a replacement for this snapshot.
2. Verify the ingested source tuple and bucket/item counts for that installation
   using authorized diagnostics/reads when available. Then sync the same snapshot
   again: per-installation counts must not double. Public aggregated counts may
   include other installations, so do not expect them to equal only your delta.
3. Search by the output item ID and open its source: herbalism appears under
   **Gathered from**, disenchant under **Disenchanted from**. Open source details:
   groups are **Herbalism** and **Disenchants into**, respectively. Verify the
   source type/ID, output items, quantities/sample and item/source navigation.
4. For herbalism, verify the collected location is offered in the proper zone;
   mark map rendering/location verification separately if unavailable. For
   disenchant, absence of a location is expected, not a map regression.

Only actual evidence through search/details may close the corresponding roadmap
checkbox. If server-side/per-installation verification is inaccessible, record
that stage PENDING; a successful UI sync message alone is insufficient evidence.

### Typical failure diagnosis

| Symptom | Check / evidence to collect |
|---|---|
| H counter stays flat; last is `gameobject`/`chest` | Was `herbalism interaction detected` logged before `captured`? Record successful spell ID/name/locale and event order. Only ID 2366 or exact name `Herb Gathering` currently matches. Look for 12-second pending expiry. |
| `source awaiting loot source` in H debug | Not itself a failure: `UnitGUID("npc")` did not supply a GameObject. Actual loot can still resolve via `GetLootSourceInfo`. Check final `captured` and last. |
| U increments, last remains old | `loot unresolved; slots: <N>` means no source could be resolved. Record slot count, target state, timing and input/node ID; do not treat the old last observation as this attempt. |
| D has no cursor/target breadcrumb | At load, check `disenchant hook installed: ...` or `hook unavailable: ...`, and `cursor unavailable: GetCursorInfo missing`. Reproduce in default bags. A non-hooked bag/macro path, cursor API shape or >10-second selection may be involved. |
| D logs `target missing item link` | Record bag/slot and whether the modern/legacy container API returned the input link before destruction. Do not infer input identity from materials. |
| D logs `succeeded without captured target` | Inspect cursor -> bag-hook -> success ordering, item link availability and spell ID 13262. It did not arm a valid source. |
| D target/active expiry | Capture elapsed times: cursor selection 10 s, target-to-success 12 s, active-to-loot 20 s. Expiry logs are lazy; silence while idle is normal. |
| D is armed but loot captured earlier/under another kind | Record `UNIT_SPELLCAST_SUCCEEDED` vs `LOOT_READY` ordering using the client's event trace if available. This is a client-compatibility failure to investigate, not grounds to guess a new delay. |
| Wrong herb/chest source or D after cancellation | Preserve sequence and timing. Gathering does not strictly bind herbalism/mining to a matched source GUID; canceled cursor timestamps may remain until later transitions. Cross-contamination is a gate failure. |
| Double counts / generic bucket on reopen | Capture every open/close and export deltas. Only repeated `LOOT_READY` within one window is deduplicated today; reopening is explicitly under test. |
| Status correct, disk/sync stale | `/fdb export` is not a disk write. Verify normal save, actual product/account path, file timestamp, watcher and installation ID before blaming classification. |
| Counts correct, herb location absent / D has no marker | Verify map API availability for herbs. Disenchant intentionally has no location. Do not fabricate node coordinates. |
| Any Lua error | Record full error/stack, build/locale, input/source ID, bag/loot addons, Auto Loot and exact action. Stop that case and mark FAIL. |

### Live evidence update — 2026-10-02

Herbalism live capture was exercised on Forever with Auto Loot off. The observed
sequence and counters were:

- Peacebloom: `gameobject:1618`, one output item, quantity 1; herbalism counter
  increased **9 -> 10**, unresolved loot windows stayed **0**.
- Silverleaf: `gameobject:1617`, one output item, quantity 2; herbalism counter
  increased **10 -> 11** and then **11 -> 12** on a second fresh node, unresolved
  loot windows stayed **0**.
- `/fdb last` reported the expected herbalism GameObject source/name and per-window
  item/quantity values for both node types.
- After `/reload`, the herbalism total remained **12** and the Silverleaf
  `lastObservation` remained available. This establishes reload persistence for
  the observed live snapshot.
- Auto Loot was exercised successfully on live herbalism and preserved the same
  collector classification without unresolved loot windows.
- Companion authenticated sync and search/details presentation were verified live:
  Peacebloom and Silverleaf are searchable, herb items show **Gathered from**,
  source details show **Herbalism**, Mulgore location rows/coordinates are present,
  and the corresponding map markers render.
- Full client exit/relaunch persistence PASS: herbalism totals and installation
  identity survived a full client exit and relaunch.
- Interrupted gathering PASS: canceling a gather before loot did not increment
  herbalism and did not contaminate the next unrelated loot classification.
- Partial-loot/reopen was reproduced live with Earthroot `gameobject:1619`
  yielding Earthroot + Frilled Lichen. Before the fix, reopening the same physical
  node caused duplicate observations (**herbalism 22 -> 23 -> 24**) for the same
  GameObject instance. This is a confirmed live FAIL of the old behavior.
- Repo fix now deduplicates reopened gathering windows by the full physical source
  GUID (not only source type ID), while a distinct node with the same GameObject
  type ID remains a fresh observation. Simulated regression coverage PASS; live
  post-fix retest remains required.
- Direct on-disk SavedVariables inspection and an explicit repeated-sync
  no-double-count check remain pending.
- Disenchant live testing is now reproducible, but the pre-fix Combined Backpack
  path failed to capture the input item. The live trace showed
  `disenchant succeeded without captured target` followed by
  `loot unresolved; slots: 1`; no disenchant observation was recorded.
- Repo fix adds an item-target cursor fallback plus `ITEM_LOCK_CHANGED(bag, slot)`
  capture so the source item can be identified even when the Combined Backpack
  bypasses the observed `C_Container.UseContainerItem` hook path. Simulated
  Combined Backpack regression coverage PASS; live post-fix retest remains required.

### Evidence ledger and closure rule

Initial state on **2026-09-27**; no WoW client run was performed during preparation:

| Case / stage | Herbalism | Disenchant | Evidence required |
|---|---|---|---|
| Repo source/bucket/export review | COMPLETE | COMPLETE | Source review + offline command below; not E2E PASS |
| H1 / D1 manual success | PASS (live capture) | FIX NEEDS LIVE RETEST | Peacebloom 1618 PASS. Disenchant pre-fix live trace reached spell success/loot but failed target capture; Combined Backpack item-lock fallback added repo-side |
| H2 / D2 repeat, multi-output, Auto Loot | PARTIAL PASS | PENDING | Silverleaf 1617 repeated twice, qty 2, H 10->11->12, U 0; Auto Loot PASS; multiple distinct output-item variant still pending |
| H3 / D3 negative cases and reopen | INTERRUPT PASS / REOPEN FIX NEEDS LIVE RETEST | PENDING | Interrupted gather PASS. Earthroot 1619 partial reopen reproduced duplicate H 22->23->24 on old build; full-GUID dedup fix + simulated regression added |
| Export + on-disk SavedVariables | PENDING | PENDING | Matching B/I/L records and Lua table paths |
| Reload + full exit/relaunch | PASS | PENDING | Herbalism totals/installation identity survived /reload and full exit/relaunch |
| Companion authenticated ingest / repeated sync | INGEST PASS / REPEAT CHECK PENDING | PENDING | Live herb snapshot reached Companion/Supabase; explicit no-double-count comparison after repeat sync still pending |
| Search/details and applicable locations | PASS | PENDING | Peacebloom/Silverleaf searchable; Gathered from + Herbalism groups, Mulgore coords and map markers verified |
| Full collector E2E closure | PENDING | PENDING | All preceding live stages have evidence |

For every execution record: case/subcase, date/tester, commit/build/locale,
character profession/skill, bag/Auto Loot configuration, baseline and final
counters, node/input/output IDs, screenshots/chat/error trace, saved snapshot and
result (`PASS`, `FAIL`, or `PENDING` with reason). Keep sensitive character/guild
information out of public attachments. Missing evidence or unexecuted variants
stay PENDING; observed mismatches are FAIL. Do not replace this initial ledger
with PASS merely because a procedure or code change exists.

Offline check, from repository root with standalone Lua (or `texlua`):

```sh
lua tests/collector_smoke.lua
```

It executes the real Core/Database/Exporter/Location/Gathering/Disenchant/Loot
modules with simulated WoW API/event inputs: identities, bucket/item deltas,
status/last, export, same-window deduplication, expiry and failure isolation,
modern/legacy container hooks. It does **not** exercise actual WoW APIs, event
ordering, on-disk SavedVariables flushing, Companion, Supabase or search UI.
