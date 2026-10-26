import type { SearchRow, ZoneEntityRow, ZoneSummary } from "@/lib/data/types";
import { displayId, fmtInt } from "@/lib/format";
import { entityPath, zonePath } from "@/lib/routes";
import { DisplayKindBadge, LootKindBadge } from "./Badges";
import { EntityLink } from "./EntityLink";
import Link from "next/link";

/** Shared per-row derivations so the desktop table and mobile cards never disagree on identity or links. */
function rowMeta(r: SearchRow | ZoneEntityRow) {
  const key = r.entityKind === "item" ? `i-${r.itemId}` : `s-${r.sourceType}-${r.sourceId}-${r.sourceLevel}`;
  const id = r.entityKind === "item" ? String(r.itemId) : displayId(r.sourceType, r.sourceId!);
  const tooltip = r.entityKind === "item" ? `/api/v1/tooltip/item/${r.itemId}` : `/api/v1/tooltip/source/${r.sourceType}/${r.sourceId}`;
  return { key, id, tooltip, href: entityPath(r) };
}

function ObservationsValue({ r }: { r: SearchRow | ZoneEntityRow }) {
  if (r.observations != null) return <>{fmtInt(r.observations)}</>;
  return (
    <span title="Items are linked to this zone through sources observed here. AzerDex has no zone-specific drop count for them.">
      Not measured
      {"associatedSourceCount" in r && r.associatedSourceCount != null && (
        <span className="block text-[0.7rem]">inferred via {fmtInt(r.associatedSourceCount)} source{r.associatedSourceCount === 1 ? "" : "s"}</span>
      )}
    </span>
  );
}

/**
 * Search rows carry GLOBAL observation counts (label them as such). Zone-directory rows carry the
 * ZONE-SPECIFIC measured count, which is null ("not measured") for items: the association is
 * inferred through sources and no per-zone drop count exists.
 *
 * Renders both presentations of the SAME rows: a table for desktop (`hidden sm:block` wrapper) and
 * a stacked card list for narrow viewports (`sm:hidden`). Tailwind's `hidden` is `display: none`, so
 * whichever one is inactive is removed from layout, the accessibility tree and the tab order - there
 * is never a duplicate link or hidden-but-focusable copy of a row exposed at the same time.
 */
export function ResultsTable({ rows, zones, caption, observationsLabel = "Observations (all zones)" }: {
  rows: (SearchRow | ZoneEntityRow)[]; zones: ZoneSummary[]; caption: string; observationsLabel?: string;
}) {
  const zoneName = new Map(zones.map((z) => [z.mapId, z.zoneName]));
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-ink-700 sm:block" tabIndex={0} role="region" aria-label={caption}>
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
              const { key, id, tooltip, href } = rowMeta(r);
              return (
                <tr key={key}>
                  <td>
                    <span className="flex flex-wrap items-center gap-2">
                      <EntityLink href={href} tooltip={tooltip}>{r.name}</EntityLink>
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
                  <td className="num text-mist"><ObservationsValue r={r} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 sm:hidden" aria-label={caption}>
        {rows.map((r) => {
          const { key, id, href } = rowMeta(r);
          return (
            <li key={key}>
              <Link href={href} className="panel block space-y-2 p-4 no-underline transition hover:border-gold-500/60">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words font-semibold text-parchment">
                    {r.name}
                    {r.sourceType === "creature" && r.sourceLevel != null && (
                      <span className="ml-2 text-xs font-normal text-mist">{r.sourceLevel > 0 ? `Lvl ${r.sourceLevel}` : "Lvl ?"}</span>
                    )}
                  </span>
                  <DisplayKindBadge kind={r.displayKind} />
                </div>
                {id && <p className="font-[family-name:var(--font-mono)] text-xs text-mist">ID: {id}</p>}
                {r.lootKinds.length > 0 && (
                  <p className="flex flex-wrap gap-1">{r.lootKinds.map((k) => <LootKindBadge key={k} kind={k} />)}</p>
                )}
                <p className="text-sm text-mist">
                  <span className="text-xs font-semibold uppercase tracking-wide text-mist/80">Zone: </span>
                  {r.mapIds.length === 0 ? "—" : r.mapIds.slice(0, 3).map((m) => zoneName.get(m) ?? `Zone ${m}`).join(", ")}
                  {r.mapIds.length > 3 && ` +${r.mapIds.length - 3}`}
                </p>
                <p className="text-sm text-mist">
                  <span className="text-xs font-semibold uppercase tracking-wide text-mist/80">{observationsLabel}: </span>
                  <ObservationsValue r={r} />
                </p>
                <span className="inline-block text-sm font-semibold text-violet-300">View details →</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
