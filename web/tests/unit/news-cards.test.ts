import { describe, expect, it } from "vitest";
import { buildNewsCards, entryKindOf, isVisibleNewsEntry, officialAt, threadUpdates, type NewsEntrySource } from "@/lib/news/cards";
import { newsDates, newsKindLabel } from "@/lib/news/presentation";
import { selectHomepageNews } from "@/lib/news/selection";

const NOW = new Date("2026-11-04T12:00:00.000Z");
let seq = 0;
const post = (o: Partial<NewsEntrySource>): NewsEntrySource => {
  seq += 1;
  return {
    id: seq, slug: `entry-${seq}`, sourceType: "bluepost", sourceKey: "blizzard-bluepost-us", sourceEntryId: `post:${seq}`,
    sourceTopicId: "topic:77", sourcePostNumber: 1, threadKey: "us:topic:77",
    canonicalUrl: `https://us.forums.blizzard.com/en/wow/t/x/77/${o.sourcePostNumber ?? 1}`, title: "WoW Forever Beta Development Notes",
    author: "Kaivax", region: "us", publishedAt: "2026-09-24T22:23:24.000Z", modifiedAt: null, ingestedAt: "2026-11-04T00:00:00.000Z",
    excerpt: "Notes.", category: "bluepost", importance: 0, featured: false, ...o,
  };
};
const verified = { authorUserId: 3390, authorGroup: "community-manager", threadOrigin: "official" as const };

describe("News card contract (mirror of the database view)", () => {
  it("collapses a thread to ONE card represented by the latest verified official post, linking to that post", () => {
    const cards = buildNewsCards([
      post({ id: 1, sourcePostNumber: 1 }),
      post({ id: 2, sourcePostNumber: 9, publishedAt: "2026-11-03T03:20:33.000Z", ...verified }),
    ], { now: NOW });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 2, sourcePostNumber: 9, updateCount: 2, entryKind: "official_update", threadPublishedAt: "2026-09-24T22:23:24.000Z" });
    expect(cards[0]!.canonicalUrl).toMatch(/\/77\/9$/);
    expect(cards[0]!.publishedAt).toBe("2026-11-03T03:20:33.000Z"); // the post's own date, not the thread's
  });

  it("never shows ordinary replies, unverified staff claims, or a spoofed display name", () => {
    const entries = [
      post({ id: 1 }),
      post({ id: 2, sourcePostNumber: 2, author: "ordinary-player", publishedAt: "2026-11-04T00:00:00.000Z" }),
      post({ id: 3, sourcePostNumber: 3, author: "Kaivax", publishedAt: "2026-11-04T01:00:00.000Z" }), // right name, no provenance
      post({ id: 4, sourcePostNumber: 4, author: "Kaivax", publishedAt: "2026-11-04T02:00:00.000Z", authorUserId: 3390, authorGroup: "community-manager" }), // no origin
      post({ id: 5, sourcePostNumber: 5, author: "Kaivax", publishedAt: "2026-11-04T03:00:00.000Z", authorUserId: 3390, threadOrigin: "official" }), // no group
    ];
    expect(entries.map((entry) => isVisibleNewsEntry(entry, NOW))).toEqual([true, false, false, false, false]);
    const cards = buildNewsCards(entries, { now: NOW });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.id).toBe(1);
    expect(cards[0]!.updateCount).toBe(1);
  });

  it("orders by latest verified official activity: an old thread with a fresh official reply outranks a newer announcement; ordinary replies do not", () => {
    const old = [post({ id: 1, publishedAt: "2026-09-24T00:00:00.000Z" }), post({ id: 2, sourcePostNumber: 9, publishedAt: "2026-11-03T03:20:33.000Z", ...verified })];
    const newer = post({ id: 3, sourceTopicId: "topic:99", threadKey: "us:topic:99", publishedAt: "2026-10-30T12:00:00.000Z", title: "Another announcement" });
    const staleThread = [post({ id: 4, sourceTopicId: "topic:5", threadKey: "us:topic:5", publishedAt: "2026-10-31T00:00:00.000Z", title: "Stale thread" }),
      post({ id: 5, sourceTopicId: "topic:5", threadKey: "us:topic:5", sourcePostNumber: 40, publishedAt: "2026-11-04T09:00:00.000Z", author: "ordinary-player" })];
    const cards = buildNewsCards([...old, newer, ...staleThread], { now: NOW });
    expect(cards.map((card) => card.sourceTopicId)).toEqual(["topic:77", "topic:5", "topic:99"]);
  });

  it("uses a meaningful edit (officialUpdatedAt) for position but never alters the original publication date", () => {
    const edited = post({ id: 1, publishedAt: "2026-09-24T22:23:24.000Z", officialUpdatedAt: "2026-11-03T03:20:46.000Z" });
    const other = post({ id: 2, sourceTopicId: "topic:2", threadKey: "us:topic:2", publishedAt: "2026-11-01T00:00:00.000Z" });
    const [first] = buildNewsCards([other, edited], { now: NOW });
    expect(first).toMatchObject({ id: 1, publishedAt: "2026-09-24T22:23:24.000Z", officialUpdatedAt: "2026-11-03T03:20:46.000Z" });
    expect(officialAt(edited)).toBe("2026-11-03T03:20:46.000Z");
  });

  it("keeps US and EU threads separate, filters by region in the data layer and paginates consistently", () => {
    const entries = [
      post({ id: 1 }), post({ id: 2, sourceKey: "blizzard-bluepost-eu", region: "eu", threadKey: "eu:topic:77", publishedAt: "2026-09-24T22:37:36.000Z" }),
      ...Array.from({ length: 5 }, (_, i) => post({ id: 10 + i, sourceTopicId: `topic:${100 + i}`, threadKey: `us:topic:${100 + i}`, publishedAt: `2026-10-0${i + 1}T00:00:00.000Z` })),
    ];
    expect(buildNewsCards(entries, { now: NOW })).toHaveLength(7);
    expect(buildNewsCards(entries, { now: NOW, region: "eu" }).map((card) => card.id)).toEqual([2]);
    expect(buildNewsCards(entries, { now: NOW, region: "us" })).toHaveLength(6);
    const all = buildNewsCards(entries, { now: NOW });
    expect(new Set(all.map((card) => card.threadKey)).size).toBe(all.length);
  });

  it("matches a search against any verified update in the thread", () => {
    const entries = [post({ id: 1, excerpt: "alpha opener text" }), post({ id: 2, sourcePostNumber: 9, publishedAt: "2026-11-03T00:00:00.000Z", excerpt: "beta reply text", ...verified })];
    expect(buildNewsCards(entries, { now: NOW, query: "alpha" })).toHaveLength(1);
    expect(buildNewsCards(entries, { now: NOW, query: "beta" })).toHaveLength(1);
    expect(buildNewsCards(entries, { now: NOW, query: "gamma" })).toHaveLength(0);
  });

  it("preserves editorial featured/importance across the thread and never lets a revision reset them", () => {
    const entries = [post({ id: 1, featured: true, importance: 80 }), post({ id: 2, sourcePostNumber: 9, publishedAt: "2026-11-03T00:00:00.000Z", ...verified })];
    const [card] = buildNewsCards(entries, { now: NOW, featuredFirst: true });
    expect(card).toMatchObject({ featured: true, importance: 80 });
  });

  it("hides suppressed, unpublished and future-dated entries", () => {
    const entries = [
      post({ id: 1 }),
      post({ id: 2, sourceTopicId: "topic:2", threadKey: "us:topic:2", suppressedAt: "2026-10-23T09:04:31.000Z" }),
      post({ id: 3, sourceTopicId: "topic:3", threadKey: "us:topic:3", status: "review" }),
      post({ id: 4, sourceTopicId: "topic:4", threadKey: "us:topic:4", sourceType: "official_news", sourcePostNumber: null, publishedAt: "2026-11-09T00:00:00.000Z" }),
      post({ id: 5, sourceTopicId: "topic:5", threadKey: "us:topic:5", authoritative: false }),
    ];
    expect(buildNewsCards(entries, { now: NOW }).map((card) => card.id)).toEqual([1]);
  });

  it("builds a detail view with thread context and bounded updates", () => {
    const entries = [post({ id: 1, slug: "opener" }), post({ id: 2, slug: "reply", sourcePostNumber: 9, publishedAt: "2026-11-03T00:00:00.000Z", ...verified })];
    const detail = threadUpdates(entries, "opener", NOW)!;
    expect(detail.updateCount).toBe(2);
    expect(detail.updates?.map((update) => update.slug)).toEqual(["reply", "opener"]);
    expect(threadUpdates(entries, "missing", NOW)).toBeNull();
    expect(threadUpdates([post({ id: 9, slug: "hidden", sourcePostNumber: 3 })], "hidden", NOW)).toBeNull();
  });

  it("classifies entry kinds", () => {
    expect(entryKindOf({ sourcePostNumber: null, threadOrigin: null })).toBe("article");
    expect(entryKindOf({ sourcePostNumber: 1, threadOrigin: "official" })).toBe("announcement");
    expect(entryKindOf({ sourcePostNumber: 4, threadOrigin: "official" })).toBe("official_update");
    expect(entryKindOf({ sourcePostNumber: 4, threadOrigin: "community" })).toBe("staff_reply");
  });
});

describe("presentation of the separate timestamps", () => {
  it("distinguishes original posting from the latest official update and ignores sub-hour noise", () => {
    expect(newsDates({ publishedAt: "2026-11-03T03:20:33.000Z", officialUpdatedAt: "2026-11-03T03:20:33.000Z", threadPublishedAt: "2026-09-24T22:23:24.000Z" }))
      .toEqual({ original: "2026-09-24T22:23:24.000Z", latest: "2026-11-03T03:20:33.000Z", updated: true });
    expect(newsDates({ publishedAt: "2026-11-03T03:20:33.000Z", officialUpdatedAt: "2026-11-03T03:40:00.000Z", threadPublishedAt: null }).updated).toBe(false);
    expect(newsDates({ publishedAt: "2026-11-03T03:20:33.000Z" }).updated).toBe(false);
  });

  it("labels official updates and staff replies distinctly", () => {
    expect(newsKindLabel({ category: "bluepost", entryKind: "official_update" }, "BLUE POST")).toBe("OFFICIAL UPDATE");
    expect(newsKindLabel({ category: "bluepost", entryKind: "staff_reply" }, "BLUE POST")).toBe("STAFF REPLY");
    expect(newsKindLabel({ category: "bluepost", entryKind: "announcement" }, "BLUE POST")).toBe("BLUE POST");
  });
});

describe("homepage selection with thread cards", () => {
  it("surfaces a verified official reply card but still hides an unverified reply", () => {
    const entries = buildNewsCards([post({ id: 1 }), post({ id: 2, sourcePostNumber: 9, publishedAt: "2026-11-03T00:00:00.000Z", ...verified })], { now: NOW });
    expect(selectHomepageNews(entries, 3).featured?.sourcePostNumber).toBe(9);
    const hidden = selectHomepageNews([post({ id: 7, sourcePostNumber: 3, entryKind: "staff_reply", threadOrigin: null })], 3);
    expect(hidden.featured).toBeNull();
  });
});
