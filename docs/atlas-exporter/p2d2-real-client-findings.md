# Atlas Exporter 0.2.1 - findings from the first real-client export (build 1.60.1.70450)

Evidence: the delivered `ForeverDB-Atlas-Export-1.60.1.70450.zip` (60 UiMaps, 101 image variants).
It contains the index, hierarchy, build record, reports, diagnostics and manifests - **not** the raw DB2
files or BLP textures. Everything below that depends on those raw inputs is labelled as such, and the
exporter now has diagnostics to obtain exactly that evidence.

What was reproduced from the ZIP: the new verifier accepts it unchanged (`Checked 60 maps, 105 manifests,
101 images. Export is consistent.`); the seeder adopts all 101 variants from it; the new classification
rules were run over its real metadata (types, flags, parents, internal MapIDs).

## 1. The four failed full-reveal variants

| uiMapID | Zone | MapArtID | Recorded failure | Overlay row | Real shape |
|---|---|---|---|---|---|
| 1412 | Mulgore | 1200 | `overlay 5551 has 0 tiles for a 0x0 grid` | 5551 | zero size, no tile records |
| 1434 | Stranglethorn Vale | 2160 | `overlay 5252 has 0 tiles for a 1x1 grid` | 5252 | declares a size (grid 1x1), no tile records |
| 2521 | Zephras Isle | 2031 | `overlay 5545 has 0 tiles for a 0x0 grid` | 5545 | zero size, no tile records |
| 2548 | Riverglades | 2054 | `overlay 5550 has 0 tiles for a 0x0 grid` | 5550 | zero size, no tile records |

**Failure stage (all four): metadata validation inside the exporter** - before any texture was looked up,
decoded or composed. Base artwork was unaffected and stays exported.

**Root cause: an exporter defect, not a client-art, mapping, resolution or composition defect.** The
0.1.0 validator required *every* `WorldMapOverlay` row of an art to have a complete tile grid and
rejected the whole reveal on the first row that did not. Overlay rows 5545/5550/5551 are zero-size rows
with no tiles: they carry no artwork and cannot be drawn, so there is nothing to compose or to omit.

Cross-checks against real data:

* **41 of 41** reveal variants that did export match the Companion's reviewed atlas exactly (same tile
  count per art, status `client-metadata-matches-reviewed-atlas`). The overlay reading is therefore
  correct on this client; the failures are specific to the four arts that contain an extra empty row.
* All four failing arts are covered by the reviewed atlas (1200: 15 regions/18 tiles, 2160: 26/26,
  2031: 15/27, 2054: 13/35) with complete tile grids - the art exists and is known-good on earlier builds.
* The zero-size row IDs (5545, 5550, 5551) cluster at high values, as do 5252 for STV: consistent with rows
  added for new or changed Forever content that define an area but no texture. (Inference only; the raw
  table is not in the ZIP.)

**Fix (0.2.0).** Each overlay row is analysed from its own records: `ok`, `no-artwork` (zero size, no tiles),
`tileless-declared` (size but no tile records), `grid-incomplete`, `grid-invalid`, `unsupported-geometry`.
Rows without artwork are skipped, recorded (`revealSkippedOverlays`) and never drawn; a row that has
*some* tiles but not a complete grid still blocks the reveal (named stage, exact counts) unless the owner
opts into `--allow-partial-reveal`, which composes the complete overlays only and labels the variant
`partial-overlays`. Base art is never copied into a reveal. Tiles are resolved before composition so a
failure names its stage (`metadata`, `resolve`, `decode`, `compose`) and FileDataID.

| uiMapID | Cause class | Expected result of the retest | Verified status |
|---|---|---|---|
| 1412, 2521, 2548 | parser strictness on a zero-size, tile-less row | reveal exports; `client-metadata-matches-reviewed-atlas` expected if the remaining rows equal the atlas | **fix implemented; real retest pending** |
| 1434 | same, but the row declares a size (`tileless-declared`) | reveal exports labelled `tileless-declared-overlays-skipped`; `--diagnose-overlays` states whether the remaining rows match the reviewed atlas | **fix implemented; `NEEDS_REAL_CLIENT_DIAGNOSTICS` for the 5252 row itself** (is it a placeholder or truncated data?) |

None of the four is marked `FULL_REVEAL_FIXED`: that needs an exported, integrity-checked variant from the
real client. Synthetic tests reproduce each *shape* (including a reconstruction of Mulgore's 15 reviewed regions
plus a 0x0 row) but do not prove the real zones.

## 2. Zero dungeon/raid maps in the first export

What the ZIP proves:

* `Map.db2` was **not found** (`optionalTablesMissing.Map: "Map.db2 not found in client-db2"`) - neither by
  name nor by its FileDataID (1349477), local or CDN. So no `Map` row was ever read, and 0.1.0 classified
  instances from `Map.InstanceType` only. **Instance classification was impossible, not negative.**
* `UiMapLink.db2` failed with `DB2 header is not consistent with any known WDC layout`. One possible cause
  is an empty table (record count 0 may legitimately have no sections or record size), which the 0.1.0 check
  rejected; 0.2.0 tolerates it. Whether that is the real cause is unknown (see diagnostics).
* **Independent of `Map.db2`**: the 60 `UiMap` rows contain no `Type=4` (dungeon) row, and
  `UiMapAssignment` references only MapIDs `0, 1, 30, 489, 529, 2991, 2997`. As read, **no dungeon or raid
  MapID has a UiMap in this client** - so "zero drawable dungeon/raid interior maps" is consistent with the
  data. Whether instance `Map` *records* exist is unknown until `Map.db2` (or a same-build export) is read.
* The three battlegrounds are in the export as `Orphan`-type UiMaps with MapIDs **30, 489, 529**
  (Alterac Valley, Warsong Gulch, Arathi Basin) and drawable artwork - i.e. there *are* 3 drawable instance
  maps; they were mislabelled `other` because only `Map` could classify them.
* The export report did not record DB2 section warnings, so the first run cannot show whether encrypted
  sections hid rows (a beta client may hold unreleased content behind TACT keys). 0.2.0 records them.

Not established: *why* `Map.db2` is unreadable. Candidates the new diagnostics separate: not present in this
storage's root, encrypted (needs a TACT key), offline (streamed, needs download), or listed under a different
FileDataID/name on this product. `--diagnose-tables` reports the CascLib error code for each.

**Changes**

* Per-table fallback: an optional table that fails in the client is tried in the other sources (same build
  number: wago.tools CSV). The first run never consulted wago for `Map` because the client source "succeeded"
  for the required tables. Where each table came from is recorded (`build.json › tableSources`).
* Instance discovery independent of artwork: every `Map` row with `InstanceType` 1-4 (documented enum:
  party, raid, pvp, arena), plus MapIDs named by `LFGDungeons`, plus UiMaps classified as instances.
  Output `atlas/instances.json`. Identity is kept apart: `mapId` (internal), `uiMapId`, `mapArtId`.
* Battlegrounds without a readable `Map` row: classified from the UiMapAssignment MapIDs 30/489/529, the
  documented compatibility set (verified in this client: those exact names map to those exact IDs),
  labelled `categorySource: compat-mapid`, `confidence: fallback`. With the `Map` table they become
  `confirmed`.
* Floors only from `UiMapGroupMember` (group, `FloorIndex`, height). Without it, several UiMaps sharing a
  MapID are listed with an explicit "floor order unverified" note - no order is invented. No outdoor
  coordinates are projected into interior floors; every map keeps its own provisional calibration.
* Entrance maps only from `UiMapLink` rows; region only from the parent `Map` row.

## 3. Classification coverage (real metadata, Map table unavailable)

| Category | 0.1.0 | 0.2.0 | Source |
|---|---|---|---|
| world | 1 | 1 | `UiMap.Type` |
| continent | 4 | 4 | `UiMap.Type` |
| zone | 45 | 45 | `UiMap.Type` |
| city | 6 | 6 | **`uimap-flags+name-list` (confirmed)**; was `name-list` only |
| instance | 0 | **3** (battlegrounds) | `compat-mapid`, fallback |
| other | 4 | 1 (Darkspear Islands, MapID 2997) | `UiMap.Type=6`, no further metadata |

City rule: zone-type map under a continent whose `UiMap.Flags` lacks `ShowOverlays` (0x2). Verified on this
client: exactly the six capitals match, and no other zone does. Cities the name list does not know would be
reported `uimap-flags` / `derived`; name-only matches `name-list` / `fallback`. Categories are never evidence
of artwork: an instance without a UiMap stays an instance record with a stated reason.

Not classifiable from the available data: Darkspear Islands (MapID 2997), Zephras Isle (2991) - they need
`Map`.

## 4. Interchange schema (additive; no importer change needed)

* New file `atlas/instances.json`.
* `atlas/index.json` maps: `internalMapId`, `classificationConfidence`, `classificationEvidence`,
  `floorGroupId`, `floorIndex`; variants: `revealCompleteness`, `revealFailureStage`, `revealSkippedOverlays`.
* Manifests: `categoryConfidence`, `floor{groupId,floorIndex,source}`, `provenance.internalMapId`,
  `provenance.revealCompleteness`, `provenance.revealSkippedOverlays`.
* `atlas/build.json`: `tableSources`, `tableRowCounts`, `tableWarnings`.
* `atlas/hierarchy.json`: `instances`. Summary text: instance lines.
* **Behavioural data corrections** (values, not shape): battleground `category` `other` -> `instance`;
  `categorySource` gains `uimap-flags+name-list`, `uimap-flags`, `compat-mapid`; the four reveal variants now
  exist. `schemaVersion` stays 1. PR #72's branch contains no consumer of these files, so nothing there needs
  to change.

## 5. Real-client retest (targeted first)

Exe: artifact `ForeverDB-AtlasExporter-win-x64` of the PR's latest Windows run. `--version` must print
`ForeverDB Atlas Exporter 0.2.1` (0.2.0 also works for the targeted export; 0.2.1 only fixes diagnostics, section 8).

```
:: 1. why can't Map.db2 / UiMapLink be read?  (about a minute, read-only)
ForeverDB.AtlasExporter.exe --diagnose-tables --wow-root "C:\Program Files (x86)\World of Warcraft" --output .\diag
:: 2. instances and overlays
ForeverDB.AtlasExporter.exe --diagnose-instances --diagnose-overlays --wow-root "..." --output .\diag
:: 3. the four zones only, reusing your first export (no re-export of the other 56)
ForeverDB.AtlasExporter.exe --export --wow-root "..." --seed-from "C:\path\ForeverDB-Atlas-Export-1.60.1.70450.zip" --only 1412,1434,2521,2548 --output .\retest
```

Expected:

1. `diag\diagnose-tables.txt` lists every table. For `Map` either "found by name/FileDataID" or the storage
   error (`error 6002 ENCRYPTED`, `4350 file offline`, `2 not found`, ...). Also: encrypted DB2 sections, header
   facts for `UiMapLink`, whether a same-build CSV exists. **Send `diag\*.txt` and `*.json`.**
2. `diagnose-overlays.txt` ends with a verdict summary, e.g. `READY_TO_EXPORT: 45`; for 1412/2521/2548 the rows
   5551/5545/5550 appear as `no-artwork`; for 1434 row 5252 as `tileless-declared`, with "client usable overlays
   MATCH it exactly" or "DIFFER from it". `diagnose-instances.txt` shows `Map rows: N`, the MapIDs seen, and
   the instance records.
3. `Scope: FILTERED - 4 of 60 maps`, `Successfully exported: 4 (new 0, reused 4 ...)`, `Status: COMPLETE (FILTERED
   RUN - not the full atlas)` or `COMPLETE WITH WARNINGS`; files
   `retest\ForeverDB-Atlas-Export\maps\1412\full-reveal\overview.webp` (and 1434, 2521, 2548) exist.
   Any remaining failure names its stage and FileDataID in `diagnostics\extraction-errors.json`.

## 6. Combining the result with the original 60-map export

`--seed-from <original zip>` adopts only images of the **same build key** whose size, SHA-256 and dimensions
verify, and the follow-up run redoes only what is missing, failed or changed. Therefore the new ZIP *is* the
combined export: the original 60 base and 41 reveal images byte-identical (compare `sha256` in the two
`atlas/index.json`), plus the repaired reveals, `atlas/instances.json` and corrected categories. For the full
run:

```
ForeverDB.AtlasExporter.exe --export --wow-root "..." --seed-from "C:\path\ForeverDB-Atlas-Export-1.60.1.70450.zip" --output .\ForeverDB-Atlas-Export-v2
```

If the original output *folder* still exists, `--resume --output <that folder>` does the same using the
original resume state. Either way run `--verify` on the new ZIP before returning it.

## 7. Remaining gaps (before the second real-client run - superseded by section 8)

* Why `Map.db2` is unreadable on this client, and therefore whether instance records exist beyond the three
  battlegrounds (needs diagnostics output).
* The nature of STV overlay row 5252.
* `UiMapLink`: empty table or an unsupported layout (diagnostics show the header facts).
* Encrypted DB2 sections: now reported; unreadable rows cannot be recovered without TACT keys.
* City category for new Forever settlements relies on the flag rule (derived); capitals are confirmed.

## 8. Second real-client run: diagnostics output (build 1.60.1.70450, exporter 0.2.0)

Inputs: `diagnose-tables`, `diagnose-instances`, `diagnose-overlays` (txt + json) from the owner's machine. Each
statement below is tagged **[confirmed]** (read from those reports), **[inferred]** (follows from them but was
not observed directly) or **[open]**.

### 8.1 Tables
* **[confirmed]** 10 of 12 map tables are located by FileDataID (never by name - the client lists no names, error 2
  for every table, which is normal), are WDC5, unencrypted (`tactKeyHash 0`), match the expected table hash,
  and match a `.dbd` layout. Rows read: UiMap 60, UiMapArt 144 (55 records + 89 copy rows), UiMapArtStyleLayer 6,
  UiMapArtTile 1672, UiMapAssignment 61, UiMapXMapArt 60, WorldMapOverlay 1081, WorldMapOverlayTile 1739.
* **[confirmed] `UiMapGroupMember` and `UiMapLink` are empty in this client**: valid headers, matching table and
  layout hash, 0 records, 0 sections, 0 stored columns. 0.2.0 reported this as a "layout mismatch" - **that was an
  exporter defect, not a client problem**: an empty stub has no column storage to compare with the definition.
  0.2.1 loads it as an empty table and records "valid but empty table" in `build.json` `tableWarnings`.
  The wago CSV was also unavailable for both (`HttpRequestException`; **[open]** whether wago has no such table
  for this build or the request failed - it does not change the result).
* **[confirmed] `Map` and `LFGDungeons` open by FileDataID (10,197 and 3,875 bytes) yet the report said
  `NOT FOUND`** - the inconsistency you flagged. Cause: the reader opens a file and then reads it with
  `CascReadFile`; when the read fails it returns nothing without a code, and the 0.2.0 probe only *opened*
  the file, so it showed "opened" under a "NOT FOUND" heading. So these two files are **listed in local storage
  but their data could not be read** (and the production reader, local first then CDN unless `--no-cdn`, got no
  bytes either). **[open]** *why* the read fails (encrypted blob / data not present locally / other) - 0.2.0
  never recorded the read error. 0.2.1 attempts the read in the probe and reports it:
  `LISTED in the local storage but its data could not be read` with `read FAILED after N byte(s): <meaning>
  (error <code>)`, and JSON `located: "listed-but-unreadable"`.
* **[confirmed]** `Map` (73 rows) and `LFGDungeons` (71 rows) were loaded from the **same-build wago.tools CSV**,
  not from the client file. All instance data below therefore rests on that mirror (`coverage: map-table
  (wago-csv:1.60.1.70450, 73 Map rows)`), not on the client's own `Map.db2`.

### 8.2 Instances
* **[confirmed]** 55 instance records from `Map.InstanceType` (documented values only): 37 dungeons (type 1), 13 raids
  (type 2), 5 battlegrounds (type 3); 18 Map rows are type 0 (not instances). 0 arenas.
* **[confirmed]** Drawable: 4 - Alterac Valley (MapID 30 / UiMap 1459), Warsong Gulch (489 / 1460), Arathi Basin
  (529 / 1461), Darkspear Islands (2997 / 2524). Not drawable: 51 - including the 5th battleground (Battle for
  Gilneas, 3005) and all 37 dungeons and 13 raids, with the stated reason *the client defines no UiMap
  (UiMapAssignment) for this MapID*.
* **[confirmed] No dungeon or raid has an interior map in this client's metadata**: the 60 UiMaps have types
  1:1, 2:4, 3:51, 6:4 (no dungeon-type map) and `UiMapAssignment` references only MapIDs 0, 1, 30, 489, 529, 2991,
  2997. This is a *correct discovery result*, not an exporter gap; no dungeon art is invented.
* **[confirmed]** Floors: 0 independent floors (`UiMapGroupMember` is empty, and no instance has more than one
  UiMap). Entrances: none (`UiMapLink` is empty).
* **[inferred] Darkspear Islands is now a battleground** because its Map row says `InstanceType=3`; it is a
  type-6 UiMap like the three classic battlegrounds. Treat it as data-driven; a consumer that disagrees can
  filter on MapID 2997.
* Names are reported as the client data has them and are not curated: development entries (`Test Dungeon` 13,
  `CashTest` 29, `<unused> Monastery` 44), a duplicate Naxxramas (533 raid, 2921 dungeon) and entries such as
  `City of Dalaran` or `Deadwind Pass` typed as dungeons come straight from `Map.InstanceType`.

### 8.3 The four failed reveals
**[confirmed]** `--diagnose-overlays`: all 45 candidates `READY_TO_EXPORT`; all 982 required overlay tiles resolved
from **local** storage (no CDN); each map's client overlays **match the reviewed atlas exactly**.

| uiMapID | Map | MapArtID | Overlay rows | Skipped (no artwork) | Verdict |
|---|---|---|---|---|---|
| 1412 | Mulgore | 1200 | 16 | 5551 (`no-artwork`, 0x0, no tiles) | ready, 15 regions / 18 tiles |
| 1434 | Stranglethorn Vale | 2160 | 27 | 5252 (`tileless-declared`: 256x256 declared, **no tile records**) | ready, 26 regions / 26 tiles |
| 2521 | Zephras Isle | 2031 | 20 | 5545-5549 (`no-artwork`) | ready, 15 regions / 27 tiles |
| 2548 | Riverglades | 2054 | 14 | 5550 (`no-artwork`) | ready, 13 regions / 35 tiles |

The earlier open question about row 5252 is answered: `WorldMapOverlayTile` (1739 rows read from the client) holds
no tile for it, and the reviewed atlas never had it either (26 regions), so there is no artwork to composite; the
reveal will not contain it and says so (`tileless-declared-overlays-skipped`). **Not yet claimed as
`FULL_REVEAL_FIXED`**: that requires the actual export of the four variants and their integrity checks
(`--export --seed-from ... --only 1412,1434,2521,2548`).

### 8.4 What changed in 0.2.1
Diagnostics and one false error only; no change to image output, manifests or resume state.
* Empty client tables load as empty (see 8.1) instead of failing as a layout mismatch.
* `--diagnose-tables` reads the located file and reports the CascLib read error for a file that opens but
  cannot be read.
* Tests: 107 synthetic (a stub with the real client's shape reproduces the exact `definition has N stored
  columns, file has 0` error without the fix).

### 8.5 Remaining limitations
* **[open]** Why `Map.db2` / `LFGDungeons.db2` cannot be read (rerun `--diagnose-tables` with 0.2.1; about a minute).
* `Map` data depends on the wago.tools same-build CSV (needs network on the first run, cached afterwards); the
  client file is the preferred source once it is readable.
* The corrected categories (3 battlegrounds as `instance`, Darkspear Islands) and `instances.json` only appear in
  a new export; the original ZIP still carries the first run's categories until it is re-exported with `--seed-from`.
