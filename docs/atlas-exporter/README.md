# ForeverDB Atlas Exporter

`ForeverDB.AtlasExporter.exe` is a standalone Windows console tool that reads the map
data and map artwork of the **locally installed WoW: Forever client** and packs every
discoverable map into one validated ZIP for the AzerDex CDN packaging step.

It is deliberately isolated from the Companion: separate projects, no change to any
Companion file, no network service of ours, no database access.

| Piece | Path |
| --- | --- |
| Executable (CLI, Windows CASC access) | `companion/ForeverDB.AtlasExporter/` |
| Platform-neutral library (all logic) | `companion/ForeverDB.AtlasExporter.Core/` |
| Automated tests | `tests/atlas-exporter/` |
| Windows build + smoke workflow | `.github/workflows/atlas-exporter.yml`, `scripts/atlas-exporter-smoke.ps1` |
| Owner instructions shipped with the exe | `companion/ForeverDB.AtlasExporter/README-OWNER.txt` |

## Verification status (read this first)

| Claim | Evidence |
| --- | --- |
| Logic (enumeration, composition, WebP, manifests, resume, cancel, ZIP, determinism) | 59 automated tests against **synthetic** fixtures |
| Windows executable starts, loads CascLib + SkiaSharp, runs the CLI, produces a valid ZIP from a synthetic client | `atlas-exporter.yml` smoke job on `windows-latest` |
| WDC3/4/5 DB2 reader | Implemented from the public format documentation and tested against synthetic files written by the same documentation. **Not yet run against a real client DB2.** |
| Extraction from a real WoW: Forever install | **Not verified** – no agent has access to one. The first owner run is the real E2E test. |

The metadata path therefore has fallbacks (below) so one wrong assumption about the real
DB2 files cannot silently produce an empty or wrong atlas: every source is validated
(table hash, column count against the definition, value ranges) and a failure falls
through to the next source, with the reason recorded in `atlas/build.json`.

## What it exports

For **every** `UiMap` row of the installed build (not only maps the player has visited):

* `world`, `continent`, `zone`, `city`, `instance` (dungeon/raid/battleground/arena/scenario),
  `special` (micro maps, caverns) and `other` (orphan) maps, classified from client metadata
  (`UiMap.Type`, `Map.InstanceType`; the only name-based rule is a short English capital-city
  list, recorded as `categorySource: "name-list"`).
* Alternate art for a map (additional `UiMapXMapArt` phases) as `art<ID>-…` variants.
* Per map and art: `base` (tiles only) and, when the client defines exploration overlays,
  `full-reveal` (overlays from the client's own `WorldMapOverlay*` tables, composed with the
  Companion's verified compositor). Reveal data identical to the Companion's reviewed atlas is
  labelled `client-metadata-matches-reviewed-atlas`.
* Layers: `overview` (lowest layer index = the map's canvas) and `detail` (largest layer, when
  larger). `--all-layers` exports every layer, `--no-detail` only the overview.

Maps with no art are **listed, never invented**: `no-own-art`, `art-incomplete`, or
`inherits-parent` (client flag `FallbackToParentMap`) appear in `atlas/index.json` and
`diagnostics/missing-maps.json`. Maps sharing identical art are exported once; the others get
a manifest with `imageRef` (status `shared-art`).

## Pipeline

```
.build.info ──► product/version/build key (never assumed, never substituted)
      │
      ├─ metadata:  client DB2 (CASC)  ─┐  validated, first success wins
      │             --db2-dir           │
      │             --csv-dir           │  every attempt recorded in build.json
      │             wago.tools CSV (same build number only, cached)
      ▼
MapDatabase ──► MapEnumerator (status, category, hierarchy, alt art, overlays)
      ▼
per art, sequentially, bounded memory:
  tiles (CASC by FileDataID, local first, exact-build CDN second)
  → BLP decode (War3Net, as the Companion) → bounded LRU texture cache
  → compose by RowIndex/ColIndex at (col·tileW, row·tileH), crop to layer extent
  → optional overlay composition → WebP encode → decode back & compare → atomic write
  → manifest.json → resume state
      ▼
atlas/*.json · diagnostics/* · gallery/ · deterministic ZIP
```

### Reused ForeverDB components

| Reused | How |
| --- | --- |
| `NativeCascMapReader.cs` | linked unmodified (CascLib P/Invoke: FileDataID/name open, exact-build online open) |
| `FullRevealMapArt.cs` + `FullRevealOverlays-70009.json` | linked unmodified: transactional overlay composition and the reviewed 84-art atlas used for cross-checking |
| CascLib pinning (`scripts/build-current-casclib.ps1`) | same pinned upstream CascLib build is substituted in the Windows workflow |
| `War3Net.Drawing.Blp` | same BLP decoder and call pattern as `WowClientMapAssetProvider` |
| `.build.info` handling, product/branch mapping, `path*product` storage open, exact-build CDN open | same behaviour as `WowClientMapAssetProvider` (re-implemented platform-neutrally in `Client/`) |
| wago.tools exact-build CSV idea (`AutoAtlasBuildVerifier`) | used as the last-resort metadata source, same host |

Not reused, on purpose: the Companion resolves maps from addon-captured metadata
(`MapMetadataStore`, `MapTracker.lua`) – the exporter enumerates the client's own tables
instead, so unvisited maps are included.

### Metadata and DB2 details

The DB2 container carries no column names. The exporter selects the column layout from the
community **WoWDBDefs** definitions by the file's `LayoutHash` (build range as fallback). The
definition files are downloaded once from `raw.githubusercontent.com/wowdev/WoWDBDefs` into
`%LOCALAPPDATA%\ForeverDB\AtlasExporter\dbd` (or read from `--dbd-dir`). WoWDBDefs data is
CC BY-SA 4.0; it is fetched at run time and **not redistributed** in this repository.
The DB2 files are opened by name (`DBFilesClient\<Table>.db2`) and, if CASC cannot resolve
the name, by the FileDataID from the WoWDBDefs manifest. The header's table hash must equal
the known hash of the requested table.

Tables: required `UiMap`, `UiMapXMapArt`, `UiMapArt`, `UiMapArtStyleLayer`, `UiMapArtTile`;
optional `UiMapAssignment` (world bounds), `UiMapLink`, `Map` (instance type), `WorldMapOverlay`,
`WorldMapOverlayTile` (full reveal). Missing optional tables degrade labelling only and are
reported in `atlas/build.json`.

## Output (interchange format)

Matches the requested structure; it is **not** the final CDN path.

```
ForeverDB-Atlas-Export/
  atlas/index.json          every map: ids, names, category, status, variants, image records
  atlas/hierarchy.json      roots, nodes (depth/children), orphans, cycles, UiMapLink links
  atlas/build.json          detected client, metadata source and every attempt, encoder, options
  atlas/export-report.json  counts, categories, Cloudflare Pages Free fit, limitations
  maps/<uiMapID>/<variant>/overview.webp [detail.webp | layer-N.webp]
  maps/<uiMapID>/<variant>/manifest.json
  diagnostics/export-summary.txt  missing-maps.json  extraction-errors.json
  diagnostics/regression-1420.json  run-info.json (only volatile file)
  gallery/index.html + thumbs/    offline contact sheet
  README.txt
```

`<variant>` is `base` / `full-reveal` for the map's primary art and `art<UiMapArtID>-base` /
`art<UiMapArtID>-full-reveal` for alternates.

Every image record carries: path, **actual** width and height, byte size, SHA-256, format
(`webp`), layer index, tiles placed/expected, and (in the manifest) client product, version,
build key, `uiMapId`, `UiMapArtID` (`mapArtId`), phase, art variant, reveal status, encoder
settings. Each image is decoded again after writing and compared with its source (mean error
≤ 12/255 lossy, ≤ 1 lossless, alpha checked).

### Manifest ⇄ P2-D compatibility

`maps/<id>/<variant>/manifest.json` keeps the P2-D proof-of-concept manifest field names
(`schemaVersion`, `zoneId`, `slug`, `zoneName`, `version`, `image{file,format,width,height,bytes,sha256}`,
`projection`, `provenance`, `calibration`) and adds `uiMapId`, `variant`, `category`, `images[]`,
`imageRef`, `extent`, `status`, `problems`. To produce the CDN layout `forever/<uiMapID>/v1/`:
copy `overview.webp` to `<slug>.webp` (or keep the name and update `image.file`), keep
`manifest.json`; skip `status != exported|reused|shared-art|partial`; resolve `imageRef` aliases
to the owner's file.

### Coordinates and calibration

* Projection is the Companion/AzerDex model: `pixelX = imageWidth·xPercent/100`,
  `pixelY = imageHeight·yPercent/100`, origin top-left, y down. Tiles are placed from their
  `RowIndex/ColIndex` records (row 0 = top), never from list order.
* The image is the client's complete `UiMapArtStyleLayer` canvas: no crop beyond removing
  padding of power-of-two textures, no rescale. Different maps/layers have different sizes.
* **Calibration is `provisional` for every map.** Registration of percent coordinates against
  landmarks is not verified by the exporter. `UiMapAssignment` world bounds are listed in
  `calibration.worldBounds` for later calibration.
* Tirisfal Glades (uiMapID 1420) is compared with the P2-D reference in
  `diagnostics/regression-1420.json` (expected 1002×668, aspect, optional pixel error via
  `--reference-1420 <file>`). P2-D's marker projection code is untouched.

## Resources, safety, resume

* One map canvas in memory at a time; decoded textures live in a bounded LRU (96 MiB default);
  identical FileDataIDs are read/decoded once; canvases above 8192² are refused.
* The WoW files are opened read-only. The exporter writes only to `--output`, its ZIP beside it,
  and `%LOCALAPPDATA%\ForeverDB\AtlasExporter` (definition/CSV/CDN cache, never packaged).
* A failing map is recorded and skipped; the rest continues. `Ctrl+C` finishes the current map,
  saves state and exits 130. `--resume` verifies finished files by size and SHA-256 and re-does
  only failed, changed (art fingerprint) or setting-changed items. `--force` starts over.
* Exit codes: `0` complete, `1` error, `2` partial, `3` nothing exported, `130` cancelled.
  An empty or unreadable client is always an error, never a success.
* Output is deterministic (sorted, fixed ZIP timestamps, no volatile data except
  `diagnostics/run-info.json`).

## Limitations (known)

1. Not yet verified against a real WoW: Forever install (see status table).
2. Maps whose tiles exist neither locally nor on the exact-build CDN fail (listed per map);
   `--allow-partial` keeps them with transparent holes, labelled `partial`.
3. Fully-revealed art exists only where the client defines `WorldMapOverlay` data; overlays
   with a `PlayerConditionID` are included (a fully revealed map shows all of them).
4. `city` relies on a short English name list; instances rely on `Map.InstanceType` (needs the
   optional `Map`/`UiMapAssignment` tables).
5. "Forever-specific" content cannot be identified automatically; `artNotInReviewedAtlas` in the
   index only flags arts outside the Companion's 84-art classic atlas.
6. Encrypted DB2 sections and variable-length DB2 tables are not decoded (reported).
7. Calibration is provisional everywhere.

## Troubleshooting

See `README-OWNER.txt`. For developers: `diagnostics/extraction-errors.json` lists every problem
per variant; `atlas/build.json` lists every metadata source attempt and why it failed;
`--scan-only` exercises discovery and metadata without exporting;
`--selfcheck` verifies that CascLib and the WebP encoder load.

## Building

```
dotnet test-equivalent:   dotnet run --project tests/atlas-exporter/Atlas.Exporter.Tests.csproj
Windows build:            GitHub Actions → "Atlas Exporter (Windows)" → artifact ForeverDB-AtlasExporter-win-x64
Local (Windows):          dotnet restore -r win-x64; ./scripts/build-current-casclib.ps1;
                          dotnet publish companion/ForeverDB.AtlasExporter -c Release -r win-x64 --self-contained true --no-restore -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true
Synthetic client:         dotnet run --project tests/atlas-exporter -- --make-fixture <dir>
```
