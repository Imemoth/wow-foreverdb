import type { DropRow } from "@/lib/data/types";
import { displayId, fmtAvgStack, fmtInt } from "@/lib/format";
import { itemPath, sourcePath } from "@/lib/routes";
import { ConfidenceBadge, DisplayKindBadge, LootKindBadge } from "./Badges";
import { EntityLink } from "./EntityLink";
import { RateCell } from "./RateCell";

/**
 * Observation table. `perspective="item"` lists sources of an item;
 * `perspective="source"` lists items dropped by a source.
 */
export function DropTable({ rows, perspective, caption }: { rows: DropRow[]; perspective: "item" | "source"; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-ink-700" tabIndex={0} role="region" aria-label={caption}>
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
            const key = `${d.source.type}-${d.source.id}-${d.source.level}-${d.lootKind}-${d.item.id}`;
            const sid = displayId(d.source.type, d.source.id);
            return (
              <tr key={key}>
                <td>
                  {perspective === "item" ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <EntityLink href={sourcePath(d.source.type, d.source.id, d.source.level)}
                        tooltip={`/api/v1/tooltip/source/${d.source.type}/${d.source.id}`}>
                        {d.source.name}
                      </EntityLink>
                      <DisplayKindBadge kind={d.source.displayKind} />
                      {d.source.type === "creature" && d.source.level > 0 && <span className="text-xs text-mist">Lvl {d.source.level}</span>}
                      {d.source.type === "creature" && d.source.level === 0 && <span className="text-xs text-mist">Lvl ? (historical)</span>}
                      {sid && <span className="font-[family-name:var(--font-mono)] text-[0.7rem] text-mist">#{sid}</span>}
                    </span>
                  ) : (
                    <span className="flex flex-wrap items-center gap-2">
                      <EntityLink href={itemPath(d.item.id)} tooltip={`/api/v1/tooltip/item/${d.item.id}`}>{d.item.name}</EntityLink>
                      <span className="font-[family-name:var(--font-mono)] text-[0.7rem] text-mist">#{d.item.id}</span>
                    </span>
                  )}
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
  );
}
