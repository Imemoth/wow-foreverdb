import "server-only";
import type { ItemDetail, SourceDetail } from "./data/types";
import { LOOT_KIND_LABEL, fmtInt, fmtRate, sourceTypeLabel } from "./format";

export interface Tooltip { title: string; subtitle: string; lines: string[] }

export function itemTooltip(d: ItemDetail): Tooltip {
  const top = d.drops.slice(0, 3).map((x) =>
    `${x.source.name}${x.source.type === "creature" && x.source.level > 0 ? ` (L${x.source.level})` : ""} — ${LOOT_KIND_LABEL[x.lootKind]}: ${fmtRate(x.rate, x.confidence)} of ${fmtInt(x.observations)}`);
  return {
    title: d.item.name,
    subtitle: `Item ${d.item.id} · ${fmtInt(d.item.sourceCount)} observed source${d.item.sourceCount === 1 ? "" : "s"}`,
    lines: top.length ? top : ["No published source observations"],
  };
}

export function sourceTooltip(s: SourceDetail): Tooltip {
  const v = s.variants[0]!;
  const total = s.variants.reduce((a, x) => a + x.totalObservations, 0);
  const kinds = [...new Set(s.variants.flatMap((x) => x.buckets.map((b) => LOOT_KIND_LABEL[b.lootKind])))];
  const levels = s.type === "creature" ? s.variants.map((x) => (x.level > 0 ? x.level : "?")).join(", ") : null;
  const topItems = [...new Map(s.variants.flatMap((x) => x.drops).map((d) => [d.item.id, d.item.name])).values()].slice(0, 3);
  return {
    title: v.name,
    subtitle: `${sourceTypeLabel(s.type, s.id)}${levels ? ` · level ${levels}` : ""} · ${fmtInt(total)} observations`,
    lines: [kinds.join(", "), ...(topItems.length ? [`Seen: ${topItems.join(", ")}`] : [])],
  };
}
