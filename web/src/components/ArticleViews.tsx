import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { articlePath, getArticle, visibleArticles, type Article, type Section } from "@/lib/content/loader";
import { data } from "@/lib/data";
import { fmtDate } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { robotsFor } from "@/lib/seo";
import { itemPath, sourcePath } from "@/lib/routes";
import { Breadcrumbs } from "./Breadcrumbs";
import { JsonLd } from "./JsonLd";
import { Markdown } from "./Markdown";

export const SECTION_META: Record<Section, { title: string; intro: string }> = {
  news: { title: "News", intro: "WoW: Forever updates, new observations and ForeverDB development, written and reviewed by the editors." },
  guides: { title: "Guides", intro: "Evergreen guides grounded in collected data: professions, gathering, fishing and using ForeverDB." },
  blog: { title: "Blog", intro: "Behind the scenes: how ForeverDB is built, data quality, and the road ahead." },
};

function SampleLabel() {
  return <span className="rounded bg-conf-low/15 px-1.5 py-0.5 text-xs font-semibold text-conf-low">Editorial sample</span>;
}

export async function ArticleList({ section }: { section: Section }) {
  const { nonce, baseUrl } = await pageContext();
  const list = visibleArticles(section);
  const meta = SECTION_META[section];
  const tags = [...new Set(list.flatMap((a) => a.tags))].sort();
  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: meta.title }]} />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-parchment">{meta.title}</h1>
          <p className="mt-1 max-w-2xl text-mist">{meta.intro}</p>
        </div>
        {section === "news" && <Link href="/news/rss.xml" className="btn-ghost text-sm">RSS feed</Link>}
      </header>
      {tags.length > 0 && (
        <p className="flex flex-wrap gap-1.5 text-xs text-mist" aria-label="Topics">
          {tags.map((t) => <span key={t} className="rounded-full border border-ink-600 px-2 py-0.5">#{t}</span>)}
        </p>
      )}
      {list.length === 0 ? <p className="text-mist">Nothing published yet.</p> : (
        <ul className="grid gap-4 md:grid-cols-2">
          {list.map((a) => (
            <li key={a.slug} className="panel flex flex-col p-5">
              <p className="text-xs uppercase tracking-wider text-bronze-400">{a.category}</p>
              <h2 className="mt-1 text-lg font-semibold">
                <Link href={articlePath(a)} className="text-parchment no-underline hover:text-gold-300">{a.title}</Link>
              </h2>
              <p className="mt-2 flex-1 text-sm text-mist">{a.description}</p>
              <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-mist">
                <time dateTime={a.publishedAt}>{fmtDate(a.publishedAt)}</time> · {a.readingMinutes} min read
                {a.sample && <SampleLabel />}
                {a.status === "draft" && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-danger">Draft (local only)</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export async function articleMetadata(section: Section, slug: string): Promise<Metadata> {
  const a = getArticle(section, slug);
  if (!a) return { title: "Not found", robots: { index: false } };
  return {
    title: a.title,
    description: a.description,
    alternates: { canonical: articlePath(a) },
    openGraph: {
      type: "article", title: a.title, description: a.description, url: articlePath(a),
      publishedTime: a.publishedAt, modifiedTime: a.updatedAt ?? a.publishedAt, tags: a.tags,
    },
    // Sample/draft content is never indexed.
    robots: robotsFor(!a.sample && a.status === "published"),
  };
}

export async function ArticlePage({ section, slug }: { section: Section; slug: string }) {
  const { nonce, baseUrl } = await pageContext();
  const a = getArticle(section, slug);
  if (!a) notFound();
  const meta = SECTION_META[section];
  const db = data();
  const relItems = (await Promise.all(a.related.items.map((id) => db.item(id).catch(() => null)))).filter(Boolean);
  const relSources = (await Promise.all(a.related.sources.map((s) => db.source(s.type, s.id).catch(() => null)))).filter(Boolean);
  const relArticles = a.related.articles
    .map((ref) => { const [sec, sl] = ref.split("/") as [Section, string]; return getArticle(sec, sl); })
    .filter((x): x is Article => Boolean(x));
  const next = visibleArticles(section).filter((x) => x.slug !== a.slug).slice(0, 3);

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: meta.title, href: `/${section}` }, { name: a.title }]} />
      <header className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-bronze-400">{a.category}</p>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-gold-300 sm:text-4xl">{a.title}</h1>
        <p className="text-lg text-mist">{a.description}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-mist">
          By {a.author} · <time dateTime={a.publishedAt}>{fmtDate(a.publishedAt)}</time>
          {a.updatedAt && <> · updated <time dateTime={a.updatedAt}>{fmtDate(a.updatedAt)}</time></>}
          · {a.readingMinutes} min read
        </p>
        {a.sample && (
          <div role="note" className="rounded-lg border border-conf-low/40 bg-conf-low/5 p-3 text-sm text-[#f5d2b4]">
            <strong>Editorial sample.</strong> This article demonstrates the publishing system and has not been through final editorial
            review. Figures it mentions refer to the synthetic preview dataset.
          </div>
        )}
      </header>
      <div className="rule-ornament" />
      <Markdown source={a.body} />

      {(relItems.length > 0 || relSources.length > 0) && (
        <aside aria-labelledby="rel-db" className="panel p-5">
          <h2 id="rel-db" className="panel-title text-lg">Related database entries</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {relItems.map((i) => i && <li key={`i${i.item.id}`}><Link className="btn-ghost text-sm" href={itemPath(i.item.id)}>{i.item.name}</Link></li>)}
            {relSources.map((s) => s && s.variants[0] && <li key={`s${s.type}${s.id}`}><Link className="btn-ghost text-sm" href={sourcePath(s.type, s.id)}>{s.variants[0].name}</Link></li>)}
          </ul>
        </aside>
      )}
      {(relArticles.length > 0 || next.length > 0) && (
        <aside aria-labelledby="rel-read" className="space-y-3">
          <h2 id="rel-read" className="panel-title text-lg">Read next</h2>
          <ul className="space-y-2">
            {[...relArticles, ...next.filter((n) => !relArticles.some((r) => r.slug === n.slug))].slice(0, 4).map((r) => (
              <li key={`${r.section}/${r.slug}`}><Link href={articlePath(r)}>{r.title}</Link> <span className="text-xs text-mist">· {SECTION_META[r.section].title}</span></li>
            ))}
          </ul>
        </aside>
      )}
      <JsonLd nonce={nonce} data={{
        "@context": "https://schema.org",
        "@type": section === "news" ? "NewsArticle" : "Article",
        headline: a.title,
        description: a.description,
        datePublished: a.publishedAt,
        dateModified: a.updatedAt ?? a.publishedAt,
        author: { "@type": "Organization", name: a.author },
        publisher: { "@type": "Organization", name: "ForeverDB" },
        mainEntityOfPage: new URL(articlePath(a), baseUrl).toString(),
        keywords: a.tags.join(", "),
      }} />
    </article>
  );
}
