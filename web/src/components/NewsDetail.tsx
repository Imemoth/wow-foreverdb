import Link from "next/link";
import type { NewsEntry } from "@/lib/data/types";
import { fmtDate } from "@/lib/format";
import { Breadcrumbs } from "./Breadcrumbs";

const labels: Record<NewsEntry["category"], string> = {
  bluepost: "BLUE POST", official_news: "OFFICIAL NEWS", patch_notes: "PATCH NOTES", azerdex: "AZERDEX",
};

export function NewsDetail({ entry, nonce, baseUrl }: { entry: NewsEntry; nonce?: string; baseUrl: string }) {
  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "News", href: "/news" }, { name: entry.title }]} />
      <header className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-bronze-400">{labels[entry.category]} · {entry.region.toUpperCase()}</p>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-gold-300 sm:text-4xl">{entry.title}</h1>
        <p className="text-lg text-mist">{entry.excerpt || "Official news from Azeroth."}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-mist">
          <time dateTime={entry.publishedAt}>{fmtDate(entry.publishedAt)}</time>
          {entry.author && <><span aria-hidden="true">·</span><span>By {entry.author}</span></>}
          {entry.modifiedAt && <><span aria-hidden="true">·</span><span>updated {fmtDate(entry.modifiedAt)}</span></>}
        </p>
      </header>
      <div className="rule-ornament" />
      <section className="panel space-y-4 p-6" aria-labelledby="official-source-title">
        <h2 id="official-source-title" className="panel-title text-xl">Read the official update</h2>
        <p className="text-sm leading-6 text-mist">AzerDex stores a short context excerpt and links back to Blizzard. The original post remains the source of truth.</p>
        <a href={entry.canonicalUrl} target="_blank" rel="noreferrer" className="btn-primary">Open official source ↗</a>
      </section>
      {entry.threadKey && <p className="text-sm text-mist">This entry is part of an official discussion thread; later replies are kept under the same thread identity to avoid duplicate homepage stories.</p>}
      <Link href="/news" className="text-sm">← Back to all news</Link>
    </article>
  );
}
