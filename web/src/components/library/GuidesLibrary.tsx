import Link from "next/link";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyState } from "@/components/EmptyState";
import { articlePath, visibleArticles } from "@/lib/content/loader";
import { filterGuides, guideCategories, guideTags, isEmptyGuidesQuery, parseGuidesQuery, sortGuides, type GuidesQuery } from "@/lib/content/guides-query";
import { pageContext } from "@/lib/page";
import { ClassGuidesEntry } from "@/components/classes/ClassGuidesEntry";
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
 * and a featured-first, deterministically-ordered guide grid. News and Blog (P2-C) have their own
 * parallel hub, components/content/ArticleHub.tsx - this component stays Guides-only and untouched.
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

      {/* Full-bleed cinematic hero: breaks out of <main>'s max-w-7xl/px-4 container the same
          way the homepage hero's .hero-bleed does (see globals.css), but without its
          negative margin-top - this isn't the first element under <main> here, the
          breadcrumb sits above it, so pulling the hero up would run it under that. Reuses
          the homepage hero's .hero-vignette/.hero-fade-bottom chrome and its
          flex/min-h/justify-center composition technique so the section reads as the same
          premium "flowing" hero language, while staying visually distinct: left-aligned
          copy (not centered), no logo or inline search (the search/filter panel stays its
          own block below, unchanged), and its own Arcane Library artwork/palette. */}
      <div className="relative left-1/2 w-screen -ml-[50vw]">
        <section
          aria-labelledby="guides-hero-title"
          className="relative flex min-h-[320px] flex-col justify-center overflow-hidden bg-ink-950 py-10 sm:min-h-[460px] sm:py-14 lg:min-h-[540px] lg:py-16"
        >
          {/* Permanent fallback (no raster image, works with JS off or if the photo below fails to
              load) - same principle as the homepage hero's SVG/gradient base layer. */}
          <ArcaneLibraryBanner />
          {/* Owner-approved photo layer, art-directed per breakpoint (see
              docs/azerdex-library-art/provenance.md): a tighter square crop on mobile, the native
              ultra-wide scene from sm: up. Plain <picture>/<img>, no next/image inline styles (this
              is a server component; see CategoryIcon.tsx for why that would hit the page CSP), no
              client JS needed. */}
          <picture>
            <source media="(max-width: 639px)" srcSet="/library/arcane-library-hero-mobile.webp" />
            <img
              src="/library/arcane-library-hero.webp"
              alt=""
              aria-hidden="true"
              className="absolute inset-0 h-full w-full object-cover object-[68%_32%] sm:object-[62%_26%] lg:object-[center_24%]"
            />
          </picture>
          {/* Ambient radial darkening (shared with the homepage hero) plus a bottom-weighted
              scrim tuned for this busier photo - together they keep the centered copy block
              readable without flattening the art into a flat card tint. */}
          <div className="hero-vignette" />
          <div className="absolute inset-0 bg-gradient-to-t from-ink-950/85 via-ink-950/35 to-ink-950/15" />
          {/* Gradual fade into the page background below, so the hero flows into the search
              panel instead of ending on a hard image edge - same technique as the homepage. */}
          <div className="hero-fade-bottom" />
          <div className="relative z-10 mx-auto w-full max-w-7xl px-4">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em] text-violet-300">
              {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
              <img src="/library/medallions/wayfinder.webp" alt="" aria-hidden="true" className="h-5 w-5 sm:h-6 sm:w-6" />
              Knowledge archive
            </p>
            <h1 id="guides-hero-title" className="mt-2 font-[family-name:var(--font-display)] text-4xl font-bold leading-tight text-parchment sm:text-5xl lg:text-6xl">
              Arcane Library
            </h1>
            <p className="mt-3 max-w-2xl text-sm text-mist sm:text-base lg:text-lg">
              Evergreen guides grounded in collected data — professions, gathering, fishing, and how to read what AzerDex publishes.
            </p>
          </div>
        </section>
      </div>

      <ClassGuidesEntry />

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
