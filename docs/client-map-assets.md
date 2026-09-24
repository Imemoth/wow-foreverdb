# ForeverDB client map asset plan

ForeverDB Companion will use map artwork from the user's installed WoW Forever
client rather than download or redistribute Blizzard map textures.

## Data flow

1. The addon records the current uiMapID.
2. MapTracker.lua queries the WoW client for:
   - map name and parent map
   - map art ID
   - map art layer dimensions
   - map tile FileDataIDs
3. The exporter writes this metadata as M and A records.
4. The Companion parses and caches the metadata under
   %LOCALAPPDATA%\ForeverDB\maps.
5. The map asset provider will open the local WoW CASC storage, read the
   referenced FileDataIDs, decode the BLP tiles and assemble a cached local map
   image.
6. Marker, cluster and heatmap layers are rendered above that cached image.

## Implementation choice

The first provider is WowClientMapAssetProvider.

Candidate components:
- CascLib / a .NET 8 CascLib wrapper for local CASC reads by FileDataID.
- BLPSharp for .NET 8 BLP decoding.

Both dependencies must be pinned to explicit versions before being added to the
release build.

## Distribution rule

Do not bundle Blizzard map texture files with ForeverDB releases. The Companion
extracts and caches the required tiles locally from the user's own WoW
installation.

## Fallback

If local map extraction fails or an art layer is unavailable, the Companion
continues to show the existing normalized 0-100 coordinate grid. Location data
and search remain usable without artwork.
