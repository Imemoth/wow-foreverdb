"use client";

import { useMemo, useState } from "react";
import { fmtInt } from "@/lib/format";
import { filterByLevel, levelLabel } from "@/lib/maps/creature-levels";
import { totalObservations } from "@/lib/maps/observations";
import type { SourceZoneView } from "@/lib/maps/source-zone-views";
import { LocationPlot } from "../LocationPlot";
import { ZoneMap } from "./ZoneMap";

export type { SourceZoneView } from "@/lib/maps/source-zone-views";

interface Props {
  sourceName: string;
  assetBase: string | null;
  zones: SourceZoneView[];
  /** Creature pages: the selected level (null = all levels). The zone selection stays independent of it. */
  level?: number | null;
  /** The page offers its own level selector, so the map's min/max level inputs are not shown. */
  levelSelector?: boolean;
  /** Creature pages: lets the empty-state offer a way back to all levels. */
  onShowAllLevels?: () => void;
}

/**
 * Source detail view: the SAME ZoneMap engine as the zone page, showing only this source's published locations. Several zones: a
 * selector (default: most observations). A selected creature level filters the markers and the grid; levels are never merged.
 * A zone with artwork but nothing publishable yet still shows the real map, with an explicit notice and no invented marker.
 */
export function SourceLocationMaps({ sourceName, assetBase, zones, level = null, levelSelector = false, onShowAllLevels }: Props) {
  const [sel, setSel] = useState(zones[0]?.mapId ?? 0);
  const z = zones.find((x) => x.mapId === sel) ?? zones[0];
  const points = useMemo(() => filterByLevel(z?.points ?? [], level), [z, level]);
  const locations = useMemo(() => filterByLevel(z?.locations ?? [], level), [z, level]);
  if (!z) return null;
  const plotted = totalObservations(points);
  const levelled = level != null;
  const cellsOf = (x: SourceZoneView) => (levelled ? x.points.filter((p) => p.level === level).length : x.points.length);
  const none = points.length === 0;
  const grid = <LocationPlot mapId={z.mapId} points={locations} zoneName={z.zoneName} />;
  return (
    <div className="space-y-3" data-testid="source-maps" data-level={level ?? "all"}>
      {zones.length > 1 && (
        <div role="group" aria-label="Zone" className="flex flex-wrap gap-2">
          {zones.map((x) => (
            <button key={x.mapId} type="button" aria-pressed={x.mapId === z.mapId} data-zone-id={x.mapId} onClick={() => setSel(x.mapId)}
              className={`btn-ghost text-sm ${x.mapId === z.mapId ? "border-violet-300 bg-ink-700 text-parchment" : ""}`}>
              {x.zoneName} <span className="text-mist">· {cellsOf(x) > 0 ? `${fmtInt(cellsOf(x))} locations` : "no published locations"}</span>
            </button>
          ))}
        </div>
      )}
      {none ? (
        <div role="status" data-testid="source-no-locations" className="rounded-md border border-gold-400/60 bg-ink-900 p-3 text-sm text-parchment">
          <p className="font-semibold">No published locations yet</p>
          <p className="mt-1 text-mist">
            {sourceName} was observed in {z.zoneName}{z.zoneObservations != null && <> ({fmtInt(z.zoneObservations)} located observations{levelled ? ", all levels" : ""})</>},
            {" "}but {levelled ? <>none at {levelLabel(level).toLowerCase()} has reached the publication threshold</> : <>no map cell has reached the publication threshold</>}
            {" "}(at least 2 observations in the same approximate 1% cell). The map below is the real zone artwork; no position is estimated or invented.
            {levelled && z.points.length > 0 && onShowAllLevels && (
              <> <button type="button" className="underline decoration-dotted underline-offset-2 hover:text-gold-300" data-testid="source-show-all-levels" onClick={onShowAllLevels}>Show all levels</button></>
            )}
          </p>
        </div>
      ) : (
        <p className="text-sm text-mist" data-testid="source-map-plotted">
          {z.zoneName}{levelled && <>, {levelLabel(level).toLowerCase()}</>}: <strong className="text-parchment">{fmtInt(plotted)}</strong> observations in <strong className="text-parchment">{fmtInt(points.length)}</strong> aggregated map cells
          {z.zoneObservations != null && <> (zone total for this source{levelled ? ", all levels" : ""}: {fmtInt(z.zoneObservations)}; cells with very few observations are not published)</>}.
        </p>
      )}
      {z.art ? (
        <ZoneMap key={z.mapId} variant="source" uiMapId={z.mapId} zoneName={z.zoneName} version={z.art.version} assetBase={assetBase} catalogSize={z.art.size}
          points={points} sourceLabel={sourceName} zoneHref={z.zoneHref} emptyMessage="No published locations for this selection." levelFilter={!levelSelector} lazy />
      ) : (
        <div data-testid="source-map-nograph">
          <p className="mb-2 text-sm text-mist">No map artwork is published for this zone in the atlas; showing the coordinate grid.</p>
          {grid}
        </div>
      )}
      {z.art && !none && (
        <details className="text-sm" data-testid="source-grid-fallback">
          <summary className="cursor-pointer text-mist">Coordinate grid view (text and accessible fallback)</summary>
          <div className="mt-3">{grid}</div>
        </details>
      )}
      {!none && <noscript>{grid}</noscript>}
    </div>
  );
}
