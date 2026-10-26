import { describe, expect, it } from "vitest";
import {
  articleCategories,
  articleTags,
  filterArticles,
  isEmptyArticleQuery,
  parseArticleQuery,
  sortArticles,
  type ArticleQuery,
} from "@/lib/content/article-query";
import type { Article } from "@/lib/content/loader";

function article(over: Partial<Article>): Article {
  return {
    title: "T", description: "D".repeat(20), slug: "t", category: "Setup", tags: [], author: "A",
    publishedAt: "2026-01-01T00:00:00.000Z", status: "published", sample: false, featured: false,
    related: { items: [], sources: [], articles: [] }, section: "news", body: "", readingMinutes: 1,
    ...over,
  };
}

describe("parseArticleQuery", () => {
  it("trims, defaults to empty strings and caps length", () => {
    expect(parseArticleQuery(new URLSearchParams())).toEqual({ q: "", category: "", tag: "" });
    expect(parseArticleQuery(new URLSearchParams({ q: "  companion  " }))).toEqual({ q: "companion", category: "", tag: "" });
    expect(parseArticleQuery(new URLSearchParams({ q: "x".repeat(200) })).q.length).toBe(80);
  });
});

describe("isEmptyArticleQuery", () => {
  it("is true only when every field is empty", () => {
    expect(isEmptyArticleQuery({ q: "", category: "", tag: "" })).toBe(true);
    expect(isEmptyArticleQuery({ q: "x", category: "", tag: "" })).toBe(false);
    expect(isEmptyArticleQuery({ q: "", category: "Companion", tag: "" })).toBe(false);
    expect(isEmptyArticleQuery({ q: "", category: "", tag: "security" })).toBe(false);
  });
});

describe("filterArticles", () => {
  const articles = [
    article({ slug: "a", title: "Companion 0.8.2 Guildbook", description: "roster rows", category: "Companion", tags: ["companion", "guildbook"] }),
    article({ slug: "b", title: "Zone browsing", description: "hardened backend API", category: "Companion", tags: ["companion", "security"] }),
    article({ slug: "c", title: "Public database design", description: "security architecture", category: "Engineering", tags: ["security", "architecture"] }),
  ];
  const empty: ArticleQuery = { q: "", category: "", tag: "" };

  it("matches q against title, description and tags, case-insensitively", () => {
    expect(filterArticles(articles, { ...empty, q: "GUILDBOOK" }).map((a) => a.slug)).toEqual(["a"]);
    expect(filterArticles(articles, { ...empty, q: "hardened" }).map((a) => a.slug)).toEqual(["b"]);
    expect(filterArticles(articles, { ...empty, q: "architecture" }).map((a) => a.slug)).toEqual(["c"]);
  });
  it("filters by exact category", () => {
    expect(filterArticles(articles, { ...empty, category: "Companion" }).map((a) => a.slug)).toEqual(["a", "b"]);
  });
  it("filters by exact tag membership", () => {
    expect(filterArticles(articles, { ...empty, tag: "security" }).map((a) => a.slug)).toEqual(["b", "c"]);
  });
  it("AND-combines category, tag and q", () => {
    expect(filterArticles(articles, { q: "zone", category: "Companion", tag: "security" }).map((a) => a.slug)).toEqual(["b"]);
    expect(filterArticles(articles, { q: "guildbook", category: "Companion", tag: "security" })).toEqual([]);
  });
  it("an unrecognised category/tag value matches nothing, never throws", () => {
    expect(() => filterArticles(articles, { ...empty, category: "<script>nope" })).not.toThrow();
    expect(filterArticles(articles, { ...empty, category: "<script>nope" })).toEqual([]);
    expect(filterArticles(articles, { ...empty, tag: "does-not-exist" })).toEqual([]);
  });
  it("empty query returns every article", () => {
    expect(filterArticles(articles, empty)).toHaveLength(3);
  });
});

describe("sortArticles", () => {
  it("puts featured first, then newest, then slug - stable and deterministic", () => {
    const articles = [
      article({ slug: "old-featured", publishedAt: "2026-01-01T00:00:00.000Z", featured: true }),
      article({ slug: "new", publishedAt: "2026-03-01T00:00:00.000Z" }),
      article({ slug: "new-featured", publishedAt: "2026-02-01T00:00:00.000Z", featured: true }),
      article({ slug: "old", publishedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(sortArticles(articles).map((a) => a.slug)).toEqual(["new-featured", "old-featured", "new", "old"]);
  });
  it("does not mutate its input", () => {
    const articles = [article({ slug: "b", publishedAt: "2026-01-01T00:00:00.000Z" }), article({ slug: "a", publishedAt: "2026-02-01T00:00:00.000Z" })];
    const copy = [...articles];
    sortArticles(articles);
    expect(articles).toEqual(copy);
  });
});

describe("articleCategories / articleTags", () => {
  it("derive a sorted, de-duplicated list from the actual articles - nothing invented", () => {
    const articles = [
      article({ category: "Companion", tags: ["companion", "security"] }),
      article({ category: "Engineering", tags: ["architecture"] }),
      article({ category: "Companion", tags: ["guildbook", "companion"] }),
    ];
    expect(articleCategories(articles)).toEqual(["Companion", "Engineering"]);
    expect(articleTags(articles)).toEqual(["architecture", "companion", "guildbook", "security"]);
  });
});
