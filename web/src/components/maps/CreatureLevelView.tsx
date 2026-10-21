"use client";

import Link from "next/link";
import { useCallback, useSyncExternalStore } from "react";
import type { LocationPoint } from "@/lib/data/types";
import { fmtInt } from "@/lib/format";
import { filterByLevel, levelFromHash, parseLevelParam, type LevelOption } from "@/lib/maps/creature-levels";
import { zonePath } from "@/lib/routes";
import type { SourceZoneView } from "@/lib/maps/source-zone-views";
import { LocationPlot } from "../LocationPlot";
import { SourceLocationMaps } from "./SourceLocationMaps";

interface Props {
  sourceName: string;
  assetBase: string | null;
  options: LevelOption[];
  /** `?level=` resolved on the server (observed levels only), so the first paint already shows the chosen level. */
  initialLevel: number | null;
  /** Server-rendered loot/skinning statistics of each level, keyed by level (each is its own sample). */
  sections: Record<number, React.ReactNode>;
  /** Zones with artwork and/or published cells for the map. Null: map artwork is off, the plain coordinate grids are shown instead. */
  zones: SourceZoneView[] | null;
  /** Plain-grid fallback data when `zones` is null (all observed zones, levels preserved). */
  plainZones: { mapId: number; zoneName: string; locations: LocationPoint[] }[];
  /** Observed zones for the link list (zone pages). */
  zoneLinks: { mapId: number; zoneName: string; observations: number | null }[];
}

// The selected level lives in the URL (`?level=N`, or the `#level-N` anchor the rest of the site links to): one source of truth that
// survives reloads and shares, and that needs no effect to synchronize. Changes are made with replaceState (no history entry per click).
//
// Next.js navigates within a page (a next/link or router.push to `/creature/<id>#level-N`) with history.pushState, which fires neither
// `hashchange` nor `popstate`. While anyone is subscribed, pushState/replaceState are therefore wrapped to notify (and restored afterwards),
// so same-page client-side transitions update the level exactly like native anchors, back/forward and the selector do.
const listeners = new Set<() => void>();
const notify = () => { for (const l of [...listeners]) l(); };

function watchHistory(): () => void {
  const { pushState, replaceState } = window.history;
  const wrap = (orig: History["pushState"]): History["pushState"] =>
    function (this: History, ...args) { const r = orig.apply(this, args); notify(); return r; };
  const push = wrap(pushState);
  const replace = wrap(replaceState);
  window.history.pushState = push;
  window.history.replaceState = replace;
  return () => {
    if (window.history.pushState === push) window.history.pushState = pushState;
    if (window.history.replaceState === replace) window.history.replaceState = replaceState;
  };
}

let stopWatching: (() => void) | null = null;
const subscribe = (cb: () => void) => {
  if (listeners.size === 0) stopWatching = watchHistory();
  listeners.add(cb);
  window.addEventListener("hashchange", cb);
  window.addEventListener("popstate", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("hashchange", cb);
    window.removeEventListener("popstate", cb);
    if (listeners.size === 0) { stopWatching?.(); stopWatching = null; }
  };
};
const urlSnapshot = () => window.location.search + window.location.hash;

function writeLevel(level: number | null) {
  const url = new URL(window.location.href);
  if (level == null) url.searchParams.delete("level"); else url.searchParams.set("level", String(level));
  url.hash = "";
  window.history.replaceState(window.history.state, "", url.pathname + url.search); // notifies subscribers
}

export function CreatureLevelView({ sourceName, assetBase, options, initialLevel, sections, zones, plainZones, zoneLinks }: Props) {
  // Server snapshot mirrors the initial level in the same shape the client reads from the URL.
  const serverSnapshot = useCallback(() => (initialLevel == null ? "" : `?level=${initialLevel}`), [initialLevel]);
  const snap = useSyncExternalStore(subscribe, urlSnapshot, serverSnapshot);
  const [search, hash] = snap.split("#");
  const fromHash = levelFromHash(hash ? `#${hash}` : "", options);
  const fromQuery = parseLevelParam(new URLSearchParams(search).get("level"), options);
  const level = fromHash ?? fromQuery;
  const multi = options.length > 1;
  const select = (l: number | null) => writeLevel(l);
  const selected = options.find((o) => o.level === level) ?? null;

  return (
    <>
      {multi && (
        <nav aria-label="Creature level" className="space-y-2" data-testid="level-selector" data-selected-level={level ?? "all"}>
          <div role="group" aria-label="Show data for level" className="flex flex-wrap gap-2">
            <button type="button" className={`btn-ghost text-sm ${level == null ? "border-violet-300 bg-ink-700 text-parchment" : ""}`}
              aria-pressed={level == null} data-level="all" onClick={() => select(null)}>All levels</button>
            {options.map((o) => (
              <button key={o.level} type="button" className={`btn-ghost text-sm ${o.level === level ? "border-violet-300 bg-ink-700 text-parchment" : ""}`}
                aria-pressed={o.level === level} data-level={o.level} onClick={() => select(o.level)}>
                {o.label} <span className="text-mist">· {fmtInt(o.observations)} obs.</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-mist">
            {selected
              ? <>Showing {selected.label.toLowerCase()} only: its own loot and skinning statistics and map markers. Other levels are hidden, never added to these numbers.</>
              : <>Showing every observed level, each with its own statistics. Pick a level to filter the map and focus its loot and skinning data.</>}
          </p>
        </nav>
      )}

      {options.map((o) => (
        <div key={o.level} hidden={level != null && o.level !== level} data-level-section={o.level}>{sections[o.level]}</div>
      ))}

      <section aria-labelledby="loc-title" className="space-y-4">
        <h2 id="loc-title" className="panel-title text-2xl">Where it was observed{selected ? ` · ${selected.label}` : ""}</h2>
        {zoneLinks.length === 0 ? <p className="text-sm text-mist">No located observations.</p> : (
          <>
            <ul className="flex flex-wrap gap-2">
              {zoneLinks.map((z) => (
                <li key={z.mapId}><Link className="btn-ghost text-sm" href={zonePath(z.mapId)}>{z.zoneName} <span className="text-mist">· {z.observations != null ? fmtInt(z.observations) : "n/a"}</span></Link></li>
              ))}
            </ul>
            <p className="text-xs text-mist">
              Positions are aggregated to an approximate 1% map grid and cells with very few observations are hidden.
              {zones?.length ? <> Map registration is provisional; see <Link href="/about/data#maps">about the map data</Link>.</> : <>{" "}Map artwork is not shown — see <Link href="/about/data#maps">why</Link>.</>}
            </p>
            {selected && (
              <p className="text-sm"><a href={`#level-${selected.level}`} data-testid="level-stats-link" className="underline decoration-dotted underline-offset-2 hover:text-gold-300">Jump to {selected.label} loot and skinning statistics</a></p>
            )}
            {zones?.length ? (
              <SourceLocationMaps sourceName={sourceName} assetBase={assetBase} zones={zones} level={level} levelSelector={multi} onShowAllLevels={() => select(null)} />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2" data-testid="source-plain-grids">
                {plainZones.map((z) => (
                  <LocationPlot key={z.mapId} mapId={z.mapId} points={filterByLevel(z.locations, level)} zoneName={z.zoneName} />
                ))}
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
