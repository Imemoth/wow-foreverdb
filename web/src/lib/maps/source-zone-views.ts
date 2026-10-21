import type { LocationPoint, SourceDetail } from "@/lib/data/types";
import type { MapSize } from "./coordinates";
import type { MapPoint } from "./observations";
import { zoneMapHref } from "./focus";
import { pointsFromSource } from "./observation-adapters";

/** One zone of a source as shown by the source map. `points` may be EMPTY: the zone is observed and has artwork, nothing is publishable yet. */
export interface SourceZoneView {
  mapId: number;
  zoneName: string;
  /** Measured located observations of the source in this zone (the public number on the page), not the plotted count. */
  zoneObservations: number | null;
  /** Atlas artwork for this zone, or null when the atlas has none (the coordinate grid is then the view). */
  art: { version: string; size: MapSize } | null;
  points: MapPoint[];
  /** The raw aggregated locations of this zone (levels preserved): feeds the accessible coordinate grid for any level selection. */
  locations: LocationPoint[];
  zoneHref: string;
}

interface Options {
  artFor: (mapId: number) => { version: string; size: MapSize } | null;
  /** Catalog name used when the source detail does not name the zone. */
  nameFor: (mapId: number) => string | undefined;
  /**
   * Also list OBSERVED zones that have atlas artwork but no published location cell yet (they show the real map with an explicit
   * "No published locations yet" notice, never invented markers). Observed zones without artwork and without points stay off the map.
   */
  includeUnpublishedZones: boolean;
}

/** Zones of a source for the map: zones with at least one valid published point, plus (optionally) observed zones that have artwork. */
export function buildSourceZoneViews(s: SourceDetail, o: Options): SourceZoneView[] {
  const observed = new Map(s.zones.map((z) => [z.mapId, z]));
  const withLocations = new Set(s.locations.map((l) => l.mapId));
  const ids = new Set<number>(withLocations);
  if (o.includeUnpublishedZones) for (const z of s.zones) ids.add(z.mapId);
  const views: SourceZoneView[] = [];
  for (const mapId of ids) {
    const points = pointsFromSource(s, mapId);
    const art = o.artFor(mapId);
    if (points.length === 0 && !(o.includeUnpublishedZones && art)) continue;
    views.push({
      mapId,
      zoneName: observed.get(mapId)?.zoneName ?? o.nameFor(mapId) ?? `Zone ${mapId}`,
      zoneObservations: observed.get(mapId)?.observations ?? null,
      art,
      points,
      locations: s.locations.filter((l) => l.mapId === mapId),
      zoneHref: zoneMapHref(mapId, { type: s.type === "item" ? "creature" : s.type, id: s.id, level: null }),
    });
  }
  return views.sort((a, b) => (b.zoneObservations ?? 0) - (a.zoneObservations ?? 0) || a.mapId - b.mapId);
}
