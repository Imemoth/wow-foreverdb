import { describe, expect, it } from "vitest";
import {
  filterGuides,
  guideCategories,
  guideTags,
  isEmptyGuidesQuery,
  parseGuidesQuery,
  sortGuides,
  type GuidesQuery,
} from "@/lib/content/guides-query";
import type { Article } from "@/lib/content/loader";

function guide(over: Partial<Article>): Article {
  return {
    title: "T", description: "D".repeat(20), slug: "t", category: "Setup", tags: [], author: "A",
    publishedAt: "2026-01-01T00:00:00.000Z", status: "published", sample: false, featured: false,
    related: { items: [], sources: [], articles: [] }, section: "guides", body: "", readingMinutes: 1,
    ...over,
  };
}

describe("parseGuidesQuery", () => {
  it("trims, defaults to empty strings and caps length", () => {
    expect(parseGuidesQuery(new URLSearchParams())).toEqual({ q: "", category: "", tag: "" });
    expect(parseGuidesQuery(new URLSearchParams({ q: "  mining  " }))).toEqual({ q: "mining", category: "", tag: "" });
    expect(parseGuidesQuery(new URLSearchParams({ q: "x".repeat(200) })).q.length).toBe(80);
  });
});

describe("isEmptyGuidesQuery", () => {
  it("is true only when every field is empty", () => {
    expect(isEmptyGuidesQuery({ q: "", category: "", tag: "" })).toBe(true);
    expect(isEmptyGuidesQuery({ q: "x", category: "", tag: "" })).toBe(false);
    expect(isEmptyGuidesQuery({ q: "", category: "Setup", tag: "" })).toBe(false);
    expect(isEmptyGuidesQuery({ q: "", category: "", tag: "mining" })).toBe(false);
  });
});

describe("filterGuides", () => {
  const guides = [
    guide({ slug: "a", title: "Getting started", description: "install the addon", category: "Setup", tags: ["setup", "addon"] }),
    guide({ slug: "b", title: "Mining copper", description: "ore and gems", category: "Professions", tags: ["mining", "gathering"] }),
    guide({ slug: "c", title: "Fishing guide", description: "pools vs zones", category: "Professions", tags: ["fishing", "gathering"] }),
  ];
  const empty: GuidesQuery = { q: "", category: "", tag: "" };

  it("matches q against title, description and tags, case-insensitively", () => {
    expect(filterGuides(guides, { ...empty, q: "MINING" }).map((g) => g.slug)).toEqual(["b"]);
    expect(filterGuides(guides, { ...empty, q: "pools" }).map((g) => g.slug)).toEqual(["c"]);
    expect(filterGuides(guides, { ...empty, q: "addon" }).map((g) => g.slug)).toEqual(["a"]);
  });
  it("filters by exact category", () => {
    expect(filterGuides(guides, { ...empty, category: "Professions" }).map((g) => g.slug)).toEqual(["b", "c"]);
  });
  it("filters by exact tag membership", () => {
    expect(filterGuides(guides, { ...empty, tag: "gathering" }).map((g) => g.slug)).toEqual(["b", "c"]);
  });
  it("AND-combines category, tag and q", () => {
    expect(filterGuides(guides, { q: "fishing", category: "Professions", tag: "gathering" }).map((g) => g.slug)).toEqual(["c"]);
    expect(filterGuides(guides, { q: "mining", category: "Professions", tag: "fishing" })).toEqual([]);
  });
  it("an unrecognised category/tag value matches nothing, never throws", () => {
    expect(() => filterGuides(guides, { ...empty, category: "<script>nope" })).not.toThrow();
    expect(filterGuides(guides, { ...empty, category: "<script>nope" })).toEqual([]);
    expect(filterGuides(guides, { ...empty, tag: "does-not-exist" })).toEqual([]);
  });
  it("empty query returns every guide", () => {
    expect(filterGuides(guides, empty)).toHaveLength(3);
  });
});

describe("sortGuides", () => {
  it("puts featured first, then newest, then slug - stable and deterministic", () => {
    const guides = [
      guide({ slug: "old-featured", publishedAt: "2026-01-01T00:00:00.000Z", featured: true }),
      guide({ slug: "new", publishedAt: "2026-03-01T00:00:00.000Z" }),
      guide({ slug: "new-featured", publishedAt: "2026-02-01T00:00:00.000Z", featured: true }),
      guide({ slug: "old", publishedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(sortGuides(guides).map((g) => g.slug)).toEqual(["new-featured", "old-featured", "new", "old"]);
  });
  it("does not mutate its input", () => {
    const guides = [guide({ slug: "b", publishedAt: "2026-01-01T00:00:00.000Z" }), guide({ slug: "a", publishedAt: "2026-02-01T00:00:00.000Z" })];
    const copy = [...guides];
    sortGuides(guides);
    expect(guides).toEqual(copy);
  });
});

describe("guideCategories / guideTags", () => {
  it("derive a sorted, de-duplicated list from the actual guides - nothing invented", () => {
    const guides = [
      guide({ category: "Professions", tags: ["mining", "gathering"] }),
      guide({ category: "Setup", tags: ["setup"] }),
      guide({ category: "Professions", tags: ["gathering", "fishing"] }),
    ];
    expect(guideCategories(guides)).toEqual(["Professions", "Setup"]);
    expect(guideTags(guides)).toEqual(["fishing", "gathering", "mining", "setup"]);
  });
});
