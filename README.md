# WoW ForeverDB

Observed loot, gathering and skinning database for World of Warcraft: Forever.

## Collector alpha

Current addon version: **0.2.2-alpha**  
Forever interface target: **16001**

The collector distinguishes two dimensions:

1. **Loot source**
   - creature / mob
   - skinning
   - mining GameObject
   - herbalism GameObject
   - chest/container GameObject
   - other GameObject

2. **Looted item metadata**
   - item ID and name
   - drop occurrence
   - total quantity
   - quest-item flag
   - quest ID when exposed by the client

GameObjects are stored with their numeric GameObject ID and observed name, so
different chest/node types can be distinguished in the database.

## In-game commands

- `/fdb status`
- `/fdb last`
- `/fdb export`
- `/fdb debug`

## Repository

- `addon/ForeverDB/` - in-game collector
- `database/migrations/` - Supabase/PostgreSQL schema
- `scripts/` - update/sync tooling
- `docs/` - beta test notes and data contract


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
