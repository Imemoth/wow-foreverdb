"use client";

import "leaflet/dist/leaflet.css";
import type { Map as LMap } from "leaflet";
import { useEffect, useRef, useState } from "react";
import { KIND_FILL } from "@/components/LocationPlot";
import { imageBounds, percentToLatLng, type MapSize } from "@/lib/maps/coordinates";
import { clusterPoints, type MapCluster, type MapPoint } from "@/lib/maps/observations";

export type MapMode = "markers" | "clusters";
export type Selection = { kind: "point"; point: MapPoint } | { kind: "cluster"; cluster: MapCluster };

interface Props {
  size: MapSize;
  /** null => no artwork (fallback coordinate grid). */
  imageUrl: string | null;
  points: MapPoint[];
  mode: MapMode;
  /** Incremented by the parent to refit the view. */
  resetKey: number;
  label: string;
  onSelect: (s: Selection | null) => void;
  onImageError: () => void;
}

const MAX_EXTRA_ZOOM = 3;
/** Cluster cell edge in map-percent at the fit zoom; halves with every zoom level. */
const BASE_CELL_PERCENT = 6;

/**
 * Leaflet CRS.Simple viewer. Leaflet touches `window`, so it is imported inside an effect (client only);
 * the server renders just the empty, labelled container. Markers are DOM elements styled through the CSSOM
 * (no inline style attributes in markup), which keeps the nonce-based style-src CSP intact.
 */
export function ZoneMapViewer({ size, imageUrl, points, mode, resetKey, label, onSelect, onImageError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ map: LMap; render: () => void; fit: () => void } | null>(null);
  const live = useRef({ points, mode, onSelect, onImageError });
  useEffect(() => { live.current = { points, mode, onSelect, onImageError }; });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      const L = (await import("leaflet")).default;
      if (disposed || !host.current) return;
      const bounds = imageBounds(size);
      const map = L.map(host.current, {
        crs: L.CRS.Simple, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: false,
        maxBoundsViscosity: 0.9, keyboard: true, zoomControl: true,
      });
      const fitZoom = () => map.getBoundsZoom(bounds, false);
      const fit = () => {
        const z = fitZoom();
        map.setMinZoom(z);
        map.setMaxZoom(z + MAX_EXTRA_ZOOM);
        map.fitBounds(bounds, { animate: false });
      };
      fit();
      map.setMaxBounds(L.latLngBounds(bounds).pad(0.25));

      if (imageUrl) {
        const overlay = L.imageOverlay(imageUrl, bounds, { alt: "", interactive: false }).addTo(map);
        overlay.on("error", () => live.current.onImageError());
      } else {
        L.rectangle(bounds, { color: "#364055", weight: 1, fill: true, fillColor: "#0d0f33", fillOpacity: 1, interactive: false }).addTo(map);
        for (let i = 10; i < 100; i += 10) {
          const v = L.latLng(percentToLatLng(size, i, i)!);
          L.polyline([[0, v.lng], [size.height, v.lng]], { color: "#262d3b", weight: 1, interactive: false }).addTo(map);
          L.polyline([[v.lat, 0], [v.lat, size.width]], { color: "#262d3b", weight: 1, interactive: false }).addTo(map);
        }
      }

      const layer = L.layerGroup().addTo(map);

      const dot = (fill: string, px: number, text?: string) => {
        const el = document.createElement("div");
        el.className = "azd-marker";
        el.style.width = el.style.height = `${px}px`;
        el.style.borderRadius = "50%";
        el.style.background = fill;
        el.style.border = "2px solid rgba(7,9,28,0.85)";
        el.style.boxShadow = "0 0 0 1px rgba(236,230,217,0.55)";
        el.style.color = "#07091c";
        el.style.font = "700 11px/1 system-ui, sans-serif";
        el.style.display = "flex";
        el.style.alignItems = "center";
        el.style.justifyContent = "center";
        if (text) el.textContent = text;
        return el;
      };

      const render = () => {
        layer.clearLayers();
        const { points: pts, mode: m, onSelect: select } = live.current;
        const place = (x: number, y: number, el: HTMLElement, px: number, title: string, onClick: () => void, attrs: Record<string, string>) => {
          const pos = percentToLatLng(size, x, y);
          if (!pos) return;
          const icon = L.divIcon({ html: el, className: "azd-icon", iconSize: [px, px], iconAnchor: [px / 2, px / 2] });
          const mk = L.marker(pos, { icon, title, keyboard: true, riseOnHover: true }).addTo(layer);
          mk.bindTooltip(title, { direction: "top", offset: [0, -px / 2], opacity: 0.95 });
          mk.on("click", onClick);
          const e = mk.getElement();
          if (e) {
            e.setAttribute("role", "button");
            e.setAttribute("aria-label", title);
            for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
            // Leaflet's own Enter handling is unreliable across browsers; make the marker a real keyboard button.
            e.addEventListener("keydown", (ev) => {
              if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); onClick(); }
            });
          }
        };
        if (m === "markers") {
          for (const p of pts) {
            const px = 10 + Math.min(8, Math.round(Math.sqrt(p.observations)));
            place(p.x, p.y, dot(KIND_FILL[p.lootKind], px), px,
              `${p.sourceName} · ${p.observations} obs.`, () => select({ kind: "point", point: p }),
              { "data-marker-id": p.id, "data-x": String(p.x), "data-y": String(p.y) });
          }
        } else {
          const cell = BASE_CELL_PERCENT / 2 ** (map.getZoom() - map.getMinZoom());
          for (const c of clusterPoints(pts, cell)) {
            const px = c.pointCount === 1 ? 14 : Math.min(46, 24 + Math.round(Math.sqrt(c.pointCount) * 4));
            const top = c.points.reduce((a, b) => (b.observations > a.observations ? b : a));
            place(c.x, c.y, dot(KIND_FILL[top.lootKind], px, c.pointCount > 1 ? String(c.pointCount) : undefined), px,
              c.pointCount > 1 ? `${c.pointCount} locations · ${c.observations} obs. · ${c.label}` : `${top.sourceName} · ${c.observations} obs.`,
              () => {
                if (c.pointCount > 1 && map.getZoom() < map.getMaxZoom()) {
                  const ll = c.points.map((p) => percentToLatLng(size, p.x, p.y)!);
                  map.flyToBounds(L.latLngBounds(ll).pad(0.4), { maxZoom: map.getMaxZoom(), duration: 0.4 });
                } else select({ kind: "cluster", cluster: c });
              },
              { "data-cluster-count": String(c.pointCount), "data-x": c.x.toFixed(3), "data-y": c.y.toFixed(3) });
          }
        }
      };

      map.on("zoomend", () => { if (live.current.mode === "clusters") render(); });
      map.on("click", () => live.current.onSelect(null));
      const ro = new ResizeObserver(() => {
        const wasFit = map.getZoom() <= map.getMinZoom() + 0.01;
        map.invalidateSize({ animate: false });
        map.setMinZoom(fitZoom());
        map.setMaxZoom(fitZoom() + MAX_EXTRA_ZOOM);
        if (wasFit) map.fitBounds(bounds, { animate: false });
      });
      ro.observe(host.current);

      api.current = { map, render, fit };
      render();
      setReady(true);
      cleanup = () => { ro.disconnect(); map.remove(); api.current = null; };
    })();
    return () => { disposed = true; cleanup(); setReady(false); };
    // The map is rebuilt only when the surface itself changes; data/mode flow through `render`.
  }, [size.width, size.height, imageUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { api.current?.render(); }, [points, mode, ready]);
  useEffect(() => { if (resetKey > 0) api.current?.fit(); }, [resetKey]);

  return (
    <div
      ref={host}
      role="application"
      aria-label={label}
      data-testid="zone-map"
      data-ready={ready ? "true" : "false"}
      className="azd-map h-[58vh] min-h-[22rem] w-full overflow-hidden rounded-md border border-ink-600 bg-ink-900 sm:h-[34rem]"
    />
  );
}
