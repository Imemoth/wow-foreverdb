import { LOCATED_LOOT_KINDS, type LootKind, type LocationPoint, type SourceDetail, type SourceType, type ZoneMapPointRow } from "@/lib/data/types";
import { isValidPercent } from "./coordinates";
import type { MapPoint } from "./observations";

/**
 * Observation adapters: turn already-published public-read DTOs into validated map points. Nothing here can create a location:
 * invalid coordinates, non-positive counts, unknown kinds, item-backed sources and disenchant results are dropped.
 */
const LOCATED = new Set<string>(LOCATED_LOOT_KINDS);
const SOURCE_TYPES = new Set<string>(["creature", "gameobject", "fishing"]);

function valid(sourceType: string, lootKind: string, x: number, y: number, observations: number): boolean {
  return SOURCE_TYPES.has(sourceType) && LOCATED.has(lootKind) && isValidPercent(x, y) && Number.isFinite(observations) && observations > 0;
}

const pid = (t: string, id: number, level: number, kind: string, x: number, y: number, subzone: string) => `${t}-${id}-${level}-${kind}-${x}-${y}-${subzone.length}`;

/** Points of ONE source (web_api.source locations) inside one zone. Names come from that source's own level variants. */
export function pointsFromSource(detail: SourceDetail, mapId: number): MapPoint[] {
  const names = new Map(detail.variants.map((v) => [v.level, v.name]));
  const fallback = detail.variants[0]?.name ?? `Source ${detail.id}`;
  const out: MapPoint[] = [];
  const seen = new Map<string, number>();
  for (const l of detail.locations as LocationPoint[]) {
    if (l.mapId !== mapId || !valid(detail.type, l.lootKind, l.x, l.y, l.observations)) continue;
    const base = pid(detail.type, detail.id, l.level, l.lootKind, l.x, l.y, l.subzone);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({
      id: n ? `${base}-${n}` : base, sourceType: detail.type, sourceId: detail.id, sourceName: names.get(l.level) ?? fallback, level: l.level,
      lootKind: l.lootKind, mapId, subzone: l.subzone, x: l.x, y: l.y, observations: l.observations,
    });
  }
  return out;
}

/** Zone-wide points (web_api.zone_map_points rows). */
export function pointsFromZoneRows(rows: readonly ZoneMapPointRow[], mapId: number): MapPoint[] {
  const out: MapPoint[] = [];
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!valid(r.sourceType, r.lootKind, r.x, r.y, r.observations)) continue;
    const base = pid(r.sourceType, r.sourceId, r.sourceLevel, r.lootKind, r.x, r.y, r.subzone);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({
      id: n ? `${base}-${n}` : base, sourceType: r.sourceType as SourceType, sourceId: r.sourceId, sourceName: r.name, level: r.sourceLevel,
      lootKind: r.lootKind as LootKind, mapId, subzone: r.subzone, x: r.x, y: r.y, observations: r.observations,
    });
  }
  return out;
}

/** Zones of a source that can be shown on a map: those with at least one valid located point. */
export function sourceZonesWithPoints(detail: SourceDetail): { mapId: number; points: MapPoint[] }[] {
  const ids = [...new Set(detail.locations.map((l) => l.mapId))];
  return ids.map((mapId) => ({ mapId, points: pointsFromSource(detail, mapId) })).filter((z) => z.points.length > 0);
}
