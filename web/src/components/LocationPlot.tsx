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
 */
export function LocationPlot({ points, zoneName, mapId }: { points: LocationPoint[]; zoneName: string; mapId: number }) {
  const gridId = `grid-${mapId}`;
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
            <path d="M10 0H0V10" fill="none" stroke="#262d3b" strokeWidth="0.25" />
          </pattern>
        </defs>
        <rect x="0" y="0" width="100" height="100" fill={`url(#${gridId})`} stroke="#364055" strokeWidth="0.4" />
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
