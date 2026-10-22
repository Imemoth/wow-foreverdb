import Link from "next/link";
import type { NewsEntry } from "@/lib/data/types";
import { fmtDate } from "@/lib/format";

const CATEGORY_LABELS: Record<NewsEntry["category"], string> = {
  bluepost: "BLUE POST",
  official_news: "OFFICIAL NEWS",
  patch_notes: "PATCH NOTES",
  azerdex: "AZERDEX",
};

export function NewsCard({ entry, featured = false }: { entry: NewsEntry; featured?: boolean }) {
  return (
    <article className={`panel flex h-full flex-col overflow-hidden ${featured ? "border-gold-500/60" : ""}`}>
      <div className="flex flex-1 flex-col p-5">
        <div className="flex flex-wrap items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-bronze-400">
          <span>{CATEGORY_LABELS[entry.category]}</span>
          {entry.region !== "global" && <span className="text-mist">· {entry.region.toUpperCase()}</span>}
        </div>
        <h3 className={`mt-2 font-[family-name:var(--font-display)] font-bold text-parchment ${featured ? "text-2xl" : "text-lg"}`}>
          <Link href={`/news/entry/${entry.slug}`} className="no-underline hover:text-gold-300">{entry.title}</Link>
        </h3>
        <p className="mt-2 flex-1 text-sm leading-6 text-mist">{entry.excerpt || "Read the official update from Blizzard."}</p>
        <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-mist">
          <time dateTime={entry.publishedAt}>{fmtDate(entry.publishedAt)}</time>
          {entry.author && <><span aria-hidden="true">·</span><span>{entry.author}</span></>}
        </p>
        <a href={entry.canonicalUrl} target="_blank" rel="noreferrer" className="mt-3 text-xs font-semibold uppercase tracking-wider">Official source ↗</a>
      </div>
    </article>
  );
}
