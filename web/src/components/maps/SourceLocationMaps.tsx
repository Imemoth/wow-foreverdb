"use client";

import { useState } from "react";
import { fmtInt } from "@/lib/format";
import type { MapSize } from "@/lib/maps/coordinates";
import { totalObservations, type MapPoint } from "@/lib/maps/observations";
import { ZoneMap } from "./ZoneMap";

export interface SourceZoneView {
  mapId: number;
  zoneName: string;
  /** Measured located observations of the source in this zone (the public number on the page), not the plotted count. */
  zoneObservations: number | null;
  /** Atlas artwork for this zone, or null when the atlas has none (the coordinate grid is then the view). */
  art: { version: string; size: MapSize } | null;
  points: MapPoint[];
  zoneHref: string;
}

interface Props {
  sourceName: string;
  assetBase: string | null;
  zones: SourceZoneView[];
  /** Server-rendered SVG coordinate grids (the resilient / accessible fallback), keyed by map id. */
  grids: Record<number, React.ReactNode>;
}

/**
 * Source detail view: the SAME ZoneMap engine as the zone page, showing only this source's published locations. Several zones: a
 * selector (default: most observations). The SVG grid stays available (collapsed) for every zone, and is the view where no artwork exists.
 */
export function SourceLocationMaps({ sourceName, assetBase, zones, grids }: Props) {
  const [sel, setSel] = useState(zones[0]?.mapId ?? 0);
  const z = zones.find((x) => x.mapId === sel) ?? zones[0];
  if (!z) return null;
  const plotted = totalObservations(z.points);
  return (
    <div className="space-y-3" data-testid="source-maps">
      {zones.length > 1 && (
        <div role="group" aria-label="Zone" className="flex flex-wrap gap-2">
          {zones.map((x) => (
            <button key={x.mapId} type="button" aria-pressed={x.mapId === z.mapId} data-zone-id={x.mapId} onClick={() => setSel(x.mapId)}
              className={`btn-ghost text-sm ${x.mapId === z.mapId ? "border-violet-300 bg-ink-700 text-parchment" : ""}`}>
              {x.zoneName} <span className="text-mist">· {fmtInt(x.points.length)} locations</span>
            </button>
          ))}
        </div>
      )}
      <p className="text-sm text-mist" data-testid="source-map-plotted">
        {z.zoneName}: <strong className="text-parchment">{fmtInt(plotted)}</strong> observations in <strong className="text-parchment">{fmtInt(z.points.length)}</strong> aggregated map cells
        {z.zoneObservations != null && <> (zone total for this source: {fmtInt(z.zoneObservations)}; cells with very few observations are not published)</>}.
      </p>
      {z.art ? (
        <ZoneMap key={z.mapId} variant="source" uiMapId={z.mapId} zoneName={z.zoneName} version={z.art.version} assetBase={assetBase} catalogSize={z.art.size}
          points={z.points} sourceLabel={sourceName} zoneHref={z.zoneHref} lazy />
      ) : (
        <div data-testid="source-map-nograph">
          <p className="mb-2 text-sm text-mist">No map artwork is published for this zone in the atlas; showing the coordinate grid.</p>
          {grids[z.mapId]}
        </div>
      )}
      {z.art && (
        <details className="text-sm" data-testid="source-grid-fallback">
          <summary className="cursor-pointer text-mist">Coordinate grid view (text and accessible fallback)</summary>
          <div className="mt-3">{grids[z.mapId]}</div>
        </details>
      )}
      <noscript>{grids[z.mapId]}</noscript>
    </div>
  );
}
