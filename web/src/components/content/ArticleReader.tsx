import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { CategoryBadge } from "@/components/library/CategoryBadge";
import { JsonLd } from "@/components/JsonLd";
import { Markdown } from "@/components/Markdown";
import { data } from "@/lib/data";
import { articlePath, getArticle, visibleArticles, type Article, type Section } from "@/lib/content/loader";
import { extractGuideToc } from "@/lib/content/toc";
import { fmtDate } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { itemPath, sourcePath } from "@/lib/routes";

const SECTION_LABEL: Record<Section, string> = { news: "News", guides: "Guides", blog: "Blog" };

/**
 * Shared News/Blog article reader, built on the same proven P2-B pattern as
 * library/GuideArticle.tsx: breadcrumb (incl. a category crumb back into the filtered hub),
 * accessible table of contents for longer articles, desktop sticky sidebar, and the mobile
 * reading order title -> intro/notices -> TOC -> content via an explicit-placement CSS grid
 * (not `order` + auto-flow - see GuideArticle.tsx for why that fails here). `extractGuideToc` is
 * reused as-is: despite its name it only extracts H2 headings from raw Markdown, nothing
 * Guides-specific, and duplicating it would risk the TOC id / Markdown.tsx h2-id drifting apart.
 * One implementation serves both News and Blog; Guides keeps its own dedicated GuideArticle.tsx.
 */
export async function ArticleReader({ section, slug }: { section: Section; slug: string }) {
  const { nonce, baseUrl } = await pageContext();
  const a = getArticle(section, slug);
  if (!a) notFound();
  const db = data();
  const relItems = (await Promise.all(a.related.items.map((id) => db.item(id).catch(() => null)))).filter(Boolean);
  const relSources = (await Promise.all(a.related.sources.map((s) => db.source(s.type, s.id).catch(() => null)))).filter(Boolean);
  const relArticles = a.related.articles
    .map((ref) => { const [sec, sl] = ref.split("/") as [Section, string]; return getArticle(sec, sl); })
    .filter((x): x is Article => Boolean(x));
  const next = visibleArticles(section).filter((x) => x.slug !== a.slug).slice(0, 3);
  const readNext = [...relArticles, ...next.filter((n) => !relArticles.some((r) => r.slug === n.slug))].slice(0, 4);
  const toc = extractGuideToc(a.body);
  const label = SECTION_LABEL[section];

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[
        { name: label, href: `/${section}` },
        { name: a.category, href: `/${section}?category=${encodeURIComponent(a.category)}` },
        { name: a.title },
      ]} />

      <article className="mt-6 lg:grid lg:grid-cols-[minmax(0,1fr)_240px] lg:items-start lg:gap-10">
        <header className="min-w-0 max-w-3xl space-y-3 lg:col-start-1 lg:row-start-1">
          <CategoryBadge category={a.category} />
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

        {toc.length >= 2 && (
          <nav aria-label={`${label} sections`} className="mt-6 lg:col-start-2 lg:row-start-1 lg:row-span-2 lg:mt-0 lg:sticky lg:top-6">
            <details className="panel p-4" open>
              <summary className="cursor-pointer text-sm font-semibold text-parchment marker:content-none [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-1.5">
                  {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
                  <img src="/library/medallions/compendium.webp" alt="" aria-hidden="true" className="h-4 w-4" />
                  In this article
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-mist" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </span>
              </summary>
              <ol className="mt-3 space-y-1.5 border-t border-ink-700 pt-3 text-sm">
                {toc.map((t, i) => (
                  <li key={t.id}>
                    <a href={`#${t.id}`} className="text-mist hover:text-gold-300">{i + 1}. {t.text}</a>
                  </li>
                ))}
              </ol>
            </details>
          </nav>
        )}

        <div className="mt-6 min-w-0 max-w-3xl space-y-6 lg:col-start-1 lg:row-start-2 lg:mt-0">
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
          {readNext.length > 0 && (
            <aside aria-labelledby="rel-read" className="space-y-3">
              <h2 id="rel-read" className="panel-title text-lg">Read next</h2>
              <ul className="space-y-2">
                {readNext.map((r) => (
                  <li key={articlePath(r)}><Link href={articlePath(r)}>{r.title}</Link> <span className="text-xs text-mist">· {SECTION_LABEL[r.section]}</span></li>
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
            publisher: { "@type": "Organization", name: "AzerDex" },
            mainEntityOfPage: new URL(articlePath(a), baseUrl).toString(),
            keywords: a.tags.join(", "),
          }} />
        </div>
      </article>
    </div>
  );
}
