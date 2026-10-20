"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { LOOT_KIND_LABEL, fmtInt } from "@/lib/format";
import { resolveMapAssetUrl } from "@/lib/maps/asset-url";
import { loadManifest, type MapManifest } from "@/lib/maps/manifest";
import { NO_FILTER, countByKind, filterPoints, levelRange, totalObservations, type MapFilterState, type MapPoint } from "@/lib/maps/observations";
import { MapFilters } from "./MapFilters";
import type { MapMode, Selection } from "./ZoneMapViewer";

// Leaflet needs `window`: the viewer is client-only (the server renders the loading shell below).
const ZoneMapViewer = dynamic(() => import("./ZoneMapViewer").then((m) => m.ZoneMapViewer), {
  ssr: false,
  loading: () => <MapStatus>Loading map…</MapStatus>,
});

function MapStatus({ children, alert }: { children: React.ReactNode; alert?: boolean }) {
  return (
    <div role={alert ? "alert" : "status"} aria-live="polite" data-testid="map-status"
      className="flex h-[22rem] items-center justify-center rounded-md border border-ink-600 bg-ink-900 p-6 text-center text-sm text-mist">
      {children}
    </div>
  );
}

interface Props { zoneId: number; zoneName: string; version: string; points: MapPoint[] }

type Load = { state: "loading" } | { state: "ready"; manifest: MapManifest; imageUrl: string } | { state: "fallback"; reason: string };

/** Fallback surface: the documented Tirisfal dimensions, so markers still register on a plain coordinate grid. */
const FALLBACK_SIZE = { width: 1002, height: 668 };

export function ZoneMapPoc({ zoneId, zoneName, version, points }: Props) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [filter, setFilter] = useState<MapFilterState>(NO_FILTER);
  const [mode, setMode] = useState<MapMode>("markers");
  const [selected, setSelected] = useState<Selection | null>(null);
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    const base = process.env.NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL;
    (async () => {
      const url = resolveMapAssetUrl(base, zoneId, version, "manifest.json");
      const r = await loadManifest(url, fetch, ctl.signal);
      if (ctl.signal.aborted) return;
      if (!r.ok) return setLoad({ state: "fallback", reason: r.error === "unavailable" ? "The map manifest could not be loaded." : "The map manifest is invalid." });
      if (r.manifest.zoneId !== zoneId) return setLoad({ state: "fallback", reason: "The map manifest does not match this zone." });
      setLoad({ state: "ready", manifest: r.manifest, imageUrl: resolveMapAssetUrl(base, zoneId, version, r.manifest.image.file) });
    })();
    return () => ctl.abort();
  }, [zoneId, version]);

  const available = useMemo(() => countByKind(points), [points]);
  const levels = useMemo(() => levelRange(points), [points]);
  const shown = useMemo(() => filterPoints(points, filter), [points, filter]);
  const imageFailed = () => setLoad({ state: "fallback", reason: "The map image could not be loaded." });

  const size = load.state === "ready" ? load.manifest.image : FALLBACK_SIZE;

  return (
    <div className="space-y-4">
      <MapFilters available={available} filter={filter} levels={levels} mode={mode}
        onFilter={(f) => { setFilter(f); setSelected(null); }} onMode={setMode} onReset={() => setResetKey((k) => k + 1)} />
      <p className="text-sm text-mist" aria-live="polite" data-testid="map-summary">
        Showing <strong className="text-parchment">{fmtInt(shown.length)}</strong> of {fmtInt(points.length)} aggregated locations
        · <strong className="text-parchment">{fmtInt(totalObservations(shown))}</strong> of {fmtInt(totalObservations(points))} observations
      </p>
      <div className="grid gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-2">
          {load.state === "loading" ? (
            <MapStatus>Loading map…</MapStatus>
          ) : (
            <>
              {load.state === "fallback" && (
                <p role="alert" data-testid="map-fallback" className="rounded-md border border-gold-400/60 bg-ink-900 p-3 text-sm text-parchment">
                  Map artwork unavailable ({load.reason}). Showing a plain 0–100% coordinate grid instead; marker positions are unaffected.
                </p>
              )}
              <ZoneMapViewer size={size} imageUrl={load.state === "ready" ? load.imageUrl : null} points={shown} mode={mode}
                resetKey={resetKey} label={`${zoneName} interactive observation map`} onSelect={setSelected} onImageError={imageFailed} />
              {shown.length === 0 && <p role="status" data-testid="map-empty" className="text-sm text-mist">No observations match these filters.</p>}
            </>
          )}
        </div>
        <aside className="panel space-y-2 p-4 text-sm" aria-live="polite" data-testid="detail-panel">
          <h2 className="panel-title text-base">Details</h2>
          {!selected && <p className="text-mist">Select a marker to see its observation details.</p>}
          {selected?.kind === "point" && <PointDetail p={selected.point} />}
          {selected?.kind === "cluster" && (
            <>
              <p className="text-parchment">{selected.cluster.pointCount} locations · {fmtInt(selected.cluster.observations)} observations</p>
              <p className="text-mist">{selected.cluster.label}</p>
              <ul className="space-y-1">
                {selected.cluster.points.slice(0, 8).map((p) => <li key={p.id}><PointLine p={p} /></li>)}
              </ul>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function PointLine({ p }: { p: MapPoint }) {
  return <span className="text-mist"><span className="text-parchment">{p.sourceName}</span> · {LOOT_KIND_LABEL[p.lootKind]} · {fmtInt(p.observations)} obs.</span>;
}

function PointDetail({ p }: { p: MapPoint }) {
  return (
    <dl className="space-y-1">
      <dt className="sr-only">Source</dt><dd className="font-semibold text-parchment">{p.sourceName}</dd>
      <dt className="text-xs uppercase tracking-wide text-mist">Category</dt><dd>{LOOT_KIND_LABEL[p.lootKind]}</dd>
      {(p.lootKind === "mob" || p.lootKind === "skinning") && (<><dt className="text-xs uppercase tracking-wide text-mist">Level</dt><dd>{p.level}</dd></>)}
      <dt className="text-xs uppercase tracking-wide text-mist">Area</dt><dd>{p.subzone || "—"}</dd>
      <dt className="text-xs uppercase tracking-wide text-mist">Map position (approx. 1% cell)</dt><dd className="font-[family-name:var(--font-mono)]">{p.x}, {p.y}</dd>
      <dt className="text-xs uppercase tracking-wide text-mist">Observations</dt><dd>{fmtInt(p.observations)}</dd>
    </dl>
  );
}
