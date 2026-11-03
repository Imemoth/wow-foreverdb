import { DataNote } from "@/components/DataNote";
import { LocationPlot } from "@/components/LocationPlot";
import { data } from "@/lib/data";
import { ZONE_MAP_POINT_LIMIT, type LocationPoint } from "@/lib/data/types";
import { fmtInt } from "@/lib/format";
import { artworkOf } from "@/lib/maps/atlas/zone-catalog";
import type { AtlasMap } from "@/lib/maps/atlas/schema";
import { parseAssetBase } from "@/lib/maps/asset-url";
import { pointsFromZoneRows } from "@/lib/maps/observation-adapters";
import { NO_FILTER, type MapFilterState, type SourceFocus } from "@/lib/maps/observations";
import { ZoneMap } from "./ZoneMap";
import type { LootKind } from "@/lib/data/types";

/** The CDN base the client may use, or null when none is configured (same-origin POC assets never serve atlas zones). */
export function configuredAssetBase(): string | null {
  const b = parseAssetBase(process.env.NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL);
  return b && b.startsWith("https://") ? b : null;
}

interface Props {
  mapId: number;
  zoneName: string;
  atlasMap: AtlasMap | undefined;
  kinds: ReadonlySet<LootKind>;
  source: SourceFocus | null;
  /** Known to have zero published observations (atlas-only zone): skip the point read entirely. */
  knownEmpty: boolean;
}

/**
 * The interactive zone map: real CDN artwork + the published zone-wide observation layer. The page's text content never depends on it:
 * a missing atlas map, an unreachable CDN or an unavailable observation read each degrade to an explicit message.
 */
export async function ZoneMapSection({ mapId, zoneName, atlasMap, kinds, source, knownEmpty }: Props) {
  const adapter = data();
  let layer: { points: ReturnType<typeof pointsFromZoneRows>; totalCells: number; truncated: boolean } | null = null;
  let layerError = false;
  if (!knownEmpty) {
    try {
      const r = await adapter.zoneMapPoints(mapId, null, ZONE_MAP_POINT_LIMIT);
      layer = { points: pointsFromZoneRows(r.points, mapId), totalCells: r.totalCells, truncated: r.truncated };
    } catch {
      layerError = true; // e.g. 0002_zone_map_points.sql not applied on the public-read database yet
    }
  }
  const art = atlasMap ? artworkOf(atlasMap) : null;
  const synthetic = adapter.mode === "synthetic-sample";
  const initial: MapFilterState = { ...NO_FILTER, kinds, source };
  const focusName = source && layer ? layer.points.find((p) => p.sourceType === source.type && p.sourceId === source.id)?.sourceName : undefined;

  const notices = (
    <>
      {synthetic && (
        <DataNote><strong>Synthetic sample data.</strong> The markers on this map come from the synthetic public fixture, not from real AzerDex observations.</DataNote>
      )}
      {layerError && <DataNote>The zone-wide observation layer is not available right now. The map artwork and the entity directory below are unaffected.</DataNote>}
      {layer?.truncated && (
        <DataNote>Showing the {fmtInt(layer.points.length)} best-observed of {fmtInt(layer.totalCells)} published locations in this zone.</DataNote>
      )}
    </>
  );

  if (!art) {
    // No usable atlas artwork for this id: say so; never substitute another map. Located data (if any) stays reachable as the plain grid.
    const grid: LocationPoint[] = (layer?.points ?? []).map((p) => ({ level: p.level, lootKind: p.lootKind, mapId, subzone: p.subzone, x: p.x, y: p.y, observations: p.observations }));
    return (
      <section aria-labelledby="zone-map-title" className="space-y-3" data-testid="zone-map-section" data-artwork="unavailable">
        <h2 id="zone-map-title" className="panel-title text-lg">Zone map</h2>
        <DataNote>No map artwork is published for this map (uiMapID {mapId}) in the atlas. The zone information below is unaffected.</DataNote>
        {notices}
        {grid.length > 0 && <LocationPlot points={grid} zoneName={zoneName} mapId={mapId} />}
      </section>
    );
  }

  return (
    <section aria-labelledby="zone-map-title" className="space-y-3" data-testid="zone-map-section" data-artwork="available">
      <h2 id="zone-map-title" className="panel-title text-lg">Zone map</h2>
      <p className="text-sm text-mist">
        Interactive map of {zoneName}{atlasMap?.hasFullReveal ? " (fully revealed artwork)" : " (base artwork)"}. Markers show aggregated, published
        observation locations (approximate 1% grid) and are never exact spawn points.
      </p>
      <ZoneMap
        variant="zone" uiMapId={mapId} zoneName={zoneName} version={art.version} assetBase={configuredAssetBase()} lazy
        catalogSize={{ width: art.image.width, height: art.image.height }}
        points={layer?.points ?? []} initialFilter={initial} sourceLabel={focusName}
        emptyMessage={layerError ? "The observation layer is unavailable; the map artwork is shown without markers." : "No public observations are available for this zone yet."}
        notice={notices}
      />
    </section>
  );
}
