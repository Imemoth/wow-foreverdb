import type { SearchRow, ZoneEntityRow, ZoneSummary } from "@/lib/data/types";
import { displayId, fmtInt } from "@/lib/format";
import { entityPath, zonePath } from "@/lib/routes";
import { DisplayKindBadge, LootKindBadge } from "./Badges";
import { EntityLink } from "./EntityLink";
import Link from "next/link";

/**
 * Search rows carry GLOBAL observation counts (label them as such). Zone-directory
 * rows carry the ZONE-SPECIFIC measured count, which is null ("not measured") for
 * items: the association is inferred through sources and no per-zone drop count exists.
 */
export function ResultsTable({ rows, zones, caption, observationsLabel = "Observations (all zones)" }: {
  rows: (SearchRow | ZoneEntityRow)[]; zones: ZoneSummary[]; caption: string; observationsLabel?: string;
}) {
  const zoneName = new Map(zones.map((z) => [z.mapId, z.zoneName]));
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-700" tabIndex={0} role="region" aria-label={caption}>
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col">Acquisition</th>
            <th scope="col">Zones</th>
            <th scope="col" className="num">{observationsLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = r.entityKind === "item" ? `i-${r.itemId}` : `s-${r.sourceType}-${r.sourceId}-${r.sourceLevel}`;
            const id = r.entityKind === "item" ? String(r.itemId) : displayId(r.sourceType, r.sourceId!);
            const tooltip = r.entityKind === "item" ? `/api/v1/tooltip/item/${r.itemId}` : `/api/v1/tooltip/source/${r.sourceType}/${r.sourceId}`;
            return (
              <tr key={key}>
                <td>
                  <span className="flex flex-wrap items-center gap-2">
                    <EntityLink href={entityPath(r)} tooltip={tooltip}>{r.name}</EntityLink>
                    {r.sourceType === "creature" && r.sourceLevel != null && (
                      <span className="text-xs text-mist">{r.sourceLevel > 0 ? `Lvl ${r.sourceLevel}` : "Lvl ?"}</span>
                    )}
                    {id && <span className="font-[family-name:var(--font-mono)] text-[0.7rem] text-mist">#{id}</span>}
                  </span>
                </td>
                <td><DisplayKindBadge kind={r.displayKind} /></td>
                <td><span className="flex flex-wrap gap-1">{r.lootKinds.map((k) => <LootKindBadge key={k} kind={k} />)}</span></td>
                <td className="text-mist">
                  {r.mapIds.length === 0 ? <span className="text-xs">—</span> : r.mapIds.slice(0, 3).map((m, i) => (
                    <span key={m}>{i > 0 && ", "}<Link href={zonePath(m)} className="text-mist hover:text-gold-300">{zoneName.get(m) ?? `Zone ${m}`}</Link></span>
                  ))}
                  {r.mapIds.length > 3 && <span className="text-xs"> +{r.mapIds.length - 3}</span>}
                </td>
                <td className="num text-mist">
                  {r.observations != null ? fmtInt(r.observations) : (
                    <span title="Items are linked to this zone through sources observed here. ForeverDB has no zone-specific drop count for them.">
                      Not measured
                      {"associatedSourceCount" in r && r.associatedSourceCount != null && (
                        <span className="block text-[0.7rem]">inferred via {fmtInt(r.associatedSourceCount)} source{r.associatedSourceCount === 1 ? "" : "s"}</span>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
