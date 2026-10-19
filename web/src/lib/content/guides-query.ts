import type { Article } from "./loader";

/**
 * Pure, in-memory search/filter for the Guides library. Unlike the Database search (lib/validation.ts),
 * this never touches SQL and the content set is small and repository-managed, so there is nothing to
 * escape or paginate: an unrecognised category/tag value simply matches nothing (a safe, inert default)
 * rather than needing a rejected/invalid-query error path.
 */
export interface GuidesQuery {
  q: string;
  category: string;
  tag: string;
}

const MAX_Q_LEN = 80;
const MAX_FIELD_LEN = 40;

export function parseGuidesQuery(params: URLSearchParams): GuidesQuery {
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_Q_LEN),
    category: (params.get("category") ?? "").trim().slice(0, MAX_FIELD_LEN),
    tag: (params.get("tag") ?? "").trim().slice(0, MAX_FIELD_LEN),
  };
}

export function isEmptyGuidesQuery(q: GuidesQuery): boolean {
  return q.q === "" && q.category === "" && q.tag === "";
}

/** Case-insensitive substring match against title, description and tags, AND-combined with category/tag. */
export function filterGuides(guides: Article[], q: GuidesQuery): Article[] {
  const needle = q.q.toLowerCase();
  return guides.filter((g) => {
    if (q.category && g.category !== q.category) return false;
    if (q.tag && !g.tags.includes(q.tag)) return false;
    if (needle) {
      const haystack = `${g.title} ${g.description} ${g.tags.join(" ")}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/** Featured first, then newest, then slug - deterministic and stable under every filter combination. */
export function sortGuides(guides: Article[]): Article[] {
  return [...guides].sort(
    (a, b) =>
      (b.featured ? 1 : 0) - (a.featured ? 1 : 0) ||
      b.publishedAt.localeCompare(a.publishedAt) ||
      a.slug.localeCompare(b.slug),
  );
}

export function guideCategories(guides: Article[]): string[] {
  return [...new Set(guides.map((g) => g.category))].sort();
}

export function guideTags(guides: Article[]): string[] {
  return [...new Set(guides.flatMap((g) => g.tags))].sort();
}
