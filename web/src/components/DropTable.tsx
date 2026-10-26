import type { DropRow } from "@/lib/data/types";
import { displayId, fmtAvgStack, fmtInt } from "@/lib/format";
import { itemPath, sourcePath } from "@/lib/routes";
import { ConfidenceBadge, DisplayKindBadge, LootKindBadge } from "./Badges";
import { EntityLink } from "./EntityLink";
import { ObservationStat } from "./ObservationStat";
import { RateCell } from "./RateCell";

function rowKey(d: DropRow): string {
  return `${d.source.type}-${d.source.id}-${d.source.level}-${d.lootKind}-${d.item.id}`;
}

/** The row's subject entity: the source for `perspective="item"`, the item for `perspective="source"` - shared so the desktop row and the mobile card never disagree on identity, link or label. */
function subject(d: DropRow, perspective: "item" | "source") {
  if (perspective === "item") {
    const sid = displayId(d.source.type, d.source.id);
    const level = d.source.type === "creature" ? (d.source.level > 0 ? `Lvl ${d.source.level}` : "Lvl ? (historical)") : null;
    return { href: sourcePath(d.source.type, d.source.id, d.source.level), tooltip: `/api/v1/tooltip/source/${d.source.type}/${d.source.id}`, name: d.source.name, id: sid, level, kindBadge: <DisplayKindBadge kind={d.source.displayKind} /> };
  }
  return { href: itemPath(d.item.id), tooltip: `/api/v1/tooltip/item/${d.item.id}`, name: d.item.name, id: String(d.item.id), level: null, kindBadge: null };
}

/**
 * Observation table. `perspective="item"` lists sources of an item;
 * `perspective="source"` lists items dropped by a source.
 *
 * Renders both presentations of the SAME rows: a table for desktop (`hidden sm:block`) and a
 * stacked card list for narrow viewports (`sm:hidden`), the same dual-rendering pattern as
 * ResultsTable.tsx. `hidden` is `display: none`, so whichever is inactive is out of the
 * accessibility tree and tab order - never a hidden duplicate link or hidden duplicate control.
 */
export function DropTable({ rows, perspective, caption }: { rows: DropRow[]; perspective: "item" | "source"; caption: string }) {
  return (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-ink-700 sm:block" tabIndex={0} role="region" aria-label={caption}>
        <table className="data-table">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">{perspective === "item" ? "Source" : "Item"}</th>
              <th scope="col">Method</th>
              <th scope="col" className="num">Observed drop rate</th>
              <th scope="col" className="num"><abbr title="Times the item was seen / number of observed loots">Seen / samples</abbr></th>
              <th scope="col" className="num">Avg stack</th>
              <th scope="col">Sample quality</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const s = subject(d, perspective);
              return (
                <tr key={rowKey(d)}>
                  <td>
                    <span className="flex flex-wrap items-center gap-2">
                      <EntityLink href={s.href} tooltip={s.tooltip}>{s.name}</EntityLink>
                      {s.kindBadge}
                      {s.level && <span className="text-xs text-mist">{s.level}</span>}
                      {s.id && <span className="font-[family-name:var(--font-mono)] text-[0.7rem] text-mist">#{s.id}</span>}
                    </span>
                  </td>
                  <td><LootKindBadge kind={d.lootKind} /></td>
                  <td className="num"><RateCell d={d} /></td>
                  <td className="num text-mist">{fmtInt(d.drops)} / {fmtInt(d.observations)}</td>
                  <td className="num text-mist">{fmtAvgStack(d.quantity, d.drops)}</td>
                  <td><ConfidenceBadge confidence={d.confidence} dominated={d.dominated} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 sm:hidden" aria-label={caption}>
        {rows.map((d) => {
          const s = subject(d, perspective);
          return (
            <li key={rowKey(d)}>
              <div className="panel space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0 break-words font-semibold text-parchment">
                    <EntityLink href={s.href} tooltip={s.tooltip}>{s.name}</EntityLink>
                    {s.level && <span className="ml-2 text-xs font-normal text-mist">{s.level}</span>}
                  </span>
                  {s.kindBadge}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {s.id && <span className="font-[family-name:var(--font-mono)] text-xs text-mist">#{s.id}</span>}
                  <LootKindBadge kind={d.lootKind} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <ObservationStat label="Observed rate"><RateCell d={d} /></ObservationStat>
                  <ObservationStat label="Seen / samples">{fmtInt(d.drops)} / {fmtInt(d.observations)}</ObservationStat>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <ObservationStat label="Avg stack">{fmtAvgStack(d.quantity, d.drops)}</ObservationStat>
                  <ObservationStat label="Sample quality"><ConfidenceBadge confidence={d.confidence} dominated={d.dominated} wrap /></ObservationStat>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
