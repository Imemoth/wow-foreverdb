# ForeverDB Companion

Windows companion application for ForeverDB.

## Current prototype

The companion is a .NET 8 WPF application with:

- system tray operation
- optional Windows startup
- optional start-minimized behavior
- automatic WoW Forever path detection
- recursive SavedVariables watcher
- automatic upload after /reload, logout or client exit
- Supabase anonymous authentication
- per-user encrypted local auth session
- authenticated ForeverDB snapshot ingest
- basic item/source search UI

## Supabase requirement

Before the authenticated sync can work:

1. apply database/migrations/0002_sync_safety.sql
2. apply database/migrations/0003_companion_auth.sql
3. enable Anonymous Sign-Ins in Supabase Authentication settings

Do NOT apply 0004_remove_legacy_ingest.sql until the companion sync has been
validated successfully.

## Development build

On Windows with .NET 8 SDK:

    dotnet build companion/ForeverDB.Companion/ForeverDB.Companion.csproj

Run:

    dotnet run --project companion/ForeverDB.Companion/ForeverDB.Companion.csproj

On first launch, open Settings and configure the Supabase publishable/anon key.
The project URL defaults to the current ForeverDB Supabase project.

## Distribution plan

The final release should be published as a self-contained Windows build and
wrapped in a small installer. The installer can offer:

- Launch with Windows
- Start minimized
- Desktop shortcut

The companion itself keeps the startup setting under the current user's Windows
Run registry key.
