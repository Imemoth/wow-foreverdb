# WoW ForeverDB

Community-observation loot and skinning database project for World of Warcraft: Forever.

## Current phase

Phase 1 focuses on the in-game addon and its data contract. The website and public search UI are intentionally deferred until the addon can collect reliable observations on the Forever beta client.

## Planned components

- `addon/ForeverDB/` - WoW Forever addon (Lua)
- `database/migrations/` - PostgreSQL/Supabase schema migrations
- `docs/` - data model, API assumptions, and beta test notes

## Beta target

Current Forever beta packages are targeting game version `1.60.1`; the addon interface value is kept explicit in the `.toc` and must be re-verified when the beta build changes.
