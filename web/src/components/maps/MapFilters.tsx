"use client";

import { KIND_FILL } from "@/components/LocationPlot";
import type { LootKind } from "@/lib/data/types";
import { LOOT_KIND_LABEL, fmtInt } from "@/lib/format";
import { LEVELED_KINDS, type MapFilterState } from "@/lib/maps/observations";
import type { MapMode } from "./ZoneMapViewer";

interface Props {
  /** Categories actually present in the data with their point counts (never invented). */
  available: Partial<Record<LootKind, number>>;
  filter: MapFilterState;
  levels: { min: number; max: number } | null;
  mode: MapMode;
  onFilter: (f: MapFilterState) => void;
  onMode: (m: MapMode) => void;
  onReset: () => void;
}

const num = (v: string) => (v.trim() === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(999, Math.floor(Number(v)))));

export function MapFilters({ available, filter, levels, mode, onFilter, onMode, onReset }: Props) {
  const kinds = (Object.keys(available) as LootKind[]).sort((a, b) => (available[b] ?? 0) - (available[a] ?? 0));
  const active = filter.kinds.size > 0 || filter.levelMin != null || filter.levelMax != null;
  const toggle = (k: LootKind) => {
    const next = new Set(filter.kinds);
    if (next.has(k)) next.delete(k); else next.add(k);
    onFilter({ ...filter, kinds: next });
  };
  const levelApplies = filter.kinds.size === 0 || [...filter.kinds].some((k) => LEVELED_KINDS.has(k));
  return (
    <div className="panel space-y-4 p-4" role="group" aria-label="Map controls">
      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="panel-title text-base">Categories</h2>
          {active && <span className="text-xs font-semibold text-violet-300" data-testid="filter-active">Filter active</span>}
        </div>
        <ul className="flex flex-wrap gap-2" aria-label="Category filters">
          {kinds.map((k) => {
            const on = filter.kinds.has(k);
            return (
              <li key={k}>
                <button type="button" aria-pressed={on} data-kind={k} onClick={() => toggle(k)}
                  className={`btn-ghost inline-flex items-center gap-1.5 text-sm ${on ? "border-violet-300 bg-ink-700 text-parchment" : ""}`}>
                  <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden="true"><circle cx="5" cy="5" r="4" fill={KIND_FILL[k]} /></svg>
                  {LOOT_KIND_LABEL[k]} <span className="text-mist">{fmtInt(available[k] ?? 0)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {levels && (
        <fieldset className="space-y-1" disabled={!levelApplies}>
          <legend className="text-xs font-semibold uppercase tracking-wide text-mist">Creature level (creature loot &amp; skinning)</legend>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="lvl-min">Minimum level</label>
            <input id="lvl-min" className="field w-20" type="number" inputMode="numeric" min={levels.min} max={levels.max}
              placeholder={String(levels.min)} value={filter.levelMin ?? ""} onChange={(e) => onFilter({ ...filter, levelMin: num(e.target.value) })} />
            <span className="text-mist" aria-hidden="true">–</span>
            <label className="sr-only" htmlFor="lvl-max">Maximum level</label>
            <input id="lvl-max" className="field w-20" type="number" inputMode="numeric" min={levels.min} max={levels.max}
              placeholder={String(levels.max)} value={filter.levelMax ?? ""} onChange={(e) => onFilter({ ...filter, levelMax: num(e.target.value) })} />
          </div>
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div role="radiogroup" aria-label="Marker mode" className="inline-flex overflow-hidden rounded-md border border-ink-600">
          {(["markers", "clusters"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} data-mode={m} onClick={() => onMode(m)}
              className={`px-3 py-1.5 text-sm ${mode === m ? "bg-violet-600 text-parchment" : "bg-ink-900 text-mist hover:text-parchment"}`}>
              {m === "markers" ? "Markers" : "Clusters"}
            </button>
          ))}
        </div>
        <button type="button" className="btn-ghost text-sm" onClick={onReset} data-testid="fit-view">Fit / reset view</button>
        <button type="button" className="btn-ghost text-sm" disabled={!active} onClick={() => onFilter({ kinds: new Set(), levelMin: null, levelMax: null })}>Clear filters</button>
      </div>
    </div>
  );
}
