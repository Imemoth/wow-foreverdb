# ForeverDB client map assets

ForeverDB Companion uses map artwork from the user's installed WoW Forever
client. Blizzard map textures are not redistributed with ForeverDB.

## Data flow

1. The addon records the current uiMapID for every location observation.
2. MapTracker.lua captures:
   - map name and parent map
   - MapArtID
   - map art layer dimensions
   - map tile texture references
3. The exporter writes map metadata as M and A records.
4. The Companion stores the metadata under:
   %LOCALAPPDATA%\ForeverDB\maps
5. WowClientMapAssetProvider locates the parent WoW CASC installation.
6. Map tiles are opened from local CASC storage by FileDataID or texture path.
7. BLP tiles are decoded and stitched into a cached PNG.
8. Location markers, clusters and heatmaps are rendered above the local map.

## Pinned dependencies

The Companion currently pins:

- CascLib 1.0.23 for local WoW CASC reads.
- BLPSharp 0.1.0 for BLP texture decoding.

No online CASC fallback is enabled. Map extraction is local-only.

## CASC product detection

The Companion derives a product candidate from the configured WoW branch path
and then tries known WoW product IDs such as wow_classic_beta, wow_classic and
wow. The CASC root is discovered by walking upward until .build.info is found.

## Cache

Assembled maps are cached per uiMapID / MapArtID / art layer. Once a map is
successfully assembled, later previews load the cached PNG instead of reopening
the WoW archive.

## Rendering

The map control supports:

- normalized x/y markers
- weighted grid clustering
- heatmap overlay
- mouse-wheel zoom
- click-drag pan
- Fit-to-view
- loot-kind marker colors

Clustering weights location coordinates by observation count. The heatmap is
also observation-weighted, so a location seen many times has more visual weight
than a one-off observation.

## Fallback

If local CASC access or BLP decoding fails, ForeverDB continues to display the
normalized coordinate grid. Search, locations, markers, clusters and heatmaps
remain usable without the map artwork.

The map control surfaces the extraction status so failures can be diagnosed
without breaking the rest of the Companion.
