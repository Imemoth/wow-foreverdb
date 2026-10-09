import type { Metadata } from "next";
import Link from "next/link";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { Breadcrumbs } from "@/components/Breadcrumbs";
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
    description: "Search ForeverDB's observed items, creatures, gathering nodes, fishing zones and pools.",
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

  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Database" }]} />
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-parchment">Database</h1>
        <p className="mt-1 text-mist">Search by name or exact game ID, or browse a zone or acquisition type.</p>
      </header>

      <form action="/database" method="get" role="search" aria-label="Database search and filters" autoComplete="off"
        className="panel grid gap-3 p-4 md:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto] md:items-end">
        <div className="flex flex-col gap-1">
          <label htmlFor="db-q" className="text-xs font-semibold uppercase tracking-wide text-mist">Name or ID</label>
          <input id="db-q" name="q" type="search" defaultValue={v.q} maxLength={80} autoComplete="off" className="field" placeholder="e.g. Light Leather or 2318" />
        </div>
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
        <button type="submit" className="btn-gold">Search</button>
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
                ForeverDB only lists what players have actually observed. Try a different spelling, an exact game ID, or
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
