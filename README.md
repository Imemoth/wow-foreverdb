# WoW ForeverDB

Observed loot, gathering, fishing, GameObject and disenchant database for World of Warcraft: Forever, with an in-game collector and a Windows Companion application.

## Current versions

| Component | Version |
| --- | --- |
| Addon | **0.7.1-alpha** |
| SavedVariables / export schema | **9** |
| Forever interface target | **16001** |
| Companion | **0.9.1-alpha** |

Version sources and release rules are documented in [docs/VERSIONING.md](docs/VERSIONING.md). Release history is kept in [CHANGELOG.md](CHANGELOG.md).

## Addon collector

The collector distinguishes two dimensions:

1. **Loot source**
   - creature / mob
   - skinning
   - mining GameObject
   - herbalism GameObject
   - fishing, split by zone / uiMapID
   - fishing pools
   - chest/container GameObject
   - disenchant item source
   - other GameObject

2. **Looted item metadata**
   - item ID and name
   - drop occurrence
   - total quantity
   - quest-item flag
   - quest ID when exposed by the client

GameObjects are stored with their numeric GameObject ID and observed name, so
different chest/node types can be distinguished in the database.

## Windows addon updater

From the repository root, run `update-addon.cmd`. It fetches the latest **release** commit and installs the addon into the single detected `*forever*` client under `World of Warcraft`. It never auto-selects `_classic_beta_`; multiple Forever clients require an explicit path. The script does not touch `WTF` or SavedVariables.

For Quest Tracker V1 testing before PR #168 is merged, run:

```cmd
update-addon.cmd -Ref feat/quest-tracker-v1-local-capture -AddOnsPath "C:\Path\To\World of Warcraft\_classic_forever_\Interface\AddOns"
```

`-Ref` also accepts a pinned 40-character commit SHA. The folder name may differ, but the client folder must contain `forever`. Direct PowerShell use: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\update-addon.ps1 -Ref feat/quest-tracker-v1-local-capture -AddOnsPath "C:\...\Interface\AddOns"`. The updater prints the selected ref, SHA, TOC version and destination, and validates Core/TOC versions before replacing files. Check the printed version is `0.6.1-alpha`; in the Forever client run `/reload` and `/fdb quest status`. See [Quest V1 live acceptance](docs/quest-tracker/v1-acceptance.md).

## In-game commands

- `/fdb status`
- `/fdb last`
- `/fdb export`
- `/fdb item <itemID or item link>`
- `/fdb guild` — short alias for the non-persistent Guildbook capability probe
- `/fdb guildbook refresh` — explicitly capture the current guild roster/professions locally; wait for capture, then `/reload` or log out/exit to commit WoW SavedVariables before using Guildbook **Refresh data** in Companion
- `/fdb recipe <profession>` — recipe probe for the current character
- `/fdb recipe <member> <profession>` — targeted guild-member recipe/crafter probe
- `/fdb gr ...` — short alias for `/fdb recipe ...`
- secondary professions are accepted too: `cooking`/`cook`, `fishing`/`fish`, `first aid`/`fa`
- legacy diagnostic aliases `/fdb guildapi` and `/fdb guildrecipe ...` remain supported
- `/fdb debug`

## Repository

- `addon/ForeverDB/` - in-game collector
- `companion/ForeverDB.Companion/` - Windows Companion
- `database/migrations/` - Supabase/PostgreSQL schema
- `installer/` - Companion installer definition
- `scripts/` - development/build tooling
- `docs/` - data contract, sync/map architecture, acceptance notes, [development roadmap](docs/ROADMAP.md) and [Guildbook API research](docs/GUILDBOOK-API.md)

## Item tooltips

Item tooltips show a compact local ForeverDB source summary:

- top 3 observed sources by default
- hold Alt for top 5
- source category such as Mob, Skinning, Mining, Herbalism or Chest
- observed drop percentage and sample size
- no raw GUIDs in the tooltip

Source ordering uses a sample-size-aware Wilson lower-bound score so a single
1/1 observation does not automatically outrank a well-sampled source.

For the full local list use:

`/fdb item <itemID or item link>`

## Creature level separation

Creature loot is keyed by **NPC ID + exact creature level**. A level 6 and
level 7 creature with the same NPC ID are separate statistical sources and
their drop counts are never merged.

Historical observations collected before schema 5 cannot be reconstructed by
level and are retained under `Lvl ?` / source level 0. New observations never
write into that historical bucket.

## Fishing zone separation

Fishing observations are not keyed by the temporary bobber GameObject. They are
stored as a virtual source keyed by the current zone's `uiMapID`, for example:

- `Fishing - Tirisfal Glades`
- `Fishing - Silverpine Forest`

Each zone has independent observation counts and item rates. Historical fishing
data collected before schema 6 cannot be assigned to a zone and is preserved as
`Fishing - Unknown zone (historical)`.

## Item tooltip source granularity

Creature sources remain separate by exact level in item tooltips. For example,
level 6 and level 7 Greater Duskbat can appear as separate Top-source rows.
Historical `Lvl ?` creature rows are hidden once exact-level observations for
that NPC/item exist, avoiding duplicate-looking aggregated legacy data.

## Location observations

Every observed loot source can also record location metadata in the background:

- uiMapID
- zone name
- subzone name
- x/y player position

Coordinates are quantized to a 0.5% map grid and aggregated with observation
counts. This keeps SavedVariables compact while preserving enough resolution
for zone maps and heatmaps.

Location data is not shown in normal in-game tooltips.


Guildbook V1 runtime acceptance: [Guildbook V1 acceptance](docs/0.8-guildbook-acceptance.md).
