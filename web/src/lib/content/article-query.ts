import type { Article } from "./loader";

/**
 * Pure, in-memory search/filter for the News and Blog hubs - deliberately parallel to
 * lib/content/guides-query.ts (same shape, same semantics) rather than a refactor of it: Guides
 * already shipped to the public beta in P2-B, and this file exists so News/Blog reuse one
 * implementation between themselves without touching that working code path. Like its Guides
 * counterpart, the content set is small and repository-managed, so there is nothing to escape or
 * paginate: an unrecognised category/tag value simply matches nothing (a safe, inert default)
 * rather than needing a rejected/invalid-query error path.
 */
export interface ArticleQuery {
  q: string;
  category: string;
  tag: string;
}

const MAX_Q_LEN = 80;
const MAX_FIELD_LEN = 40;

export function parseArticleQuery(params: URLSearchParams): ArticleQuery {
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_Q_LEN),
    category: (params.get("category") ?? "").trim().slice(0, MAX_FIELD_LEN),
    tag: (params.get("tag") ?? "").trim().slice(0, MAX_FIELD_LEN),
  };
}

export function isEmptyArticleQuery(q: ArticleQuery): boolean {
  return q.q === "" && q.category === "" && q.tag === "";
}

/** Case-insensitive substring match against title, description and tags, AND-combined with category/tag. */
export function filterArticles(articles: Article[], q: ArticleQuery): Article[] {
  const needle = q.q.toLowerCase();
  return articles.filter((a) => {
    if (q.category && a.category !== q.category) return false;
    if (q.tag && !a.tags.includes(q.tag)) return false;
    if (needle) {
      const haystack = `${a.title} ${a.description} ${a.tags.join(" ")}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/** Featured first, then newest, then slug - deterministic and stable under every filter combination. */
export function sortArticles(articles: Article[]): Article[] {
  return [...articles].sort(
    (a, b) =>
      (b.featured ? 1 : 0) - (a.featured ? 1 : 0) ||
      b.publishedAt.localeCompare(a.publishedAt) ||
      a.slug.localeCompare(b.slug),
  );
}

export function articleCategories(articles: Article[]): string[] {
  return [...new Set(articles.map((a) => a.category))].sort();
}

export function articleTags(articles: Article[]): string[] {
  return [...new Set(articles.flatMap((a) => a.tags))].sort();
}
