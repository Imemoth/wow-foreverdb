# P2-D — WoW: Forever map atlas: acquisition & packaging

Phase status: acquisition tooling tested on synthetic fixtures; **the owner's real export (ForeverDB.AtlasExporter ZIP, client 1.60.1.70450) is imported by `atlas.py import-exporter`** (below). Upload preflight/rollback: [`map-atlas-cdn-deploy.md`](map-atlas-cdn-deploy.md).
Nothing here deploys anything. The package it produces is prepared for a *later, owner-approved* upload to the existing Cloudflare Pages project `azerdex-assets`.

## What it does
`scripts/map-atlas` reads the **installed client's** map metadata (DB2) and textures (BLP), assembles every drawable map exactly as the Companion does, validates the images, assigns immutable versions, and writes one self-contained `dist/`:

```
dist/
  _headers                       Cache-Control: immutable for /forever/*, short for /atlas/*, CORS *
  atlas/index.json               every UiMap: availability, versions, latest manifest/image; lookups by parent/type/category/name/build/availability
  atlas/hierarchy.json           parent→child tree of all UiMaps (+ detected hierarchy faults)
  atlas/builds.json              client builds seen (product, version, build key, tool/Pillow/libwebp versions, DB2 export hashes)
  forever/{uiMapID}/{vN}/manifest.json
  forever/{uiMapID}/{vN}/overview.webp          primary art (largest usable layer of the first variant)
  forever/{uiMapID}/{vN}/layer-{n}.webp         other layers of that variant
  forever/{uiMapID}/{vN}/variant-{MapArtID}[-layer-{n}].webp   phased / alternate art
```
The path is the existing `resolveMapAssetUrl` contract (`/forever/{uiMapID}/{version}/{filename}`). **`forever/1420/v1` is the immutable POC asset** (byte-identical, protected by the ledger and a test); an exported Tirisfal becomes `v2`.

## Pipeline & identifiers
| Stage | Source of truth | Notes |
| --- | --- | --- |
| Build identity | `.build.info` (`Product`, `Version`, `Build Key`) | product `wow_classic_beta` (the Forever product the Companion already uses); refuses ambiguous/inactive rows; optional `--expect-version`. `1.60.1.70450` is only *reported against*, never assumed |
| Map enumeration | DB2 CSV exports for the **exact build** (`https://wago.tools/db2/{Table}/csv?build={version}`, same source as `AutoAtlasBuildVerifier`) | `UiMap`, `UiMapXMapArt`, `UiMapArt`, `UiMapArtStyleLayer`, `UiMapArtTile` required; `UiMapAssignment`, `Map`, `UiMapGroupMember`, `AreaTable`, `WorldMapOverlay(Tile)` optional context |
| Textures | client CASC via `CascLib.dll`, by FileDataID | same calls as `NativeCascMapReader.cs` |
| Assembly | tile `(row,col)` → `(col·TileWidth, row·TileHeight)` on a transparent `LayerWidth×LayerHeight` canvas, cropped to the layer | identical to `WowClientMapAssetProvider`; alpha copied verbatim; **missing/corrupt tiles are never painted over** |

Identifiers are never mixed: `uiMapID` (UiMap.ID, the directory name) ≠ `MapArtID` (UiMapArt.ID) ≠ style id ≠ instance `MapID` (recorded as `mapIds`) ≠ FileDataID.
A map is **drawable** only if some variant has a layer with dimensions *and* tiles; entries without own art (areas/sub-zones/cosmic parents) are listed with the reason, not exported.

## Running it on the owner's Windows PC
Prerequisites: 64-bit Python ≥ 3.11, `pip install -r scripts/map-atlas/requirements.txt`, the WoW: Forever client installed/updated, and `CascLib.dll` (run `scripts/build-current-casclib.ps1` once, as for Companion builds, or pass `--casclib`). Outbound access to `wago.tools` is needed for the DB2 step.

```powershell
$bundle = "D:\atlas\bundle"; $out = "D:\atlas\out"; $wow = "C:\Program Files (x86)\World of Warcraft\_classic_beta_"
python scripts\map-atlas\atlas.py identity  --wow-root $wow --bundle $bundle          # writes build.json — check the version
python scripts\map-atlas\atlas.py fetch-db2 --bundle $bundle                          # exact-build DB2 CSVs + hashes
python scripts\map-atlas\atlas.py extract   --wow-root $wow --bundle $bundle          # every needed BLP, resumable; misses listed in blp\_extract.json
python scripts\map-atlas\atlas.py build     --bundle $bundle --out $out `
    --baseline-db2 D:\atlas\classic-era-db2                                           # optional: lists maps new/changed vs another build
python scripts\map-atlas\atlas.py verify-dist --dist $out\dist --ledger $out\ledger.next.json
```
Review `…\out\reports\coverage.md` and open `…\out\preview\index.html` (offline contact sheet: name, uiMapID, type, parent, size, warnings). Raw bundles (`*.blp`, CSVs) and the whole `out` folder stay **outside Git**; deliver `atlas-dist-<version>.zip` separately.

### Later snapshots (never drop or overwrite published maps)
Cloudflare Pages Direct Upload deploys a *complete snapshot*. After the owner has uploaded a dist, run `promote-ledger --from out\ledger.next.json` (append-only; refuses any change/removal) and commit `scripts/map-atlas/ledger/published.json`. The next build must pass `--previous-dist <the published dist>`: every ledger version is carried forward byte-for-byte, and the build **fails** if one is missing or altered. Changed pixels always get a new `vN`; unchanged pixels reuse theirs.

## Validation, and what is only flagged
Per image: dimensions/aspect vs the layer, blank, fully transparent, >50 % transparent (warn), tile-seam/misorder score (warn), WebP re-decode + size + alpha + error vs source. Across maps: identical pixels under different uiMapIDs. Per build: hierarchy faults (missing parent, cycles), unknown map types, missing/corrupt tiles (by FileDataID), and the **Forever-zone check** (Zephras Isle, Riverglades, Shen'dralas, Mount Hyjal are looked up by name in the *client's own* UiMap data; absent ⇒ `not-found-in-client-metadata`, never faked). `--allow-partial` keeps incomplete maps, flagged `partial` and still transparent where tiles are missing; the default excludes them.

## Coordinates and calibration
Manifests carry the accepted model (`pixelX = width·x/100`, `pixelY = height·y/100`, top-left). **No exported map is ever `calibration: validated`**: all are `provisional`. For uiMapID 1420 the build compares the export with the supplied 1002×668 reference (dimensions, aspect, best alignment shift in a ±6 px window at 256 px width, mean error) and records `matches-reference | cropped-or-shifted | differs` under `calibration.registration` as **evidence only** — no transformation is applied without owner-reviewed landmark evidence.

## Limits (Cloudflare Pages Free)
≤ 20,000 files and ≤ 25 MiB per file, plus the CDN path convention, are enforced in every build and by `verify-dist`; the report records the actual counts/sizes. One WebP per art variant/layer (no tiling) keeps the file count to roughly the number of maps; very large world art is exported as a single overview image (optional tiled representation is a follow-up).

## Not verified against a real client (read before trusting a first real run)
This repository's tests use a synthetic client (real BLP2/DXT1 tiles, DB2-shaped CSVs). Specifically **unverified**:
1. The exact CSV headers of the live exports. Required names follow the Companion's `AtlasMetadataVerifier` where it already reads them (`WorldMapOverlay*`, `UiMapArt`, `UiMapArtStyleLayer`); `UiMapArtTile` (`UiMapArtStyleID, LayerIndex, RowIndex, ColIndex, FileDataID`), `UiMapXMapArt`, `UiMap` (`Name_lang, ParentUiMapID, Type`), `Map.InstanceType`, `UiMapGroupMember.FloorIndex` are from general DB2 knowledge. Columns are matched by name; a mismatch fails loudly with the headers found (fix the alias in `csvtables.SPECS`).
2. `CtypesCasc` against a real `CascLib.dll`/install (mirrors proven C# P/Invoke calls; the loop is tested with a fake backend).
3. Pillow decoding of the client's real BLP2 files (it supports palette, DXT1/3/5 and raw BGRA; DXT-with-mipmaps/large tiles untested here).
4. Whether Forever's world/continent art is a single layer or needs the optional tiled representation; full-reveal `WorldMapOverlay` layers are recorded in the report but **not composited** (base art only).
5. City maps cannot be separated from other zone maps: the client metadata used has no verified city discriminator, so the report says so instead of guessing.


## Importing a ForeverDB.AtlasExporter ZIP (`import-exporter`)
The Windows exporter already produced final WebP images and metadata, so this path needs **no DB2, CASC, Wago or BLP decoding** and works offline:

```
python scripts/map-atlas/atlas.py import-exporter --zip ForeverDB-Atlas-Export-<build>.zip --out <out> \
   --expect-version 1.60.1.70450 --expect-maps 60 --expect-variants 105 --expect-instances 55 --expect-zip-sha256 <sha256> \
   [--previous-dist <last published dist>] [--ledger scripts/map-atlas/ledger/published.json]
```
The acquisition commands (`identity`, `fetch-db2`, `extract`, `build`, `verify-dist`, `promote-ledger`) are unchanged.

**Validation (the archive is untrusted; nothing is extracted to disk).** Refused, with every problem listed: unsafe/absolute/backslash/drive paths, duplicate or case-conflicting entries, symlinks, encrypted/oversized/bomb-like members, CRC errors, missing/changed/non-WebP images, wrong size/hash/dimensions, id/slug/name/category/parent/variant/build/internalMapId disagreements between `index.json`, each variant manifest, `build.json`, `hierarchy.json` and `instances.json`, a non-`provisional` calibration or non-accepted projection, incomplete tiles, `partial`/`failed` variants, `partial-overlays` reveals, a full-reveal byte-identical to its base, unreferenced files under `maps/`, and anything that is not a **complete** export: status other than exactly `COMPLETE` (a filtered run says `COMPLETE (FILTERED RUN …)`), `mapsSkippedByFilter`, `allowPartial`, no full-reveal pass, or `UiMap` table rows ≠ listed maps.

**Packaging.** Images are copied byte-for-byte (never re-encoded), one file per variant, named `{variant}.webp` (`base.webp`, `full-reveal.webp`); the manifest's `image` is the explicit default display image: a full-reveal that matches the reviewed atlas and is `complete` (or only skips tile-less declared overlays), otherwise base. Base is never labelled full-reveal; unaccepted reveals are still stored, flagged, but not the default. Identical bytes inside one map are stored once and referenced twice. Manifests keep `schemaVersion: 1` and are a strict superset of the web contract (`variants[]`, `defaultImage`, `internalMapId`, `mapArtIds`, reveal metadata, classification evidence, world bounds, client build, provenance); `floor` stays `null` (no verified floor data).

**Versions are keyed on the complete asset set** (`assetSetSha256` = every stored file's bytes + the manifest's material content, excluding the version, client build and provenance-only labels). A change to a full-reveal, an alternate variant or any material metadata therefore allocates the next version instead of hiding inside an old one; an unchanged source reuses its versions (idempotent, also fully offline), and published bytes are never rewritten.

**Catalog.** `atlas/index.json` lists maps (`availability`: `available`, `no-artwork`, `published-earlier`) and says nothing about observations; `atlas/hierarchy.json` is the exporter's tree with availability; `atlas/instances.json` is the raw instance catalog kept apart from the map index (`mapId` is the internal Map ID, never a uiMapID; no fake UiMapIDs; `catalog.releaseStatus: "unverified"`, `visibility: "unreviewed"`, transparent `developmentFlags` heuristics); `atlas/builds.json` records builds, source ZIP hash, exporter and tool versions.

**Review package** written beside `dist/`: `reports/` (coverage, asset inventory JSON+CSV, instance catalog, Tirisfal regression, category/full-reveal availability, ledger proposal), `preview/index.html` (offline gallery), `ledger.next.json` (proposal — never promoted automatically), `atlas-dist-<build>.zip` (deterministic), `SHA256SUMS.txt`, `dist-files.json`.

**Acceptance against the real export** is local-only (the ZIP is private artwork): `ATLAS_REAL_EXPORT_ZIP=… python -m unittest test_real_source` (Python), `ATLAS_REAL_DIST=<out>/dist npx vitest run tests/unit/map-atlas-contract.test.ts` and `npx playwright test maps-poc-atlas` (same-origin), and the cross-origin CDN/CSP/CORS suite `playwright.atlas-cdn.config.ts` (needs a build made with `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://azerdex-assets.pages.dev`).
