import type { RaceChange } from "@/lib/races/types";
import { CHANGE_LABEL, formatDate } from "@/lib/races/format";
import { EvidenceBadge } from "./EvidenceBadge";
import { SourceLinks } from "./SourceLinks";

function Row({ c }: { c: RaceChange }) {
  const { entry, ability, before } = c;
  return (
    <li className="space-y-1.5 border-l-2 border-ink-600 pl-4" data-testid="history-row" data-ability={ability.id} data-change={entry.type}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <time dateTime={entry.announcedOn} className="font-semibold text-parchment">{formatDate(entry.announcedOn)}</time>
        <span className="text-mist">·</span>
        <span className="font-semibold text-gold-300">{ability.name}</span>
        <span className="rounded border border-ink-600 px-1.5 py-0.5 text-xs text-mist">{CHANGE_LABEL[entry.type]}</span>
        <EvidenceBadge evidence={entry.evidence} />
      </p>
      <p className="text-parchment">{entry.summary}</p>
      {before && <p className="text-sm text-mist"><span className="font-semibold">Earlier definition:</span> {before}</p>}
      <SourceLinks sources={entry.sources} />
    </li>
  );
}

/**
 * Collapsed-by-default history for one race. A native <details>: keyboard operable (Enter/Space), announced by assistive
 * technology and works without client JavaScript. Newest change first; abilities that are no longer current follow with their
 * earliest documented definition. Dates are the sources' publication dates, not necessarily when a change went live in game.
 */
export function VersionHistory({ raceName, changes, earliest }: { raceName: string; changes: readonly RaceChange[]; earliest: readonly RaceChange[] }) {
  const count = changes.length;
  return (
    <details className="panel group p-5" data-testid="version-history">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-300 [&::-webkit-details-marker]:hidden">
        <span className="font-[family-name:var(--font-display)] text-xl font-semibold text-gold-300">
          Version history <span className="text-sm font-normal text-mist">({count} {count === 1 ? "change" : "changes"})</span>
        </span>
        <span aria-hidden="true" className="text-mist transition-transform group-open:rotate-180">▾</span>
      </summary>
      <div className="mt-4 space-y-5">
        <p className="text-sm text-mist">
          How {raceName} racial abilities changed, newest first. Dates are when the source was published; they are not necessarily the day a change
          went live in the game.
        </p>
        {count === 0 ? <p className="text-parchment">No changes have been documented for {raceName} yet.</p> : (
          <ol className="space-y-5" aria-label={`Changes to ${raceName} racial abilities`}>{changes.map((c, i) => <Row key={`${c.entry.recordId}-${c.ability.id}-${i}`} c={c} />)}</ol>
        )}
        {earliest.length > 0 && (
          <div className="space-y-3">
            <h4 className="font-[family-name:var(--font-display)] text-lg font-semibold text-parchment">Earlier abilities no longer available</h4>
            <ul className="space-y-3">
              {earliest.map(({ ability, entry }) => (
                <li key={ability.id} className="space-y-1 border-l-2 border-ink-600 pl-4" data-testid="retired-ability" data-ability={ability.id}>
                  <p className="text-sm"><span className="font-semibold text-gold-300">{ability.name}</span> <span className="text-mist">({ability.type})</span> <EvidenceBadge evidence={entry.evidence} /></p>
                  <p className="text-parchment">{String(entry.snapshot?.description ?? "")}</p>
                  <SourceLinks sources={entry.sources} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
