import Link from "next/link";
import type { NewsEntry } from "@/lib/data/types";
import { fmtDate } from "@/lib/format";
import { getNewsVisualVariant, newsDates, newsKindLabel, normalizeNewsExcerpt } from "@/lib/news/presentation";
import { Breadcrumbs } from "./Breadcrumbs";

const labels: Record<NewsEntry["category"], string> = {
  bluepost: "BLUE POST", official_news: "OFFICIAL NEWS", patch_notes: "PATCH NOTES", azerdex: "AZERDEX",
};

export function NewsDetail({ entry, nonce, baseUrl }: { entry: NewsEntry; nonce?: string; baseUrl: string }) {
  const variant = getNewsVisualVariant(entry);
  const dates = newsDates(entry);
  const announcement = normalizeNewsExcerpt(entry.excerpt || "Official news from Azeroth.");
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "News", href: "/news" }, { name: entry.title }]} />
      <header className={`news-detail__header news-detail__header--${variant} space-y-3`}>
        <p className={`news-detail__eyebrow text-xs font-semibold uppercase tracking-[0.2em] ${variant === "bluepost" ? "news-detail__eyebrow--bluepost" : "text-bronze-400"}`}>
          {variant === "bluepost" && <span className="news-card__mark mr-2 inline-flex align-middle" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none"><path d="M8 1.25v13.5M3.23 3.23l9.54 9.54M1.25 8h13.5M3.23 12.77l9.54-9.54" /><circle cx="8" cy="8" r="2.1" /></svg></span>}
          {newsKindLabel(entry, labels[entry.category])} · {entry.region.toUpperCase()}
        </p>
        <h1 className="news-detail__title font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-gold-300 sm:text-4xl">{entry.title}</h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-mist">
          <time dateTime={dates.original}>{dates.updated ? "First posted " : ""}{fmtDate(dates.original)}</time>
          {dates.updated && <><span aria-hidden="true">·</span><span>latest official update <time dateTime={dates.latest}>{fmtDate(dates.latest)}</time></span></>}
          {entry.author && <><span aria-hidden="true">·</span><span>By {entry.author}</span></>}
          {!dates.updated && entry.modifiedAt && <><span aria-hidden="true">·</span><span>updated {fmtDate(entry.modifiedAt)}</span></>}
        </p>
      </header>
      <div className="rule-ornament" />
      <section className={`news-detail__announcement news-detail__announcement--${variant} space-y-3`} aria-labelledby="announcement-title">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-mist">Announcement</p>
        <p id="announcement-title" className="news-detail__body text-base leading-8 text-parchment">{announcement}</p>
      </section>
      <section className={`news-detail__source news-detail__source--${variant} space-y-3`} aria-labelledby="official-source-title">
        <h2 id="official-source-title" className="text-sm font-semibold uppercase tracking-[0.16em] text-mist">Source attribution</h2>
        <p className="text-sm leading-6 text-mist">AzerDex stores a short context excerpt and links back to Blizzard. The original post remains the source of truth.</p>
        <a href={entry.canonicalUrl} target="_blank" rel="noreferrer" className="news-source-action btn-ghost">Open official source ↗</a>
      </section>
      {entry.entryKind === "staff_reply" && <p className="text-sm text-mist">This is a verified Blizzard staff reply in a community-created thread. AzerDex shows only the staff post, never the player&apos;s topic.</p>}
      {entry.updates && entry.updates.length > 1 && (
        <section aria-labelledby="thread-updates-title" className="news-detail__thread space-y-3">
          <h2 id="thread-updates-title" className="text-sm font-semibold uppercase tracking-[0.16em] text-mist">Official updates in this thread</h2>
          <ul className="space-y-2 text-sm text-mist">
            {entry.updates.map((update) => (
              <li key={update.slug}>
                <a href={update.canonicalUrl} target="_blank" rel="noreferrer">{update.postNumber === 1 ? "Original post" : `Post #${update.postNumber ?? "?"}`} ↗</a>
                {" · "}<time dateTime={update.officialUpdatedAt}>{fmtDate(update.officialUpdatedAt)}</time>
                {update.author && <> · {update.author}</>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {entry.threadKey && <p className="text-sm text-mist">This entry is part of an official discussion thread; verified official updates are grouped under one story and ordinary replies never refresh it.</p>}
      <Link href="/news" className="text-sm">← Back to all news</Link>
    </article>
  );
}
