# ForeverDB Companion

Windows companion application for ForeverDB.

## Current alpha

ForeverDB Companion **0.7.0-alpha** is a .NET 8 WPF application with:

- single-instance system tray operation
- optional Windows startup / start minimized
- automatic WoW Forever path detection
- SavedVariables watcher and automatic authenticated sync
- Supabase anonymous authentication with an encrypted local session
- item and source search
- item/source detail navigation with Back / Forward / breadcrumb history
- acquisition tabs for loot, skinning, mining, herbalism, fishing, pools,
  gameobjects and disenchant
- location coordinates and an interactive multi-zone map viewer
- WoW CASC map extraction with BLP tile stitching and PNG cache
- local-first map resolution with exact-build Blizzard CDN fallback for streamed tiles
- markers, weighted clusters and heatmap overlays with zoom/pan
- local cache for WoW client map-art metadata and map-resolution results
- background pre-warming for recently observed zones
- sample-quality and quest metadata
- manual GitHub Actions build and Inno Setup installer workflows

Search results intentionally show item names without an Item # prefix. IDs remain
available in detail metadata where they are useful for diagnostics.

## Map assets

The selected map source is the user's installed WoW Forever build.

Addon schema 8 exports the client-provided uiMapID, MapArtID, art-layer dimensions
and tile texture references. The Companion caches that metadata locally.

Map resolution is **local-first**. The Companion first opens the matching local
WoW CASC product. If a referenced map tile is part of the installed build but is
not present on disk, CascLib can open that exact build from Blizzard's CDN and
cache the streamed CASC data under `%LOCALAPPDATA%\ForeverDB\casc-cache`.

ForeverDB does not redistribute Blizzard map artwork through Supabase.

If map art still cannot be resolved or decoded, the map viewer falls back to the
normalized coordinate grid while keeping markers, clusters and heatmaps
available.

See [docs/client-map-assets.md](../docs/client-map-assets.md).

## Supabase

The public Companion API uses:

- anonymous Supabase Auth for installation identity
- the authenticated `ingest_foreverdb_snapshot_auth` RPC
- security-invoker public RPC wrappers for aggregate search/location queries
- deny-by-default RLS on raw installation statistics

The old shared ingest-token path has been removed.

## Development build

On Windows with .NET 8 SDK:

    dotnet build companion/ForeverDB.Companion/ForeverDB.Companion.csproj

Run:

    dotnet run --project companion/ForeverDB.Companion/ForeverDB.Companion.csproj

## Build artifact

Use the manual GitHub Actions workflow:

    Build ForeverDB Companion

It publishes a self-contained `win-x64` artifact named:

    ForeverDB-Companion-win-x64

## Installer

Use the manual GitHub Actions workflow:

    Build ForeverDB Installer

It publishes the same self-contained `win-x64` application and packages it as
a per-user installer under `%LOCALAPPDATA%\Programs\ForeverDB`.
Administrator privileges are not required.

The installer can optionally create a desktop shortcut and a Windows startup
entry. Code signing is still required before public distribution to remove the
unknown-publisher / low-reputation warning.
