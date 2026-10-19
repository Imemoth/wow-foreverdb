import type { ComponentType } from "react";
import Link from "next/link";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyState } from "@/components/EmptyState";
import { ArticleCard } from "@/components/content/ArticleCard";
import { articleCategories, articleTags, filterArticles, isEmptyArticleQuery, parseArticleQuery, sortArticles, type ArticleQuery } from "@/lib/content/article-query";
import { visibleArticles, type Section } from "@/lib/content/loader";
import { pageContext } from "@/lib/page";

export type SP = Promise<Record<string, string | string[] | undefined>>;

function toParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v != null) p.append(k, v);
  }
  return p;
}

export async function articleQueryFrom(searchParams: SP): Promise<ArticleQuery> {
  return parseArticleQuery(toParams(await searchParams));
}

/**
 * Shared News/Blog landing-page shell: full-bleed cinematic hero (same breakout technique as
 * GuidesLibrary.tsx's hero - .hero-vignette/.hero-fade-bottom from globals.css, no negative
 * margin-top since the breadcrumb precedes it here too) + the same plain-GET search/filter form +
 * a featured-first, deterministically-ordered grid. News and Blog each call this with their own
 * banner artwork, copy and medallion icon; the search/filter/sort/empty-state logic itself is one
 * implementation (lib/content/article-query.ts), not duplicated per section. Guides keeps its own
 * GuidesLibrary.tsx untouched - this component is News/Blog-only.
 */
export async function ArticleHub({
  section, searchParams, eyebrow, eyebrowIcon, title, intro, Banner, searchLabel, rss,
}: {
  section: Section;
  searchParams: SP;
  eyebrow: string;
  eyebrowIcon: string;
  title: string;
  intro: string;
  Banner: ComponentType<{ className?: string }>;
  searchLabel: string;
  rss?: boolean;
}) {
  const { nonce, baseUrl } = await pageContext();
  const all = visibleArticles(section);
  const query = await articleQueryFrom(searchParams);
  const empty = isEmptyArticleQuery(query);
  const categories = articleCategories(all);
  const tags = articleTags(all);
  const results = sortArticles(filterArticles(all, query));

  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: title }]} />

      <div className="relative left-1/2 w-screen -ml-[50vw]">
        <section
          aria-labelledby={`${section}-hero-title`}
          className="relative flex min-h-[320px] flex-col justify-center overflow-hidden bg-ink-950 py-10 sm:min-h-[460px] sm:py-14 lg:min-h-[540px] lg:py-16"
        >
          <Banner />
          <div className="hero-vignette" />
          <div className="hero-fade-bottom" />
          <div className="relative z-10 mx-auto w-full max-w-7xl px-4">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em] text-violet-300">
              {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
              <img src={eyebrowIcon} alt="" aria-hidden="true" className="h-5 w-5 sm:h-6 sm:w-6" />
              {eyebrow}
            </p>
            <h1 id={`${section}-hero-title`} className="mt-2 font-[family-name:var(--font-display)] text-4xl font-bold leading-tight text-parchment sm:text-5xl lg:text-6xl">
              {title}
            </h1>
            <p className="mt-3 max-w-2xl text-sm text-mist sm:text-base lg:text-lg">{intro}</p>
            {rss && (
              <p className="mt-4">
                <Link href="/news/rss.xml" className="btn-ghost text-sm">RSS feed</Link>
              </p>
            )}
          </div>
        </section>
      </div>

      {/*
        minmax(0, Nfr), not bare Nfr: News categories ("ForeverDB development") run longer than
        Guides' ("Professions", "Setup"), and a bare `1fr` track has an implicit `minmax(auto, 1fr)`
        - it cannot shrink below its content's min-content width, so a long <select> option was
        widening its track past the viewport at the md breakpoint (768px) and pushing the Search
        button off-screen. minmax(0, ...) lets every track shrink to the grid's actual width; w-full
        on each control then fills whatever width its track ends up with.
      */}
      <form action={`/${section}`} method="get" role="search" aria-label={searchLabel} autoComplete="off"
        className="panel grid gap-3 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${section}-q`} className="text-xs font-semibold uppercase tracking-wide text-mist">Search</label>
          <input id={`${section}-q`} name="q" type="search" defaultValue={query.q} maxLength={80} autoComplete="off" className="field w-full" placeholder="Title, description or tag" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${section}-category`} className="text-xs font-semibold uppercase tracking-wide text-mist">Category</label>
          <AutoSubmitSelect id={`${section}-category`} name="category" defaultValue={query.category} className="field w-full min-w-0">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </AutoSubmitSelect>
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${section}-tag`} className="text-xs font-semibold uppercase tracking-wide text-mist">Topic</label>
          <AutoSubmitSelect id={`${section}-tag`} name="tag" defaultValue={query.tag} className="field w-full min-w-0">
            <option value="">Any topic</option>
            {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
          </AutoSubmitSelect>
        </div>
        <button type="submit" className="btn-primary">Search</button>
      </form>

      <div aria-live="polite" className="space-y-4">
        {!empty && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-mist">{results.length} {results.length === 1 ? "article" : "articles"} found</p>
            <Link href={`/${section}`} className="text-sm font-medium text-violet-300 underline-offset-2 hover:underline">Clear filters</Link>
          </div>
        )}

        {results.length === 0 ? (
          <EmptyState title={`No ${title.toLowerCase()} match those filters`}>
            Try a different search term, or <Link href={`/${section}`}>clear filters</Link> to browse everything published.
          </EmptyState>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {results.map((a) => <ArticleCard key={a.slug} article={a} section={section} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
