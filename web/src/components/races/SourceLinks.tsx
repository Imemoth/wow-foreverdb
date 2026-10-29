import type { SourceRef } from "@/lib/versioned/types";
import { formatDate, SOURCE_KIND_LABEL } from "@/lib/races/format";

/** Outbound source links: new tab, no opener/referrer. The visible text names the source and its publication date. */
export function SourceLinks({ sources, label = "Sources" }: { sources: readonly SourceRef[]; label?: string }) {
  if (sources.length === 0) return null;
  return (
    <p className="text-xs text-mist">
      <span className="font-semibold text-parchment/90">{label}: </span>
      {sources.map((s, i) => (
        <span key={s.id}>
          {i > 0 && "; "}
          <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline decoration-ink-600 underline-offset-2 hover:text-gold-300">
            {SOURCE_KIND_LABEL[s.kind]} ({formatDate(s.publishedOn)})
            <span className="sr-only"> - {s.title}, opens in a new tab</span>
          </a>
        </span>
      ))}
    </p>
  );
}
