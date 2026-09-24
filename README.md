# WoW ForeverDB

Observed loot, gathering and skinning database for World of Warcraft: Forever.

## Collector alpha

Current addon version: **0.2.0-alpha**  
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
