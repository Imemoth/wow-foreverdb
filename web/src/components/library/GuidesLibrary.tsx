import Link from "next/link";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyState } from "@/components/EmptyState";
import { articlePath, visibleArticles } from "@/lib/content/loader";
import { filterGuides, guideCategories, guideTags, isEmptyGuidesQuery, parseGuidesQuery, sortGuides, type GuidesQuery } from "@/lib/content/guides-query";
import { pageContext } from "@/lib/page";
import { ArcaneLibraryBanner } from "./ArcaneLibraryBanner";
import { GuideCard } from "./GuideCard";

export type SP = Promise<Record<string, string | string[] | undefined>>;

export function toParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v != null) p.append(k, v);
  }
  return p;
}

export async function guidesQueryFrom(searchParams: SP): Promise<GuidesQuery> {
  return parseGuidesQuery(toParams(await searchParams));
}

/**
 * The Arcane Library landing page: a dedicated hero, search/filter form (plain GET - works
 * without JS, keeps state in the URL, matches the established /database and /zone/[id] pattern),
 * and a featured-first, deterministically-ordered guide grid. News and Blog keep the original
 * ArticleList (ArticleViews.tsx) untouched - this component is Guides-only.
 */
export async function GuidesLibrary({ searchParams }: { searchParams: SP }) {
  const { nonce, baseUrl } = await pageContext();
  const all = visibleArticles("guides");
  const query = await guidesQueryFrom(searchParams);
  const empty = isEmptyGuidesQuery(query);
  const categories = guideCategories(all);
  const tags = guideTags(all);
  const results = sortGuides(filterGuides(all, query));

  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Guides" }]} />

      <div className="relative h-56 overflow-hidden rounded-xl border border-ink-700 bg-ink-950 sm:h-72">
        <ArcaneLibraryBanner />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950/85 via-ink-950/15 to-transparent" />
        <div className="relative z-10 flex h-full flex-col justify-end p-5 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-violet-300">Knowledge archive</p>
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl font-bold text-parchment sm:text-4xl">Arcane Library</h1>
          <p className="mt-2 max-w-2xl text-sm text-mist sm:text-base">
            Evergreen guides grounded in collected data — professions, gathering, fishing, and how to read what AzerDex publishes.
          </p>
        </div>
      </div>

      <form action="/guides" method="get" role="search" aria-label="Search the Arcane Library" autoComplete="off"
        className="panel grid gap-3 p-4 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor="g-q" className="text-xs font-semibold uppercase tracking-wide text-mist">Search</label>
          <input id="g-q" name="q" type="search" defaultValue={query.q} maxLength={80} autoComplete="off" className="field" placeholder="Title, description or tag" />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="g-category" className="text-xs font-semibold uppercase tracking-wide text-mist">Category</label>
          <AutoSubmitSelect id="g-category" name="category" defaultValue={query.category} className="field">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </AutoSubmitSelect>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="g-tag" className="text-xs font-semibold uppercase tracking-wide text-mist">Topic</label>
          <AutoSubmitSelect id="g-tag" name="tag" defaultValue={query.tag} className="field">
            <option value="">Any topic</option>
            {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
          </AutoSubmitSelect>
        </div>
        <button type="submit" className="btn-primary">Search</button>
      </form>

      <div aria-live="polite" className="space-y-4">
        {!empty && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-mist">{results.length} {results.length === 1 ? "guide" : "guides"} found</p>
            <Link href="/guides" className="text-sm font-medium text-violet-300 underline-offset-2 hover:underline">Clear filters</Link>
          </div>
        )}

        {results.length === 0 ? (
          <EmptyState title="No guides match those filters">
            Try a different search term, or <Link href="/guides">clear filters</Link> to browse the whole library.
          </EmptyState>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {results.map((g) => <GuideCard key={articlePath(g)} guide={g} />)}
          </ul>
        )}
      </div>
    </div>
  );
}
