# ForeverDB Companion

Windows companion application for ForeverDB.

## Current alpha

ForeverDB Companion 0.5.0-alpha is a .NET 8 WPF application with:

- single-instance system tray operation
- optional Windows startup / start minimized
- automatic WoW Forever path detection
- SavedVariables watcher and automatic authenticated sync
- Supabase anonymous authentication with an encrypted local session
- item and source search
- item/source detail navigation with Back / Forward / breadcrumb history
- acquisition tabs for loot, skinning, mining, herbalism, fishing, pools,
  gameobjects and disenchant
- location coordinates and map marker preview
- local cache for WoW client map-art metadata
- sample-quality and quest metadata
- a manual Inno Setup installer workflow

Search results intentionally show item names without an Item # prefix. IDs remain
available in detail metadata where they are useful for diagnostics.

## Map assets

The selected map provider is the user's installed WoW Forever client.

Addon schema 8 exports the client-provided uiMapID, MapArtID, art-layer dimensions
and FileDataIDs. The Companion caches that metadata locally. The current map
preview falls back to the normalized coordinate grid until the local CASC + BLP
extraction provider is connected.

See docs/client-map-assets.md.

## Supabase

The public Companion API uses:

- anonymous Supabase Auth for installation identity
- an authenticated ingest RPC
- security-invoker public RPC wrappers for aggregate search/location queries
- deny-by-default RLS on raw installation statistics

The old shared ingest-token path has been retired.

## Development build

On Windows with .NET 8 SDK:

    dotnet build companion/ForeverDB.Companion/ForeverDB.Companion.csproj

Run:

    dotnet run --project companion/ForeverDB.Companion/ForeverDB.Companion.csproj

## Installer

Use the manual GitHub Actions workflow:

    Build ForeverDB Installer

It publishes a self-contained win-x64 build and packages it as a per-user
installer under %LOCALAPPDATA%\Programs\ForeverDB. Administrator privileges are
not required.

The installer can optionally create a desktop shortcut and a Windows startup
entry. Code signing is still required before public distribution to remove the
unknown-publisher warning.
