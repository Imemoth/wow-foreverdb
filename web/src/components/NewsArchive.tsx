import Link from "next/link";
import { SECTION_META } from "@/components/ArticleViews";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { NewsCard } from "@/components/NewsCard";
import { data } from "@/lib/data";
import { NEWS_CATEGORIES, type NewsCategory } from "@/lib/data/types";
import { visibleArticles, articlePath } from "@/lib/content/loader";
import { fmtDate } from "@/lib/format";
import { filterNewsByRegion, type NewsRegionFilter } from "@/lib/news/presentation";
import { pageContext } from "@/lib/page";

const PAGE_SIZE = 12;
// web_api.news_list currently accepts offsets through 5000. Region filtering
// is performed after the stable database ordering so the existing UI can keep
// exact search, ordering, and pagination without changing the database.
const REGION_FILTER_FETCH_CEILING = 5000;
const TABS: Array<{ label: string; value: NewsCategory | null }> = [
  { label: "All News", value: null },
  { label: "Blue Posts", value: "bluepost" },
  { label: "Official News", value: "official_news" },
  { label: "AzerDex", value: "azerdex" },
];
const REGION_TABS: Array<{ label: string; value: NewsRegionFilter }> = [
  { label: "All regions", value: "all" },
  { label: "US", value: "us" },
  { label: "EU", value: "eu" },
];

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function queryUrl(category: NewsCategory | null, query: string, page: number, region: NewsRegionFilter = "all"): string {
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (query) params.set("q", query);
  if (category === "bluepost" && region !== "all") params.set("region", region);
  if (page > 1) params.set("page", String(page));
  const encoded = params.toString();
  return encoded ? "/news?" + encoded : "/news";
}

async function loadAllNews(category: NewsCategory | null, query: string) {
  const pageSize = 50;
  const firstPage = await data().newsList({ category, query, page: 1, pageSize });
  if (firstPage.total > REGION_FILTER_FETCH_CEILING) throw new Error("news_region_filter_requires_rpc");
  const totalPages = Math.min(Math.ceil(firstPage.total / pageSize), 100);
  const remainingPages = await Promise.all(Array.from({ length: Math.max(0, totalPages - 1) }, (_, index) =>
    data().newsList({ category, query, page: index + 2, pageSize })));
  const rows = [firstPage.rows, ...remainingPages.map((page) => page.rows)].flat().slice(0, firstPage.total);
  return { rows, total: firstPage.total };
}

async function loadNews(category: NewsCategory | null, query: string, page: number, region: NewsRegionFilter) {
  try {
    if (category === "bluepost" && region !== "all") {
      const all = await loadAllNews(category, query);
      const filtered = filterNewsByRegion(all.rows, region);
      const start = (page - 1) * PAGE_SIZE;
      return { result: { rows: filtered.slice(start, start + PAGE_SIZE), total: filtered.length }, error: false };
    }
    return { result: await data().newsList({ category, query, page, pageSize: PAGE_SIZE }), error: false, regionFilterUnavailable: false };
  } catch (error) {
    return {
      result: { rows: [], total: 0 },
      error: true,
      regionFilterUnavailable: error instanceof Error && error.message === "news_region_filter_requires_rpc",
    };
  }
}

export async function NewsArchive({ searchParams = {} }: { searchParams?: SearchParams | Promise<SearchParams> }) {
  const { nonce, baseUrl } = await pageContext();
  const params = await searchParams;
  const rawCategory = first(params.category);
  const category = NEWS_CATEGORIES.includes(rawCategory as NewsCategory) ? rawCategory as NewsCategory : null;
  const rawRegion = first(params.region);
  const region: NewsRegionFilter = category === "bluepost" && ["all", "us", "eu"].includes(rawRegion) ? rawRegion as NewsRegionFilter : "all";
  const query = first(params.q).trim().slice(0, 80);
  const parsedPage = Number.parseInt(first(params.page), 10);
  const page = Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const initialLoad = await loadNews(category, query, page, region);
  const totalPages = Math.max(1, Math.ceil(initialLoad.result.total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const adjustedLoad = !initialLoad.error && safePage !== page ? await loadNews(category, query, safePage, region) : null;
  const result = adjustedLoad?.result ?? initialLoad.result;
  const newsError = initialLoad.error || Boolean(adjustedLoad?.error);
  const regionFilterUnavailable = initialLoad.regionFilterUnavailable || Boolean(adjustedLoad?.regionFilterUnavailable);
  const editorial = visibleArticles("news");

  return (
    <div className="space-y-10">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "News" }]} />
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-parchment">News</h1>
          <p className="mt-1 max-w-2xl text-mist">Official WoW: Forever news, Blue Posts, and AzerDex development updates.</p>
        </div>
        <Link href="/news/rss.xml" className="btn-ghost text-sm">RSS feed</Link>
      </header>

      <nav aria-label="News categories" className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Link key={tab.label} href={queryUrl(tab.value, query, 1, tab.value === "bluepost" ? region : "all")}
            aria-current={category === tab.value ? "page" : undefined}
            className={category === tab.value
              ? "rounded-full border border-gold-400 bg-gold-400/10 px-3 py-1.5 text-sm text-gold-300 no-underline"
              : "rounded-full border border-ink-600 px-3 py-1.5 text-sm text-mist no-underline hover:border-gold-500/60 hover:text-parchment"}>
            {tab.label}
          </Link>
        ))}
      </nav>

      {category === "bluepost" && (
        <nav aria-label="Bluepost regions" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="mr-1 text-xs font-semibold uppercase tracking-[0.16em] text-mist">Region</span>
          {REGION_TABS.map((tab) => (
            <Link key={tab.value} href={queryUrl(category, query, 1, tab.value)}
              aria-current={region === tab.value ? "page" : undefined}
              className={region === tab.value
                ? "rounded-full border border-sky-300/70 bg-sky-300/10 px-3 py-1.5 text-sky-100 no-underline"
                : "rounded-full border border-ink-600 px-3 py-1.5 text-mist no-underline hover:border-sky-300/60 hover:text-parchment"}>
              {tab.label}
            </Link>
          ))}
        </nav>
      )}

      <form action="/news" method="get" role="search" className="flex max-w-2xl flex-col gap-2 sm:flex-row">
        {category && <input type="hidden" name="category" value={category} />}
        {category === "bluepost" && region !== "all" && <input type="hidden" name="region" value={region} />}
        <label htmlFor="news-q" className="sr-only">Search news by title or excerpt</label>
        <input id="news-q" name="q" type="search" value={query} maxLength={80} placeholder="Search titles and excerpts" className="field min-h-11 flex-1" />
        <button className="btn-primary min-h-11 px-5" type="submit">Search news</button>
      </form>

      <section aria-labelledby="source-news-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="source-news-title" className="panel-title text-2xl">Latest from Azeroth</h2>
          {!newsError && <p className="text-xs text-mist">{result.total} published {result.total === 1 ? "entry" : "entries"}</p>}
        </div>
        {newsError ? (
          <div className="panel mt-4 p-6 text-sm text-mist" role="alert">
            {regionFilterUnavailable
              ? "This region filter has reached the current archive scan limit. Refine your search or use All regions."
              : "The news feed is temporarily unavailable. Please try again shortly."}
          </div>
        ) : result.rows.length === 0 ? (
          <div className="panel mt-4 p-6 text-sm text-mist">No published news matches those filters. Try another category or search term.</div>
        ) : (
          <ul className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {result.rows.map((entry) => <li key={entry.id}><NewsCard entry={entry} /></li>)}
          </ul>
        )}
        {totalPages > 1 && (
          <nav aria-label="News pages" className="mt-6 flex items-center justify-between gap-3 text-sm">
            {safePage > 1 ? <Link className="btn-ghost" href={queryUrl(category, query, safePage - 1, region)}>← Newer</Link> : <span />}
            <span className="text-mist">Page {safePage} of {totalPages}</span>
            {safePage < totalPages ? <Link className="btn-ghost" href={queryUrl(category, query, safePage + 1, region)}>Older →</Link> : <span />}
          </nav>
        )}
      </section>

      <section aria-labelledby="editorial-news-title" className="space-y-4">
        <div>
          <h2 id="editorial-news-title" className="panel-title text-2xl">AzerDex editorial archive</h2>
          <p className="mt-1 text-sm text-mist">{SECTION_META.news.intro}</p>
        </div>
        {editorial.length === 0 ? <p className="text-sm text-mist">No editorial updates are published yet.</p> : (
          <ul className="grid gap-3 md:grid-cols-2">
            {editorial.map((article) => (
              <li key={article.slug} className="panel p-4">
                <Link href={articlePath(article)} className="font-semibold text-parchment no-underline hover:text-gold-300">{article.title}</Link>
                <p className="mt-1 text-sm text-mist">{article.description}</p>
                <p className="mt-2 text-xs text-mist"><time dateTime={article.publishedAt}>{fmtDate(article.publishedAt)}</time> · {article.author}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
