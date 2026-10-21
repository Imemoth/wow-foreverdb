import "server-only";
import sample from "@/lib/data/fixture/public-projection.sample.json";
import { LOOT_KINDS, type LootKind } from "@/lib/data/types";
import { pointsForMap, type MapPoint } from "./observations";

/**
 * POC-only zone-wide selector over the SYNTHETIC public fixture projection. It reads nothing but the
 * already-published `locations` + `sources` of the sample file (no private tables, no raw Companion data).
 * A later, approved BFF adapter can replace this function without touching the viewer.
 */
export interface ZoneObservations { mapId: number; synthetic: true; points: MapPoint[] }

const KINDS = new Set<string>(LOOT_KINDS);

export function zoneObservations(mapId: number): ZoneObservations {
  const p = sample.projection;
  const names = new Map(p.sources.map((s) => [`${s.source_type}|${s.source_id}|${s.source_level}`, s.name]));
  const all: MapPoint[] = [];
  p.locations.forEach((l, i) => {
    if (l.map_id !== mapId || !KINDS.has(l.loot_kind)) return;
    all.push({
      id: `${l.source_type}-${l.source_id}-${l.source_level}-${i}`,
      sourceType: l.source_type as MapPoint["sourceType"],
      sourceId: l.source_id,
      sourceName: names.get(`${l.source_type}|${l.source_id}|${l.source_level}`) ?? `Source ${l.source_id}`,
      level: l.source_level,
      lootKind: l.loot_kind as LootKind,
      mapId: l.map_id,
      subzone: l.subzone_name,
      x: l.x,
      y: l.y,
      observations: l.observations,
    });
  });
  return { mapId, synthetic: true, points: pointsForMap(all, mapId) };
}
