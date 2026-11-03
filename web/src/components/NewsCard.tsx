import Link from "next/link";
import type { NewsEntry } from "@/lib/data/types";
import { fmtDate } from "@/lib/format";
import { cleanNewsExcerpt, getNewsVisualVariant } from "@/lib/news/presentation";

const CATEGORY_LABELS: Record<NewsEntry["category"], string> = {
  bluepost: "BLUE POST",
  official_news: "OFFICIAL NEWS",
  patch_notes: "PATCH NOTES",
  azerdex: "AZERDEX",
};

export function NewsCard({ entry, featured = false }: { entry: NewsEntry; featured?: boolean }) {
  const variant = getNewsVisualVariant(entry);
  const excerpt = cleanNewsExcerpt(entry.excerpt || "Read the official update from Blizzard.");
  return (
    <article className={`panel news-card news-card--${variant} flex h-full flex-col overflow-hidden ${featured ? "news-card--featured border-gold-500/60" : ""}`}>
      <div className="flex flex-1 flex-col p-5">
        <div className={`news-card__eyebrow flex flex-wrap items-center gap-2 text-[0.68rem] font-semibold uppercase tracking-[0.16em] ${variant === "bluepost" ? "news-card__eyebrow--bluepost" : "text-bronze-400"}`}>
          {variant === "bluepost" && <span className="news-card__mark" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none"><path d="M8 1.25v13.5M3.23 3.23l9.54 9.54M1.25 8h13.5M3.23 12.77l9.54-9.54" /><circle cx="8" cy="8" r="2.1" /></svg></span>}
          <span>{CATEGORY_LABELS[entry.category]}</span>
          {entry.region !== "global" && <span className="news-card__region">· {entry.region.toUpperCase()}</span>}
        </div>
        <h3 className={`news-card__title mt-2 font-[family-name:var(--font-display)] font-bold text-parchment ${featured ? "text-2xl" : "text-lg"}`}>
          <Link href={`/news/entry/${entry.slug}`} className="no-underline hover:text-gold-300">{entry.title}</Link>
        </h3>
        <p className="news-card__excerpt mt-2 flex-1 text-sm leading-6 text-mist">{excerpt}</p>
        <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-mist">
          <time dateTime={entry.publishedAt}>{fmtDate(entry.publishedAt)}</time>
          {entry.author && <><span aria-hidden="true">·</span><span>{entry.author}</span></>}
        </p>
        <a href={entry.canonicalUrl} target="_blank" rel="noreferrer" className="news-card__source mt-3 text-xs font-semibold uppercase tracking-wider">Official source ↗</a>
      </div>
    </article>
  );
}
