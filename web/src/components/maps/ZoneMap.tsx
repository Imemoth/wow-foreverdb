"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtInt } from "@/lib/format";
import { resolveMapAssetUrl } from "@/lib/maps/asset-url";
import type { MapSize } from "@/lib/maps/coordinates";
import { loadManifest, type MapManifest } from "@/lib/maps/manifest";
import { NO_FILTER, countByKind, filterPoints, levelRange, totalObservations, type MapFilterState, type MapPoint } from "@/lib/maps/observations";
import { MapFilters } from "./MapFilters";
import { ZoneMapDetails } from "./ZoneMapDetails";
import type { MapMode, Selection } from "./ZoneMapViewer";

// Leaflet needs `window`: the viewer is client-only (the server renders the loading shell below).
const ZoneMapViewer = dynamic(() => import("./ZoneMapViewer").then((m) => m.ZoneMapViewer), {
  ssr: false,
  loading: () => <MapStatus>Loading map…</MapStatus>,
});

function MapStatus({ children, alert, tall }: { children: React.ReactNode; alert?: boolean; tall?: boolean }) {
  return (
    <div role={alert ? "alert" : "status"} aria-live="polite" data-testid="map-status"
      className={`flex ${tall ? "h-[22rem]" : "h-[18rem]"} items-center justify-center rounded-md border border-ink-600 bg-ink-900 p-6 text-center text-sm text-mist`}>
      {children}
    </div>
  );
}

/** Above this many aggregated locations a zone view starts as clusters (individual markers stay one click away). */
export const CLUSTER_DEFAULT_THRESHOLD = 120;
export const suggestMode = (count: number): MapMode => (count > CLUSTER_DEFAULT_THRESHOLD ? "clusters" : "markers");

export interface ZoneMapProps {
  /** "zone": whole-zone overview with category filters. "source": compact view of one source's own published locations. */
  variant?: "zone" | "source";
  /** UiMapID: the only map identity (never a slug, never the internal MapID). */
  uiMapId: number;
  zoneName: string;
  /** Immutable atlas version resolved from the catalog (e.g. "v2"). */
  version: string;
  /** undefined: read NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL (POC behaviour). null: no asset origin configured. string: validated base. */
  assetBase?: string | null;
  points: MapPoint[];
  /** Catalog dimensions of the default image: used for the plain-grid fallback and to cross-check the manifest. */
  catalogSize?: MapSize;
  initialFilter?: MapFilterState;
  initialMode?: MapMode;
  /** Shown instead of the filters when the zone has no published observations at all. */
  emptyMessage?: string;
  /** Source variant: name shown in the focus line. */
  sourceLabel?: string;
  /** Source variant: link to the whole-zone map. */
  zoneHref?: string;
  /** Defer Leaflet and the manifest/image requests until the map is near the viewport. */
  lazy?: boolean;
  notice?: React.ReactNode;
}

type Load = { state: "loading" } | { state: "ready"; manifest: MapManifest; imageUrl: string } | { state: "fallback"; reason: string };

/** Fallback surface when the catalog gave no dimensions: the documented standard atlas canvas. */
const DEFAULT_SIZE: MapSize = { width: 1002, height: 668 };

function useNearViewport(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(!enabled);
  useEffect(() => {
    if (!enabled || near) return;
    if (typeof IntersectionObserver === "undefined" || !ref.current) { setNear(true); return; }
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: "600px 0px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [enabled, near]);
  return { ref, near };
}

export function ZoneMap({
  variant = "zone", uiMapId, zoneName, version, assetBase, points, catalogSize, initialFilter, initialMode, emptyMessage, sourceLabel, zoneHref, lazy = false, notice,
}: ZoneMapProps) {
  const compact = variant === "source";
  const { ref: sentinel, near } = useNearViewport(lazy);
  const [loaded, setLoad] = useState<Load>({ state: "loading" });
  // No configured origin is a known state, not something to discover by a failing request: derived, never set from an effect.
  const load: Load = assetBase === null ? { state: "fallback", reason: "No map artwork origin is configured for this deployment." } : loaded;
  const [filter, setFilter] = useState<MapFilterState>(initialFilter ?? NO_FILTER);
  const [mode, setMode] = useState<MapMode>(initialMode ?? (compact ? "markers" : suggestMode(points.length)));
  const [selected, setSelected] = useState<Selection | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!near || assetBase === null) return;
    const base = assetBase === undefined ? process.env.NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL : assetBase;
    const ctl = new AbortController();
    (async () => {
      let url: string;
      try { url = resolveMapAssetUrl(base, uiMapId, version, "manifest.json"); } catch { return setLoad({ state: "fallback", reason: "The map reference is invalid." }); }
      const r = await loadManifest(url, fetch, ctl.signal);
      if (ctl.signal.aborted) return;
      if (!r.ok) return setLoad({ state: "fallback", reason: r.error === "unavailable" ? "The map manifest could not be loaded." : "The map manifest is invalid." });
      const m = r.manifest;
      // The manifest must describe exactly this map, version and catalog image: never display another zone's art.
      if (m.zoneId !== uiMapId || m.version !== version) return setLoad({ state: "fallback", reason: "The map manifest does not match this zone." });
      if (catalogSize && (m.image.width !== catalogSize.width || m.image.height !== catalogSize.height)) return setLoad({ state: "fallback", reason: "The map manifest does not match the atlas catalog." });
      let imageUrl: string;
      try { imageUrl = resolveMapAssetUrl(base, uiMapId, version, m.image.file); } catch { return setLoad({ state: "fallback", reason: "The map manifest is invalid." }); }
      setLoad({ state: "ready", manifest: m, imageUrl });
    })();
    return () => ctl.abort();
  }, [near, uiMapId, version, assetBase, catalogSize]);

  const available = useMemo(() => countByKind(points), [points]);
  const levels = useMemo(() => levelRange(points), [points]);
  const distinctLevels = useMemo(() => new Set(points.filter((p) => p.lootKind === "mob" || p.lootKind === "skinning").map((p) => p.level)).size, [points]);
  const shown = useMemo(() => filterPoints(points, filter), [points, filter]);
  const imageFailed = () => setLoad({ state: "fallback", reason: "The map image could not be loaded." });
  const size: MapSize = load.state === "ready" ? load.manifest.image : (catalogSize ?? DEFAULT_SIZE);
  const noPoints = points.length === 0;
  const kindCount = Object.keys(available).length;
  const showFilters = !noPoints && (!compact || kindCount > 1 || distinctLevels > 1 || filter.source != null);
  const tallClass = compact ? (expanded ? "h-[75vh] min-h-[22rem]" : "h-[20rem] sm:h-[24rem]") : undefined;

  if (!near) {
    return <div ref={sentinel}><MapStatus tall>Map loads when scrolled into view…</MapStatus></div>;
  }

  return (
    <div className="space-y-4" data-map-variant={variant} data-map-id={uiMapId}>
      {notice}
      {showFilters && (
        <MapFilters available={available} filter={filter} levels={compact && distinctLevels < 2 ? null : levels} mode={mode} compact={compact} sourceLabel={sourceLabel}
          onFilter={(f) => { setFilter(f); setSelected(null); }} onMode={setMode} onReset={() => setResetKey((k) => k + 1)} />
      )}
      {noPoints ? (
        <p role="status" data-testid="map-no-observations" className="text-sm text-mist">{emptyMessage ?? "No observations are available for this map."}</p>
      ) : (
        <p className="text-sm text-mist" aria-live="polite" data-testid="map-summary">
          Showing <strong className="text-parchment">{fmtInt(shown.length)}</strong> of {fmtInt(points.length)} aggregated locations
          · <strong className="text-parchment">{fmtInt(totalObservations(shown))}</strong> of {fmtInt(totalObservations(points))} observations
        </p>
      )}
      <div className={compact ? "space-y-3" : "grid gap-4 lg:grid-cols-[1fr_18rem]"}>
        <div className="space-y-2">
          {load.state === "loading" ? (
            <MapStatus tall>Loading map…</MapStatus>
          ) : (
            <>
              {load.state === "ready" && (
                <p data-testid="map-art" className="text-xs text-mist">
                  Artwork: {load.manifest.image.variant ?? "owner-supplied POC image"} · {version}
                  {load.manifest.clientBuild ? ` · client ${load.manifest.clientBuild.version}` : ""} · registration: {load.manifest.calibration.status}
                </p>
              )}
              {load.state === "fallback" && (
                <p role="alert" data-testid="map-fallback" className="rounded-md border border-gold-400/60 bg-ink-900 p-3 text-sm text-parchment">
                  Map artwork unavailable ({load.reason}). Showing a plain 0–100% coordinate grid instead; marker positions are unaffected.
                </p>
              )}
              <ZoneMapViewer size={size} imageUrl={load.state === "ready" ? load.imageUrl : null} points={shown} mode={mode}
                resetKey={resetKey} label={`${zoneName} interactive observation map`} heightClass={tallClass} onSelect={setSelected} onImageError={imageFailed} />
              {!noPoints && shown.length === 0 && <p role="status" data-testid="map-empty" className="text-sm text-mist">No observations match these filters.</p>}
              {compact && (
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <button type="button" className="btn-ghost text-sm sm:hidden" aria-expanded={expanded} data-testid="map-expand" onClick={() => setExpanded((v) => !v)}>
                    {expanded ? "Compact map" : "Expand map"}
                  </button>
                  {zoneHref && <Link href={zoneHref} data-testid="zone-map-link" className="btn-ghost text-sm">View on full {zoneName} map</Link>}
                </div>
              )}
            </>
          )}
        </div>
        {!noPoints && <ZoneMapDetails selected={selected} />}
      </div>
    </div>
  );
}
