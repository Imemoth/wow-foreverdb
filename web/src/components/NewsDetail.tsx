import Link from "next/link";
import type { NewsEntry } from "@/lib/data/types";
import { fmtDate } from "@/lib/format";
import { cleanNewsExcerpt, getNewsVisualVariant } from "@/lib/news/presentation";
import { Breadcrumbs } from "./Breadcrumbs";

const labels: Record<NewsEntry["category"], string> = {
  bluepost: "BLUE POST", official_news: "OFFICIAL NEWS", patch_notes: "PATCH NOTES", azerdex: "AZERDEX",
};

export function NewsDetail({ entry, nonce, baseUrl }: { entry: NewsEntry; nonce?: string; baseUrl: string }) {
  const variant = getNewsVisualVariant(entry);
  const excerpt = cleanNewsExcerpt(entry.excerpt || "Official news from Azeroth.");
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "News", href: "/news" }, { name: entry.title }]} />
      <header className={`news-detail__header news-detail__header--${variant} space-y-3`}>
        <p className={`news-detail__eyebrow text-xs font-semibold uppercase tracking-[0.2em] ${variant === "bluepost" ? "news-detail__eyebrow--bluepost" : "text-bronze-400"}`}>
          {variant === "bluepost" && <span className="news-card__mark mr-2 inline-flex align-middle" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none"><path d="M8 1.25v13.5M3.23 3.23l9.54 9.54M1.25 8h13.5M3.23 12.77l9.54-9.54" /><circle cx="8" cy="8" r="2.1" /></svg></span>}
          {labels[entry.category]} · {entry.region.toUpperCase()}
        </p>
        <h1 className="news-detail__title font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-gold-300 sm:text-4xl">{entry.title}</h1>
        <p className="news-detail__dek text-lg text-mist">{excerpt}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-mist">
          <time dateTime={entry.publishedAt}>{fmtDate(entry.publishedAt)}</time>
          {entry.author && <><span aria-hidden="true">·</span><span>By {entry.author}</span></>}
          {entry.modifiedAt && <><span aria-hidden="true">·</span><span>updated {fmtDate(entry.modifiedAt)}</span></>}
        </p>
      </header>
      <div className="rule-ornament" />
      <section className={`news-detail__announcement news-detail__announcement--${variant} space-y-3`} aria-labelledby="announcement-title">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-mist">Announcement</p>
        <h2 id="announcement-title" className="font-[family-name:var(--font-display)] text-2xl font-semibold text-parchment">{entry.title}</h2>
        <p className="news-detail__body text-base leading-8 text-parchment">{excerpt}</p>
      </section>
      <section className={`news-detail__source news-detail__source--${variant} space-y-3`} aria-labelledby="official-source-title">
        <h2 id="official-source-title" className="text-sm font-semibold uppercase tracking-[0.16em] text-mist">Source attribution</h2>
        <p className="text-sm leading-6 text-mist">AzerDex stores a short context excerpt and links back to Blizzard. The original post remains the source of truth.</p>
        <a href={entry.canonicalUrl} target="_blank" rel="noreferrer" className="news-source-action btn-ghost">Open official source ↗</a>
      </section>
      {entry.threadKey && <p className="text-sm text-mist">This entry is part of an official discussion thread; later replies are kept under the same thread identity to avoid duplicate homepage stories.</p>}
      <Link href="/news" className="text-sm">← Back to all news</Link>
    </article>
  );
}
