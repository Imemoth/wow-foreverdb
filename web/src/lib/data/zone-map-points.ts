import type { LootKind, SourceType, ZoneMapPointRow, ZoneMapPoints } from "./types";

/** Minimum observations of a PUBLISHED cell. Mirrors web_api.zone_map_points (never lower than the publication threshold). */
export const MIN_CELL_OBSERVATIONS = 2;

export interface PublishedLocation {
  source_type: string; source_id: number; source_level: number; loot_kind: string; map_id: number;
  subzone_name: string; x: number; y: number; observations: number;
}

/**
 * Reference implementation of the zone-wide map read over already-published location rows. It is the executable specification of
 * database/public-read/migrations/0002_zone_map_points.sql (the fixture adapter uses it; a parity test compares it with the SQL):
 * floor per published cell BEFORE summing, re-quantize to the 1% grid, no item/disenchant locations, deterministic order, bounded.
 */
export function aggregateZoneMapPoints(
  rows: readonly PublishedLocation[],
  nameOf: (type: string, id: number, level: number) => string | undefined,
  mapId: number,
  lootKind: LootKind | null,
  limit: number,
): ZoneMapPoints {
  const cells = new Map<string, ZoneMapPointRow>();
  for (const l of rows) {
    if (l.map_id !== mapId || l.source_type === "item" || l.loot_kind === "disenchant" || l.observations < MIN_CELL_OBSERVATIONS) continue;
    if (lootKind && l.loot_kind !== lootKind) continue;
    const name = nameOf(l.source_type, l.source_id, l.source_level);
    if (name === undefined) continue; // inner join with sources, as in SQL
    const x = Math.round(l.x), y = Math.round(l.y);
    const key = [l.source_type, l.source_id, l.source_level, l.loot_kind, l.subzone_name, x, y].join("|");
    const have = cells.get(key);
    if (have) have.observations += l.observations;
    else cells.set(key, { sourceType: l.source_type as SourceType, sourceId: l.source_id, sourceLevel: l.source_level, name, lootKind: l.loot_kind as LootKind, subzone: l.subzone_name, x, y, observations: l.observations });
  }
  const sorted = [...cells.values()].sort((a, b) =>
    b.observations - a.observations || cmp(a.sourceType, b.sourceType) || a.sourceId - b.sourceId || a.sourceLevel - b.sourceLevel
    || cmp(a.lootKind, b.lootKind) || cmp(a.subzone, b.subzone) || a.x - b.x || a.y - b.y);
  return { mapId, points: sorted.slice(0, limit), totalCells: sorted.length, truncated: sorted.length > limit };
}

// Byte-wise ordering, like PostgreSQL's "C" collation on these ASCII keys (subzone names may be non-ASCII: use code units, not locale).
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
