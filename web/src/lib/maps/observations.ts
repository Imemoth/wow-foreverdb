import { LOOT_KINDS, type LootKind } from "@/lib/data/types";
import { isValidPercent } from "./coordinates";

/** One already-published, aggregated (1% cell) observation point of a source. No contributor or per-install data. */
export interface MapPoint {
  id: string;
  sourceType: "creature" | "gameobject" | "fishing" | "item";
  sourceId: number;
  sourceName: string;
  level: number;
  lootKind: LootKind;
  mapId: number;
  subzone: string;
  x: number;
  y: number;
  observations: number;
}

/** Restricts the view to one source (its levels stay separate markers; `level` null = every observed level). */
export interface SourceFocus { type: MapPoint["sourceType"]; id: number; level: number | null }

export interface MapFilterState {
  /** Empty set = all categories. */
  kinds: ReadonlySet<LootKind>;
  /** Optional: only this source (e.g. arriving from a source page). Absent/null = all sources. */
  source?: SourceFocus | null;
  /** Applies to creature-sourced kinds only (mob, skinning); null = any level. */
  levelMin: number | null;
  levelMax: number | null;
}

export const NO_FILTER: MapFilterState = { kinds: new Set(), levelMin: null, levelMax: null };

/** Categories whose source has a meaningful creature level. */
export const LEVELED_KINDS: ReadonlySet<LootKind> = new Set<LootKind>(["mob", "skinning"]);

/** Selects the points of one map; invalid coordinates are dropped. */
export function pointsForMap(points: readonly MapPoint[], mapId: number): MapPoint[] {
  return points.filter((p) => p.mapId === mapId && isValidPercent(p.x, p.y));
}

export function filterPoints(points: readonly MapPoint[], f: MapFilterState): MapPoint[] {
  return points.filter((p) => {
    if (f.kinds.size > 0 && !f.kinds.has(p.lootKind)) return false;
    if (f.source && (p.sourceType !== f.source.type || p.sourceId !== f.source.id || (f.source.level != null && p.level !== f.source.level))) return false;
    if (LEVELED_KINDS.has(p.lootKind)) {
      if (f.levelMin != null && p.level < f.levelMin) return false;
      if (f.levelMax != null && p.level > f.levelMax) return false;
    }
    return true;
  });
}

export function countByKind(points: readonly MapPoint[]): Partial<Record<LootKind, number>> {
  const out: Partial<Record<LootKind, number>> = {};
  for (const p of points) out[p.lootKind] = (out[p.lootKind] ?? 0) + 1;
  return out;
}

export const totalObservations = (points: readonly MapPoint[]) => points.reduce((a, p) => a + p.observations, 0);

export function levelRange(points: readonly MapPoint[]): { min: number; max: number } | null {
  const lv = points.filter((p) => LEVELED_KINDS.has(p.lootKind)).map((p) => p.level);
  return lv.length ? { min: Math.min(...lv), max: Math.max(...lv) } : null;
}

export interface MapCluster {
  x: number; y: number; observations: number; pointCount: number; label: string; points: MapPoint[];
}

/** Port of Companion MapClusterService.Cluster: grid cells of `cellSizePercent`, observation-weighted centroid. */
export function clusterPoints(points: readonly MapPoint[], cellSizePercent: number): MapCluster[] {
  const cell = Math.min(25, Math.max(0.5, cellSizePercent));
  const groups = new Map<string, MapPoint[]>();
  for (const p of points) {
    if (!isValidPercent(p.x, p.y)) continue;
    const key = `${Math.floor(p.x / cell)}|${Math.floor(p.y / cell)}`;
    const g = groups.get(key);
    if (g) g.push(p); else groups.set(key, [p]);
  }
  const out: MapCluster[] = [];
  for (const g of groups.values()) {
    const w = (p: MapPoint) => Math.max(1, p.observations);
    const total = g.reduce((a, p) => a + w(p), 0);
    const areas = [...new Set(g.map((p) => p.subzone).filter(Boolean))].slice(0, 3);
    out.push({
      x: g.reduce((a, p) => a + p.x * w(p), 0) / total,
      y: g.reduce((a, p) => a + p.y * w(p), 0) / total,
      observations: g.reduce((a, p) => a + p.observations, 0),
      pointCount: g.length,
      label: areas.length ? areas.join(", ") : "Observed location",
      points: g,
    });
  }
  return out.sort((a, b) => b.observations - a.observations || b.pointCount - a.pointCount);
}

export const MAP_LOOT_KINDS: readonly LootKind[] = LOOT_KINDS;
