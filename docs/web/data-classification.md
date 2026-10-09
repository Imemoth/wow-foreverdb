# Public/private data classification & publication allowlist

**Rule:** a field reaches the public read DB only if it is listed under *Published* below **and** enforced in code by `publisher/src/contract.ts` (strict schemas) and `database/public-read/migrations/0001_public_read_model.sql` (table columns). Expanding either is an allowlist change and needs explicit review. It must never happen silently.

## Classification of production data

| Data | Class | Public? |
| --- | --- | --- |
| Item ID, observed item name | Game catalog | ✅ after name sanitization |
| Source type, ID, level, observed name | Game catalog | ✅ (synthetic pool IDs are published but never displayed) |
| Acquisition kind (`loot_kind` ≠ `unknown`) | Game catalog | ✅ |
| Aggregated observations, drops, quantity per source/kind/item | Aggregate statistics | ✅ |
| Derived observed rate, Wilson bounds, confidence, dominance flag | Derived | ✅ |
| `map_id`, zone name, subzone name | Game geography | ✅ (invalid subzone → empty) |
| Coordinates | Aggregate | ✅ **re-quantized to 1 % grid, cells < 2 observations hidden** |
| first/last seen timestamps | Freshness metadata | ✅ `last_seen_at` only, as "last observed" |
| `quest_drop_count`, `quest_ids` | Game data | ❌ not in the v1 allowlist (candidate; needs review) |
| Distinct installations per aggregate, max installation share | Internal threshold input | ❌ used by the worker, never published |
| `installation_id`, `owner_user_id`, schema/addon versions per installation | **Private** | ❌ never exported |
| Guildbook guilds, members, GUIDs, online state, professions | **Private** | ❌ never exported |
| `map_asset_diagnostics` (user_id, build fingerprints) | **Private** | ❌ |
| `private.foreverdb_api_budgets`, settings, auth schema | **Security** | ❌ |
| Raw sync payloads / per-installation rows | **Private** | ❌ |

## Export contract (production → worker), `publication_export` v1 (0010, not applied)

| Function | Columns |
| --- | --- |
| `export_meta_v1()` | contract_version, exported_at, data_updated_at |
| `export_sources_v1()` | source_type, source_id, source_level, name, first_seen_at, last_seen_at |
| `export_items_v1()` | item_id, name, first_seen_at, last_seen_at |
| `export_buckets_v1()` | source key, loot_kind, observations, installations*, max_installation_share*, last_updated_at |
| `export_drops_v1()` | source key, loot_kind, item_id, drops, quantity, quest_drops†, installations*, max_installation_share* |
| `export_locations_v1(grid)` | source key, loot_kind, map_id, zone_name, subzone_name, x, y (grid ∈ {0.5,1,2,2.5,5}), observations, installations* |

\* threshold input only. † read for contract completeness, not published.

## Public read model (worker → public DB), contract v1

`pub.publications` (ledger) · `pub.state` (active pointer) · `pub.audit_log` · `pub.items` · `pub.sources` · `pub.buckets` · `pub.drops` · `pub.zones` · `pub.zone_entities` · `pub.locations` · `pub.search_index`. Column-level definitions and CHECK constraints are in the migration. Every data row carries `publication_id`.

## Thresholds (`publisher/publication-config.json`)

| Setting | Default | Effect |
| --- | --- | --- |
| `minBucketObservationsForRate` | 10 | Below this, rate/interval are NULL ("too few samples"); entity is `noindex` |
| `lowConfidenceBelow` | 30 | "low": rounded display |
| `highConfidenceAtLeast` | 100 | "high" (never when dominated) |
| `dominatedShare` | 0.9 | ≥90 % of the sample from one installation, or a single installation ⇒ flagged |
| `minLocationCellObservations` | 2 | Smaller location cells are not published |
| `locationGrid` | 1.0 | Coordinates re-quantized before leaving production and again in the worker |
| `maxRejectedRatio` | 0.05 | More rejected rows ⇒ the whole publication fails |
| `maxAnomalyRatio` | 0.02 | More invariant violations ⇒ the whole publication fails |

These thresholds are **sample-size** controls. They do **not** prove contributor anonymity: installations ≠ people, and the current base is 7 installations.

## Known data-quality caveats surfaced in the UI
Observed rates, not drop chances (empty corpses may be missed) · per-level and per-method separation · item-to-zone association via sources · fishing-pool coordinates are projected · herbalism/disenchant provisional · no quest catalog · overlapping snapshots can double count.
