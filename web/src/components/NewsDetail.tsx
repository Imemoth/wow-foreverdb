import Link from "next/link";
import type { NewsEntry } from "@/lib/data/types";
import { fmtDate } from "@/lib/format";
import { getNewsVisualVariant, newsDates, newsKindLabel, newsRegionLabel, normalizeNewsExcerpt, regionName } from "@/lib/news/presentation";
import { Breadcrumbs } from "./Breadcrumbs";
import { JsonLd } from "./JsonLd";

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
      {entry.story && (
        <JsonLd nonce={nonce} data={{
          "@context": "https://schema.org", "@type": "NewsArticle", headline: entry.story.members[0]?.title ?? entry.title,
          mainEntityOfPage: new URL(`/news/entry/${entry.story.canonicalSlug}`, baseUrl).toString(),
          datePublished: entry.story.members.map((m) => m.firstPublishedAt).sort()[0] ?? entry.publishedAt,
          dateModified: entry.story.members.map((m) => m.lastOfficialAt).sort().at(-1) ?? entry.publishedAt,
          // The original regional Blizzard sources: preserved, linked, and described as the basis of this one story.
          isBasedOn: entry.story.members.map((m) => ({ "@type": "CreativeWork", url: m.sourceUrl, name: `${m.title} (${regionName(m.region)})`, locationCreated: regionName(m.region) })),
        }} />
      )}
      <header className={`news-detail__header news-detail__header--${variant} space-y-3`}>
        <p className={`news-detail__eyebrow text-xs font-semibold uppercase tracking-[0.2em] ${variant === "bluepost" ? "news-detail__eyebrow--bluepost" : "text-bronze-400"}`}>
          {variant === "bluepost" && <span className="news-card__mark mr-2 inline-flex align-middle" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none"><path d="M8 1.25v13.5M3.23 3.23l9.54 9.54M1.25 8h13.5M3.23 12.77l9.54-9.54" /><circle cx="8" cy="8" r="2.1" /></svg></span>}
          {newsKindLabel(entry, labels[entry.category])} · <span data-testid="news-regions">{newsRegionLabel(entry) || entry.region.toUpperCase()}</span>
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
      {entry.story ? (
        <section className={`news-detail__source news-detail__source--${variant} space-y-4`} aria-labelledby="official-source-title" data-testid="story-sources">
          <h2 id="official-source-title" className="text-sm font-semibold uppercase tracking-[0.16em] text-mist">Official sources ({entry.story.regions.map(regionName).join(" · ")})</h2>
          <p className="text-sm leading-6 text-mist">
            {entry.story.regions.length > 1
              ? "Blizzard published this announcement in more than one region. AzerDex shows it once and links every original regional post, which stays the source of truth."
              : "AzerDex stores a short context excerpt and links back to Blizzard. The original post remains the source of truth."}
          </p>
          <ul className="space-y-4">
            {entry.story.members.map((member) => (
              <li key={member.threadKey} data-testid={`story-source-${member.region}`} className="space-y-1">
                <p className="text-sm font-semibold text-parchment">{regionName(member.region)} · {member.title}</p>
                <p className="text-xs text-mist">first posted <time dateTime={member.firstPublishedAt}>{fmtDate(member.firstPublishedAt)}</time>{member.updateCount > 1 && <> · latest official update <time dateTime={member.lastOfficialAt}>{fmtDate(member.lastOfficialAt)}</time></>}{member.author && <> · {member.author}</>}</p>
                <a href={member.sourceUrl} target="_blank" rel="noreferrer" className="news-source-action btn-ghost">Open the {regionName(member.region)} official source ↗</a>
                {member.updates.length > 1 && (
                  <ul className="space-y-1 pt-1 text-sm text-mist" aria-label={`Official updates in the ${regionName(member.region)} thread`}>
                    {member.updates.map((update) => (
                      <li key={update.slug}>
                        <a href={update.canonicalUrl} target="_blank" rel="noreferrer">{update.postNumber === 1 ? "Original post" : `Post #${update.postNumber ?? "?"}`} ↗</a>
                        {" · "}<time dateTime={update.officialUpdatedAt}>{fmtDate(update.officialUpdatedAt)}</time>{update.author && <> · {update.author}</>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : (
      <section className={`news-detail__source news-detail__source--${variant} space-y-3`} aria-labelledby="official-source-title">
        <h2 id="official-source-title" className="text-sm font-semibold uppercase tracking-[0.16em] text-mist">Source attribution</h2>
        <p className="text-sm leading-6 text-mist">AzerDex stores a short context excerpt and links back to Blizzard. The original post remains the source of truth.</p>
        <a href={entry.canonicalUrl} target="_blank" rel="noreferrer" className="news-source-action btn-ghost">Open official source ↗</a>
      </section>
      )}
      {entry.entryKind === "staff_reply" && <p className="text-sm text-mist">This is a verified Blizzard staff reply in a community-created thread. AzerDex shows only the staff post, never the player&apos;s topic.</p>}
      {!entry.story && entry.updates && entry.updates.length > 1 && (
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
      {!entry.story && entry.threadKey && <p className="text-sm text-mist">This entry is part of an official discussion thread; verified official updates are grouped under one story and ordinary replies never refresh it.</p>}
      <Link href="/news" className="text-sm">← Back to all news</Link>
    </article>
  );
}
