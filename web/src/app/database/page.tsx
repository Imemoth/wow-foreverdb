import type { Metadata } from "next";
import Link from "next/link";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { CartographyBanner } from "@/components/cartography/CartographyBanner";
import { EmptyState } from "@/components/EmptyState";
import { Pagination } from "@/components/Pagination";
import { ResultsTable } from "@/components/ResultsTable";
import { DISPLAY_KINDS, InvalidQueryError, LOOT_KINDS, type Page, type SearchQuery, type SearchRow } from "@/lib/data/types";
import { DISPLAY_KIND_PLURAL, LOOT_KIND_LABEL, fmtInt } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { robotsFor } from "@/lib/seo";
import { searchPath } from "@/lib/routes";
import { MAX_OFFSET, PAGE_SIZE, isEmptySearch, parseSearchQuery } from "@/lib/validation";

type SP = Promise<Record<string, string | string[] | undefined>>;

function toParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v != null) p.append(k, v);
  }
  return p;
}

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const params = toParams(await searchParams);
  const q = (params.get("q") ?? "").trim().slice(0, 80);
  return {
    title: q ? `Search: ${q}` : "Database",
    description: "Search AzerDex's observed items, creatures, gathering nodes, fishing zones and pools.",
    alternates: { canonical: "/database" },
    // Result pages are useful to people, thin for search engines.
    robots: robotsFor(isEmptySearch(params)),
  };
}

const ERROR_TEXT: Record<string, string> = {
  query_or_filter_required: "Enter a name or ID, or choose a zone or acquisition type to browse.",
  query_too_short: "Search terms need at least 2 characters.",
  query_too_long: "Search terms can be at most 80 characters.",
  query_invalid_characters: "Search terms cannot contain %, _ or backslashes.",
  page_out_of_range: "That page is beyond the browsable range. Please refine your search.",
  duplicate_parameter: "The search link contains a repeated parameter.",
};

export default async function DatabasePage({ searchParams }: { searchParams: SP }) {
  const { db, nonce, baseUrl } = await pageContext();
  const params = toParams(await searchParams);
  const zones = await db.zones();
  const empty = isEmptySearch(params);

  let query: SearchQuery | null = null;
  let error: string | null = null;
  let result: Page<SearchRow> | null = null;
  if (!empty) {
    try {
      query = parseSearchQuery(params, "lenient");
      result = await db.search(query);
    } catch (e) {
      if (e instanceof InvalidQueryError) error = ERROR_TEXT[e.code] ?? "Those search parameters are not valid.";
      else throw e;
    }
  }

  const v = {
    q: params.get("q")?.slice(0, 80) ?? "",
    category: params.get("category") ?? "",
    zone: params.get("zone") ?? "",
    kind: params.get("kind") ?? "",
    sort: params.get("sort") ?? "relevance",
  };
  // Drives the mobile "Advanced filters" disclosure: any secondary filter already set means it
  // auto-opens instead of hiding an active filter behind a collapsed toggle.
  const hasAdvanced = v.category !== "" || v.zone !== "" || v.kind !== "" || v.sort !== "relevance";
  const advancedCount = [v.category, v.zone, v.kind, v.sort !== "relevance" ? v.sort : ""].filter(Boolean).length;

  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Database" }]} />
      <CartographyBanner compact>
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-bold text-parchment sm:text-3xl">Database</h1>
        <p className="mt-1 text-sm text-mist sm:text-base">Search by name or exact game ID, or browse a zone or acquisition type.</p>
      </CartographyBanner>

      <form action="/database" method="get" role="search" aria-label="Database search and filters" autoComplete="off"
        className="panel grid gap-3 p-4 md:grid-cols-2 md:items-end lg:grid-cols-4 xl:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]">
        {/*
          Tablet (md/lg, 768-1279px): the fixed-fr single-row grid below `xl` has no room to wrap,
          so at intermediate widths (e.g. ~1024-1032px) the five fields + Search button overflow
          and the button clips at the container edge - a real regression an owner caught visually,
          never a viewport our Playwright "desktop" project (1366px) or "mobile" project (~412px)
          exercises. Name/ID and the Search button get their own full-width row at md/lg so neither
          is ever squeezed by the filter fields; at `xl` (1280px+) col-span resets to 1 and this
          becomes the same single `2fr_1fr_1fr_1fr_1fr_auto` row as before - the original desktop
          design is pixel-identical from 1280px up.
        */}
        <div className="flex flex-col gap-1 md:col-span-2 lg:col-span-4 xl:col-span-1">
          <label htmlFor="db-q" className="text-xs font-semibold uppercase tracking-wide text-mist">Name or ID</label>
          <input id="db-q" name="q" type="search" defaultValue={v.q} maxLength={80} autoComplete="off" className="field" placeholder="e.g. Light Leather or 2318" />
        </div>

        {/*
          Mobile: a native <details> disclosure keeps Type/Zone/Acquisition/Sort out of the way until
          asked for - no JS required, Enter/Space toggle it natively, and screen readers announce the
          expanded/collapsed state on <summary> for free.

          The actual fields live in a SEPARATE, ADJACENT div - not inside <details> - and only ever
          take visibility instructions from our own `.db-filters-toggle`/`.db-filters-body` rules in
          globals.css. An earlier version nested them inside <details> and tried to override the
          browser's own closed-<details> hiding with `md:contents`; that is not reliable across
          engines (some hide via plain `display: none`, others via `content-visibility` or an
          internal shadow-tree slot that author CSS on the child can't touch), and it silently ate
          the desktop filters. `aria-controls` keeps the sibling relationship explicit for assistive
          tech despite the DOM split. Single copy of every field either way: no duplicate IDs, no
          field submitted twice.
        */}
        <details className="db-filters-toggle" open={hasAdvanced}>
          <summary aria-controls="db-filters-body" className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-md border border-ink-600 bg-ink-900/60 px-3 py-2 text-sm font-semibold text-parchment marker:content-none [&::-webkit-details-marker]:hidden">
            <span className="flex items-center gap-1.5">
              Advanced filters
              {advancedCount > 0 && <span className="rounded-full bg-violet-500/30 px-1.5 py-0.5 text-xs font-semibold text-violet-300">{advancedCount} active</span>}
            </span>
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-mist" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </summary>
        </details>
        <div id="db-filters-body" className="db-filters-body mt-3 gap-3 md:mt-0">
          <div className="flex flex-col gap-1">
            <label htmlFor="db-category" className="text-xs font-semibold uppercase tracking-wide text-mist">Type</label>
            <AutoSubmitSelect id="db-category" name="category" defaultValue={v.category} className="field">
              <option value="">All types</option>
              {DISPLAY_KINDS.map((k) => <option key={k} value={k}>{DISPLAY_KIND_PLURAL[k]}</option>)}
            </AutoSubmitSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="db-zone" className="text-xs font-semibold uppercase tracking-wide text-mist">Zone</label>
            <AutoSubmitSelect id="db-zone" name="zone" defaultValue={v.zone} className="field">
              <option value="">All zones</option>
              {zones.map((z) => <option key={z.mapId} value={z.mapId}>{z.zoneName}</option>)}
            </AutoSubmitSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="db-kind" className="text-xs font-semibold uppercase tracking-wide text-mist">Acquisition</label>
            <AutoSubmitSelect id="db-kind" name="kind" defaultValue={v.kind} className="field">
              <option value="">Any method</option>
              {LOOT_KINDS.map((k) => <option key={k} value={k}>{LOOT_KIND_LABEL[k]}</option>)}
            </AutoSubmitSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="db-sort" className="text-xs font-semibold uppercase tracking-wide text-mist">Sort</label>
            <AutoSubmitSelect id="db-sort" name="sort" defaultValue={v.sort} className="field">
              <option value="relevance">Relevance</option>
              <option value="name">Name</option>
              <option value="observations">Most observed</option>
            </AutoSubmitSelect>
          </div>
          {advancedCount > 0 && (
            <Link href={searchPath({ q: v.q })} className="text-sm font-medium text-violet-300 underline-offset-2 hover:underline md:hidden">
              Reset filters
            </Link>
          )}
        </div>

        <button type="submit" className="btn-primary md:col-span-2 md:self-end lg:col-span-4 xl:col-span-1">Search</button>
      </form>

      <div aria-live="polite">
        {empty && (
          <section aria-labelledby="hub-title" className="space-y-4">
            <h2 id="hub-title" className="panel-title text-xl">Start browsing</h2>
            <p className="text-sm text-mist">
              To keep the database fast and fair for everyone, browsing without a search term needs a zone or an acquisition type.
            </p>
            <ul className="flex flex-wrap gap-2">
              {LOOT_KINDS.map((k) => (
                <li key={k}><Link className="btn-ghost text-sm" href={searchPath({ kind: k, category: v.category || null })}>{LOOT_KIND_LABEL[k]}</Link></li>
              ))}
            </ul>
            <ul className="flex flex-wrap gap-2">
              {zones.map((z) => (
                <li key={z.mapId}><Link className="btn-ghost text-sm" href={searchPath({ zone: z.mapId, category: v.category || null })}>{z.zoneName}</Link></li>
              ))}
            </ul>
          </section>
        )}

        {error && (
          <div role="alert" className="panel border-danger/50 p-4 text-sm text-danger">{error}</div>
        )}

        {result && query && (
          <section aria-labelledby="results-title" className="space-y-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="results-title" className="font-semibold text-parchment">
                {fmtInt(result.total)} {result.total === 1 ? "result" : "results"}
                {query.q && <> for “{query.q}”</>}
              </h2>
              {result.total > 0 && (
                <p className="text-sm text-mist">
                  Showing {fmtInt((query.page - 1) * query.pageSize + 1)}–{fmtInt(Math.min(result.total, query.page * query.pageSize))}
                </p>
              )}
            </div>
            {result.rows.length === 0 ? (
              <EmptyState title="No observations match">
                AzerDex only lists what players have actually observed. Try a different spelling, an exact game ID, or
                remove a filter. Missing something? <Link href="/download">Run the addon</Link> to help collect it.
              </EmptyState>
            ) : (
              <ResultsTable rows={result.rows} zones={zones} caption="Search results" />
            )}
            <Pagination page={query.page} pageSize={query.pageSize} total={result.total} maxPage={Math.floor(MAX_OFFSET / PAGE_SIZE) + 1}
              hrefFor={(p) => searchPath({ ...v, page: p })} />
          </section>
        )}
      </div>
    </div>
  );
}
