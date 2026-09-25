# ForeverDB client map assets

ForeverDB Companion uses map artwork belonging to the user's exact installed WoW
Forever build. ForeverDB does not redistribute Blizzard map textures through
Supabase.

## Data flow

1. The addon records the current uiMapID for location observations.
2. `MapTracker.lua` captures:
   - map name and parent map
   - MapArtID
   - map art layer dimensions
   - map tile texture references / FileDataIDs
3. The exporter writes map metadata as `M` and `A` records.
4. The Companion stores the metadata under:
   `%LOCALAPPDATA%\ForeverDB\maps`
5. `WowClientMapAssetProvider` locates the matching WoW CASC installation/build.
6. The resolver first attempts the exact local WoW product.
7. If referenced tiles are streamed/not present locally, the resolver can open
   the exact installed build from Blizzard's CDN via CascLib and cache CASC data
   under `%LOCALAPPDATA%\ForeverDB\casc-cache`.
8. BLP tiles are decoded and stitched into a cached PNG.
9. Location markers, clusters and heatmaps are rendered above the map.

## Pinned dependencies

The Companion currently pins:

- CascLib.NET `1.50.0.206-alpha.3` as the managed/package baseline.
- Upstream CascLib native runtime commit
  `2a280f5a231966dc5d1b534978dd9f9f04a374cd` during CI publish.
- War3Net.Drawing.Blp `6.0.2` for BLP1/BLP2 texture decoding.

The package-bundled CascLib native DLL is replaced during the Windows build
because the current resolver requires newer CascLib behavior for product
selection and streamed/missing-file access.

The build step is implemented by `scripts/build-current-casclib.ps1`.

## CASC product/build detection

The Companion derives the expected product from the configured WoW branch path
(for example `_classic_beta_` -> `wow_classic_beta`) and also reads active
products/build keys from `.build.info`.

Resolution order is:

1. exact local product + exported FileDataID/texture reference;
2. exact active installed build through Blizzard CDN;
3. compatibility fallback using classic `Interface\WorldMap\...` texture paths.

The CDN path is used only for Blizzard CASC data belonging to the matching WoW
build; ForeverDB does not host or proxy those assets.

## Cache

Assembled maps are cached per uiMapID / MapArtID / art layer. Once a map is
successfully assembled, later previews load the cached PNG instead of reopening
CASC.

The resolver also stores success/failure resolution state and the preferred
storage source. Failed expensive work is not repeated on every navigation event.

Changing the resolver version invalidates resolution-state cache entries for a
controlled retry.

## Rendering

The map control supports:

- normalized x/y markers
- weighted grid clustering
- heatmap overlay
- mouse-wheel zoom
- click-drag pan
- Fit-to-view
- loot-kind marker colors
- switching between zones from location rows

Clustering weights locations by observation count. The heatmap is also
observation-weighted, so repeatedly observed locations carry more visual weight
than one-off observations.

## Fallback

If local/CDN CASC access or BLP decoding fails, ForeverDB continues to display
the normalized coordinate grid. Search, locations, markers, clusters and heatmaps
remain usable without the map artwork.

The map control surfaces the extraction status so failures can be diagnosed
without breaking the rest of the Companion.

## Diagnostics

Fresh map-resolution attempts send a sanitized diagnostic record to Supabase.
The record contains map IDs, MapArtID, texture references, installed
product/build metadata, resolver status, duration and selected storage/asset
mode.

The diagnostic payload intentionally does not include the user's Windows
username, full local filesystem path, or arbitrary personal file contents.
Clients only have INSERT permission on their own diagnostic rows; they cannot
read the table through the Data API.

Failed local/remote resolution results are cached locally so revisiting the same
map does not repeatedly scan/open CASC.

## Native CascLib runtime

The Windows publish workflow compiles the pinned upstream CascLib commit and
replaces the native DLL bundled with CascLib.NET before publishing the Companion.

This native runtime is intentionally newer than the managed package baseline.
It is required by the current Forever resolver for modern Blizzard CASC handling,
including exact-build streamed map tiles.
