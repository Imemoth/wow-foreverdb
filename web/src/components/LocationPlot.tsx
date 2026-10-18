import type { LocationPoint, LootKind } from "@/lib/data/types";
import { LOOT_KIND_LABEL, fmtInt } from "@/lib/format";

const KIND_FILL: Record<LootKind, string> = {
  mob: "#ec8b80", skinning: "#d9b88f", mining: "#de9a62", herbalism: "#86d67e", fishing: "#6cbcef",
  fishing_pool: "#5ccdd3", chest: "#e6b95c", gameobject: "#c3aeea", disenchant: "#d0a0f5",
};

/**
 * Coordinate-only location view (no map artwork: Blizzard imagery is not
 * redistributed — see docs/web/maps-and-assets.md). Points are aggregated,
 * quantized cells; marker area scales with observations.
 *
 * The "Arcane Survey" decorative pass (Phase 2 cartography) only touches
 * elements painted *before* the markers (background glow, grid/border tint)
 * and never changes the viewBox, the `p.x`/`p.y` coordinates, or marker
 * geometry - a styling-only change to shared paint-order ancestors of the
 * markers cannot desynchronize their positions.
 */
export function LocationPlot({ points, zoneName, mapId }: { points: LocationPoint[]; zoneName: string; mapId: number }) {
  const gridId = `grid-${mapId}`;
  const glowId = `glow-${mapId}`;
  const max = Math.max(1, ...points.map((p) => p.observations));
  const kinds = [...new Set(points.map((p) => p.lootKind))];
  const top = [...points].sort((a, b) => b.observations - a.observations).slice(0, 8);
  const total = points.reduce((a, p) => a + p.observations, 0);
  return (
    <figure className="panel p-4">
      <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold text-parchment">{zoneName}</span>
        <span className="text-xs text-mist">{fmtInt(points.length)} aggregated cells · {fmtInt(total)} located observations · approximate 1% grid</span>
      </figcaption>
      <svg viewBox="-2 -2 104 104" className="aspect-square w-full max-w-[28rem] rounded-md bg-ink-900"
        role="img" aria-label={`Observed location density in ${zoneName}: ${points.length} cells. A text summary follows.`}>
        <defs>
          <pattern id={gridId} width="10" height="10" patternUnits="userSpaceOnUse">
            <path d="M10 0H0V10" fill="none" stroke="#2c2d66" strokeWidth="0.25" />
          </pattern>
          <radialGradient id={glowId} cx="28%" cy="22%" r="75%">
            <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect x="-2" y="-2" width="104" height="104" fill={`url(#${glowId})`} aria-hidden="true" />
        {/* Compass corner ticks: purely decorative, confined to the outer margin outside the 0-100 data square. */}
        <g stroke="#D9B978" strokeOpacity="0.4" strokeWidth="0.5" strokeLinecap="round" aria-hidden="true">
          <path d="M-2 -0.5V-2H-0.5" fill="none" />
          <path d="M102 -0.5V-2H100.5" fill="none" />
          <path d="M-2 100.5V102H-0.5" fill="none" />
          <path d="M102 100.5V102H100.5" fill="none" />
        </g>
        <rect x="0" y="0" width="100" height="100" fill={`url(#${gridId})`} stroke="#D9B978" strokeOpacity="0.4" strokeWidth="0.4" />
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={0.9 + 2.6 * Math.sqrt(p.observations / max)}
            fill={KIND_FILL[p.lootKind]} fillOpacity="0.55" stroke={KIND_FILL[p.lootKind]} strokeWidth="0.3" />
        ))}
      </svg>
      <ul className="mt-3 flex flex-wrap gap-3 text-xs text-mist" aria-label="Legend">
        {kinds.map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden="true"><circle cx="5" cy="5" r="4" fill={KIND_FILL[k]} /></svg>
            {LOOT_KIND_LABEL[k]}
          </li>
        ))}
      </ul>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-mist">Densest cells (text)</summary>
        <ul className="mt-2 space-y-1">
          {top.map((p, i) => (
            <li key={i} className="text-mist">
              <span className="font-[family-name:var(--font-mono)] text-parchment">{p.x.toFixed(0)}, {p.y.toFixed(0)}</span>
              {p.subzone && <> · {p.subzone}</>} · {LOOT_KIND_LABEL[p.lootKind]} · {fmtInt(p.observations)} obs.
            </li>
          ))}
        </ul>
      </details>
    </figure>
  );
}
