import type { LootKind } from "@/lib/data/types";
import { LOOT_KIND_LABEL, fmtInt } from "@/lib/format";
import type { MapCluster, MapPoint } from "./observations";

/** Published coordinates are shown exactly as published (no padding / invented precision). */
export const formatCoord = (v: number) => String(v);
export const formatPair = (x: number, y: number) => `${formatCoord(x)}, ${formatCoord(y)}`;

/** Computed centroids are not published values; one decimal is shown and always labelled approximate. */
export const formatCentroid = (x: number, y: number) => `${x.toFixed(1)}, ${y.toFixed(1)}`;

const obs = (n: number) => `${fmtInt(n)} ${n === 1 ? "observation" : "observations"}`;

export function pointTooltipLines(p: MapPoint): string[] {
  return [p.sourceName, `Coordinates: ${formatPair(p.x, p.y)}`, `${LOOT_KIND_LABEL[p.lootKind]} · ${obs(p.observations)}`];
}

export function pointAriaLabel(p: MapPoint): string {
  return `${p.sourceName}, ${LOOT_KIND_LABEL[p.lootKind]}, coordinates X ${formatCoord(p.x)}, Y ${formatCoord(p.y)}, ${obs(p.observations)}`;
}

export function clusterTitle(c: MapCluster): string {
  const kinds = new Set<LootKind>(c.points.map((p) => p.lootKind));
  return kinds.size === 1 ? `${LOOT_KIND_LABEL[[...kinds][0]!]} cluster` : "Mixed cluster";
}

export function clusterTooltipLines(c: MapCluster): string[] {
  return [
    clusterTitle(c),
    `${fmtInt(c.pointCount)} locations · ${obs(c.observations)}`,
    `Approximate cluster centre: ${formatCentroid(c.x, c.y)}`,
  ];
}

export function clusterAriaLabel(c: MapCluster): string {
  return `${clusterTitle(c)}, ${fmtInt(c.pointCount)} locations, ${obs(c.observations)}, approximate cluster centre X ${c.x.toFixed(1)}, Y ${c.y.toFixed(1)}, not an observed position`;
}
