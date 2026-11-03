import { describe, expect, it } from "vitest";
import { selectHomepageNews } from "@/lib/news/selection";
import type { NewsEntry } from "@/lib/data/types";

const entry = (overrides: Partial<NewsEntry>): NewsEntry => ({
  id: 1,
  slug: "entry",
  sourceType: "bluepost",
  sourceKey: "blizzard-bluepost-us",
  sourceEntryId: "post:1",
  sourceTopicId: "topic:1",
  sourcePostNumber: 1,
  threadKey: "us:topic:1",
  canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/entry/1/1",
  title: "Forever announcement",
  author: "Kaivax",
  region: "us",
  publishedAt: "2026-10-22T00:00:00.000Z",
  modifiedAt: null,
  ingestedAt: "2026-10-22T00:01:00.000Z",
  excerpt: "A short excerpt.",
  category: "bluepost",
  importance: 20,
  featured: false,
  ...overrides,
});

describe("homepage news selection", () => {
  it("selects one featured story and three recent stories without duplicating a Bluepost thread", () => {
    const result = selectHomepageNews([
      entry({ id: 1, slug: "reply", sourceEntryId: "post:2", publishedAt: "2026-10-22T03:00:00.000Z", importance: 5 }),
      entry({ id: 2, slug: "featured", sourceEntryId: "post:3", threadKey: "us:topic:2", publishedAt: "2026-10-22T02:00:00.000Z", importance: 90, featured: true }),
      entry({ id: 3, slug: "older", sourceEntryId: "post:4", threadKey: "us:topic:3", publishedAt: "2026-10-22T01:00:00.000Z" }),
      entry({ id: 4, slug: "fourth", sourceEntryId: "post:5", threadKey: "us:topic:4", publishedAt: "2026-10-22T00:30:00.000Z" }),
      entry({ id: 5, slug: "fifth", sourceEntryId: "post:6", threadKey: "us:topic:5", publishedAt: "2026-10-21T23:00:00.000Z" }),
    ], 3);

    expect(result.featured?.slug).toBe("featured");
    expect(result.recent.map((item) => item.slug)).toEqual(["reply", "older", "fourth"]);
    expect(result.recent).not.toContainEqual(expect.objectContaining({ slug: "featured" }));
  });

  it("falls back to the most important recent entry when nothing is explicitly featured", () => {
    const result = selectHomepageNews([
      entry({ id: 1, slug: "recent", importance: 10, threadKey: "us:topic:recent" }),
      entry({ id: 2, slug: "important", importance: 70, threadKey: "us:topic:important", publishedAt: "2026-10-21T00:00:00.000Z" }),
    ], 3);

    expect(result.featured?.slug).toBe("important");
    expect(result.recent.map((item) => item.slug)).toEqual(["recent"]);
  });

  it("ignores Bluepost replies before choosing featured or recent stories", () => {
    const result = selectHomepageNews([
      entry({ id: 1, slug: "original", sourceEntryId: "post:1", sourcePostNumber: 1, importance: 10, publishedAt: "2026-10-22T00:00:00.000Z" }),
      entry({ id: 2, slug: "reply", sourceEntryId: "post:2", sourcePostNumber: 2, importance: 100, featured: true, publishedAt: "2026-10-22T03:00:00.000Z" }),
      entry({ id: 3, slug: "eu-original", sourceKey: "blizzard-bluepost-eu", region: "eu", threadKey: "eu:topic:1", sourceEntryId: "post:3", sourcePostNumber: 1 }),
    ], 3);

    expect(result.featured?.slug).toBe("eu-original");
    expect(result.recent.map((item) => item.slug)).toEqual(["original"]);
    expect(result.featured?.region).toBe("eu");
  });
});
