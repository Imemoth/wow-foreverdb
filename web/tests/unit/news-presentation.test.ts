import { describe, expect, it } from "vitest";
import { getNewsVisualVariant, cleanNewsExcerpt, filterNewsByRegion } from "@/lib/news/presentation";
import type { NewsEntry } from "@/lib/data/types";

const entry = (region: NewsEntry["region"]): NewsEntry => ({
  id: 1,
  slug: "entry",
  sourceType: "bluepost",
  sourceKey: "blizzard-bluepost-us",
  sourceEntryId: "post:1",
  sourceTopicId: "topic:1",
  threadKey: "us:topic:1",
  canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/entry/1/1",
  title: "Forever announcement",
  author: "Kaivax",
  region,
  publishedAt: "2026-10-22T00:00:00.000Z",
  modifiedAt: null,
  ingestedAt: "2026-10-22T00:01:00.000Z",
  excerpt: "A short excerpt.",
  category: "bluepost",
  importance: 20,
  featured: false,
});

describe("news presentation", () => {
  it("maps Blueposts, Official News, and AzerDex entries to shared visual variants", () => {
    expect(getNewsVisualVariant({ category: "bluepost", sourceType: "bluepost" })).toBe("bluepost");
    expect(getNewsVisualVariant({ category: "official_news", sourceType: "official_news" })).toBe("official");
    expect(getNewsVisualVariant({ category: "azerdex", sourceType: "azerdex" })).toBe("editorial");
  });

  it("normalizes encoded ellipses before truncating an excerpt", () => {
    expect(cleanNewsExcerpt("Read the latest update [important&hellip;] with context", 28)).toBe("Read the latest update […]");
    expect(cleanNewsExcerpt("A short excerpt.", 80)).toBe("A short excerpt.");
    expect(cleanNewsExcerpt("1234567890 extra", 10).length).toBeLessThanOrEqual(10);
  });

  it("filters Bluepost rows by the selected region while keeping the all view intact", () => {
    const rows = [entry("us"), { ...entry("eu"), id: 2, slug: "eu-entry" }, { ...entry("global"), id: 3, slug: "global-entry" }];
    expect(filterNewsByRegion(rows, "us").map((row) => row.region)).toEqual(["us"]);
    expect(filterNewsByRegion(rows, "all")).toHaveLength(3);
  });
});
