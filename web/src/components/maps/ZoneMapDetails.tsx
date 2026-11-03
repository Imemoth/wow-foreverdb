"use client";

import Link from "next/link";
import { LOOT_KIND_LABEL, fmtInt, sourceTypeLabel } from "@/lib/format";
import { formatCentroid, formatPair } from "@/lib/maps/marker-text";
import type { MapPoint } from "@/lib/maps/observations";
import { sourcePath } from "@/lib/routes";
import type { Selection } from "./ZoneMapViewer";

/** Link to the source's own page (creature levels are anchored; fishing pools / objects by id). Internal, route-built paths only. */
export function SourceLink({ p, children }: { p: MapPoint; children: React.ReactNode }) {
  return <Link href={sourcePath(p.sourceType, p.sourceId, p.level)} data-testid="detail-source-link" className="underline decoration-dotted underline-offset-2 hover:text-gold-300">{children}</Link>;
}

function PointLine({ p }: { p: MapPoint }) {
  return <span className="text-mist"><SourceLink p={p}><span className="text-parchment">{p.sourceName}</span></SourceLink> · {LOOT_KIND_LABEL[p.lootKind]} · {fmtInt(p.observations)} obs.</span>;
}

function PointDetail({ p }: { p: MapPoint }) {
  return (
    <dl className="space-y-1">
      <dt className="sr-only">Source</dt><dd className="font-semibold text-parchment"><SourceLink p={p}>{p.sourceName}</SourceLink></dd>
      <dt className="text-xs uppercase tracking-wide text-mist">Category</dt><dd>{LOOT_KIND_LABEL[p.lootKind]}</dd>
      <dt className="text-xs uppercase tracking-wide text-mist">Source type</dt><dd>{sourceTypeLabel(p.sourceType, p.sourceId)}</dd>
      {(p.lootKind === "mob" || p.lootKind === "skinning") && (<><dt className="text-xs uppercase tracking-wide text-mist">Level</dt><dd>{p.level}</dd></>)}
      <dt className="text-xs uppercase tracking-wide text-mist">Area</dt><dd>{p.subzone || "—"}</dd>
      <dt className="text-xs uppercase tracking-wide text-mist">Coordinates (X, Y)</dt><dd data-testid="detail-coords" className="font-[family-name:var(--font-mono)]">{formatPair(p.x, p.y)}</dd>
      <dt className="text-xs uppercase tracking-wide text-mist">Observations</dt><dd>{fmtInt(p.observations)}</dd>
      <dd className="pt-1 text-xs text-mist">Aggregated map cell (approximate 1% grid), not an exact spawn point.</dd>
    </dl>
  );
}

export function ZoneMapDetails({ selected, className = "" }: { selected: Selection | null; className?: string }) {
  return (
    <aside className={`panel space-y-2 p-4 text-sm ${className}`} aria-live="polite" data-testid="detail-panel">
      <h2 className="panel-title text-base">Details</h2>
      {!selected && <p className="text-mist">Select a marker to see its observation details.</p>}
      {selected?.kind === "point" && <PointDetail p={selected.point} />}
      {selected?.kind === "cluster" && (
        <>
          <p className="text-parchment">{selected.cluster.pointCount} locations · {fmtInt(selected.cluster.observations)} observations</p>
          <p className="text-mist">{selected.cluster.label}</p>
          <p data-testid="detail-coords" className="text-mist">
            Approximate cluster centre (X, Y): <span className="font-[family-name:var(--font-mono)] text-parchment">{formatCentroid(selected.cluster.x, selected.cluster.y)}</span>
            <span className="block text-xs">Computed average of the listed locations, not an observed position.</span>
          </p>
          <ul className="space-y-1">
            {selected.cluster.points.slice(0, 8).map((p) => <li key={p.id}><PointLine p={p} /></li>)}
          </ul>
        </>
      )}
    </aside>
  );
}
