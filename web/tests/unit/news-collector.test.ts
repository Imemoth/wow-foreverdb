import { describe, expect, it } from "vitest";
import {
  classifyRelevance,
  parseBluepostFeed,
  parseOfficialNewsFragment,
  collectNews,
  type BluepostSource,
  type OfficialNewsSource,
} from "../../../supabase/functions/azerdex-news-collector/collector";

const us: BluepostSource = {
  sourceType: "bluepost",
  sourceKey: "blizzard-bluepost-us",
  region: "us",
  baseUrl: "https://us.forums.blizzard.com/en/wow",
};

const official: OfficialNewsSource = {
  sourceType: "official_news",
  sourceKey: "blizzard-news-us",
  region: "us",
  baseUrl: "https://worldofwarcraft.blizzard.com/en-us",
};

describe("Blizzard news source parsing", () => {
  it("normalizes official Blue Tracker posts and preserves stable topic/post identity", () => {
    const entries = parseBluepostFeed(JSON.stringify({
      posts: [{
        id: 30563471,
        topic_id: 2388547,
        topic_title: "Testing WoW Forever Today - October 21",
        topic_slug: "testing-wow-forever-today-october-21",
        url: "/t/testing-wow-forever-today-october-21/2388547/1",
        category_id: 349,
        post_number: 1,
        posts_count: 83,
        user_id: 3390,
        username: "Kaivax",
        name: "Kaivax",
        created_at: "2026-10-21T16:28:54.4Z",
        updated_at: null,
        excerpt: "The WoW Forever Beta is going offline in a few minutes.",
      }],
    }), us);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sourceEntryId: "post:30563471",
      sourceTopicId: "topic:2388547",
      threadKey: "us:topic:2388547",
      title: "Testing WoW Forever Today - October 21",
      author: "Kaivax",
      region: "us",
      category: "bluepost",
      relevance: "relevant",
      status: "published",
      canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/testing-wow-forever-today-october-21/2388547/1",
      publishedAt: "2026-10-21T16:28:54.400Z",
    });
  });

  it("keeps Bluepost replies distinct while retaining their shared thread key", () => {
    const entries = parseBluepostFeed(JSON.stringify({ posts: [
      { id: 2, topic_id: 7, topic_title: "Forever beta", topic_slug: "forever-beta", url: "/t/forever-beta/7/2", post_number: 2, username: "Kaivax", created_at: "2026-10-22T01:00:00Z", excerpt: "A reply." },
      { id: 1, topic_id: 7, topic_title: "Forever beta", topic_slug: "forever-beta", url: "/t/forever-beta/7/1", post_number: 1, username: "Kaivax", created_at: "2026-10-22T00:00:00Z", excerpt: "The announcement." },
    ] }), us);

    expect(entries.map((entry) => entry.sourceEntryId)).toEqual(["post:2", "post:1"]);
    expect(new Set(entries.map((entry) => entry.threadKey))).toEqual(new Set(["us:topic:7"]));
  });

  it("accepts a topic JSON revision response and preserves the modified timestamp", () => {
    const entries = parseBluepostFeed(JSON.stringify({
      id: 7,
      slug: "forever-beta",
      title: "World of Warcraft: Forever Beta",
      post_stream: { posts: [{ id: 2, post_number: 2, username: "Kaivax", created_at: "2026-10-22T01:00:00Z", updated_at: "2026-10-22T02:00:00Z", raw: "The Forever beta update." }] },
    }), us);

    expect(entries[0]).toMatchObject({ sourceEntryId: "post:2", modifiedAt: "2026-10-22T02:00:00.000Z", status: "published" });
  });

  it("classifies unrelated Blizzard posts as rejected and skips invalid timestamps", () => {
    const entries = parseBluepostFeed(JSON.stringify({ posts: [
      { id: 10, topic_id: 8, topic_title: "Midnight Hotfixes", url: "/t/midnight-hotfixes/8/1", username: "Linxy", created_at: "2026-10-22T01:00:00Z", excerpt: "Retail changes." },
      { id: 11, topic_id: 9, topic_title: "Forever beta", url: "/t/forever-beta/9/1", username: "Kaivax", created_at: "not-a-date", excerpt: "Bad timestamp." },
    ] }), us);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("rejected");
  });

  it("parses Blizzard's first-party paginated news fragment and preserves article IDs", () => {
    const fragment = `<div class="Paginator" data-url="/news/river.frag" data-page="2" data-total="209"><article class="NewsBlog"><div class="NewsBlog-title">Gather Around the Campfire in World of Warcraft: Forever</div><p class="NewsBlog-desc color-beige-medium">The Camping system in World of Warcraft: Forever lets players create shared campsites.</p><div class="NewsBlog-date" data-props="{&quot;iso8601&quot;:&quot;2026-10-21T17:00:00.000Z&quot;,&quot;relative&quot;:true}">yesterday</div><a class="Link NewsBlog-link" href="/news/24301516/gather-around-the-campfire-in-world-of-warcraft-forever"></a></article></div>`;
    const entries = parseOfficialNewsFragment(fragment, official);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sourceEntryId: "article:24301516",
      title: "Gather Around the Campfire in World of Warcraft: Forever",
      category: "official_news",
      canonicalUrl: "https://worldofwarcraft.blizzard.com/en-us/news/24301516/gather-around-the-campfire-in-world-of-warcraft-forever",
      publishedAt: "2026-10-21T17:00:00.000Z",
      status: "published",
    });
  });

  it("classifies patch-like headlines only when the source content is Forever-related", () => {
    expect(classifyRelevance("12.1.5 Content Update Notes", "World of Warcraft: Forever", "official_news")).toBe("relevant");
    expect(classifyRelevance("Hotfixes: October 21, 2026", "Midnight and Classic changes", "official_news")).toBe("irrelevant");
    expect(classifyRelevance("Forever beta", "A beta mention without a game marker.", "bluepost")).toBe("ambiguous");
  });

  it("follows declared pagination, hashes accepted payloads, and isolates an EU outage", async () => {
    const requests: string[] = [];
    const applied: unknown[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("eu.forums")) throw new Error("EU unavailable");
      if (url.includes("page=2")) {
        return new Response(JSON.stringify({ posts: [{ id: 2, topic_id: 2, topic_title: "Forever follow-up", url: "/t/follow-up/2/1", username: "Kaivax", created_at: "2026-10-22T01:00:00Z", excerpt: "World of Warcraft: Forever follow-up", }] }), { status: 200 });
      }
      if (url.includes("forums")) {
        return new Response(JSON.stringify({ meta: { next_page: 2 }, posts: [{ id: 1, topic_id: 1, topic_title: "Forever announcement", url: "/t/announcement/1/1", username: "Kaivax", created_at: "2026-10-22T00:00:00Z", excerpt: "World of Warcraft: Forever announcement", }] }), { status: 200 });
      }
      return new Response(`<article class="NewsBlog"><div class="NewsBlog-title">World of Warcraft: Forever News</div><p class="NewsBlog-desc">A Forever article.</p><div data-props="{&quot;iso8601&quot;:&quot;2026-10-22T02:00:00.000Z&quot;}"></div><a class="Link NewsBlog-link" href="/news/24300001/forever"></a></article>`, { status: 200 });
    };

    const reports = await collectNews({
      fetcher,
      now: () => new Date("2026-10-22T03:00:00.000Z"),
      sources: [us, { ...us, sourceKey: "blizzard-bluepost-eu", region: "eu", baseUrl: "https://eu.forums.blizzard.com/en/wow" }, official],
      apply: async (payload) => { applied.push(payload); return { inserted: 1, updated: 0 }; },
    });

    expect(requests.some((url) => url.includes("page=2"))).toBe(true);
    expect(reports.find((report) => report.sourceKey === "blizzard-bluepost-eu")?.status).toBe("failed");
    expect(reports.find((report) => report.sourceKey === "blizzard-bluepost-us")?.acceptedCount).toBe(2);
    expect((applied[0] as { entries: Array<{ contentHash: string }> }).entries[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refreshes Bluepost topic JSON during revision runs", async () => {
    const requests: string[] = [];
    let appliedEntries: Array<{ modifiedAt: string | null }> = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/t/forever-beta/7.json")) {
        return new Response(JSON.stringify({
          id: 7,
          slug: "forever-beta",
          title: "World of Warcraft: Forever Beta",
          post_stream: { posts: [{ id: 1, post_number: 1, username: "Kaivax", created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T03:00:00Z", raw: "Updated Forever beta details." }] },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ posts: [{ id: 1, topic_id: 7, topic_title: "World of Warcraft: Forever Beta", url: "/t/forever-beta/7/1", username: "Kaivax", created_at: "2026-10-22T00:00:00Z", excerpt: "Initial details." }] }), { status: 200 });
    };

    await collectNews({
      fetcher,
      sources: [us],
      mode: "revision",
      apply: async (payload) => {
        appliedEntries = payload.entries;
        return { inserted: 0, updated: 1 };
      },
    });

    expect(requests).toContain("https://us.forums.blizzard.com/en/wow/t/forever-beta/7.json");
    expect(appliedEntries).toHaveLength(1);
    expect(appliedEntries[0]?.modifiedAt).toBe("2026-10-22T03:00:00.000Z");
  });

  it("records malformed source payloads as failures without disabling the source", async () => {
    let appliedStatus = "";
    let appliedError = "";
    let appliedEnabled = false;
    const report = await collectNews({
      fetcher: async () => new Response("not-json", { status: 200 }),
      sources: [us],
      apply: async (payload) => {
        appliedStatus = payload.run.status;
        appliedError = payload.run.error ?? "";
        appliedEnabled = payload.source.enabled;
        return { inserted: 0, updated: 0 };
      },
    });

    expect(report[0]).toMatchObject({ status: "failed", error: "source_invalid_bluepost_payload" });
    expect(appliedStatus).toBe("failed");
    expect(appliedError).toBe("source_invalid_bluepost_payload");
    expect(appliedEnabled).toBe(true);
  });

  it("audits topic revision failures as partial runs", async () => {
    let runStatus = "";
    let runError = "";
    const report = await collectNews({
      sources: [us],
      mode: "revision",
      fetcher: async (input) => {
        if (String(input).includes("/t/") && String(input).endsWith(".json")) throw new Error("revision_timeout");
        return new Response(JSON.stringify({ posts: [{ id: 1, topic_id: 7, topic_title: "World of Warcraft: Forever Beta", url: "/t/forever-beta/7/1", username: "Kaivax", created_at: "2026-10-22T00:00:00Z", excerpt: "World of Warcraft: Forever details." }] }), { status: 200 });
      },
      apply: async (payload) => {
        runStatus = payload.run.status;
        runError = payload.run.error ?? "";
        return { inserted: 1, updated: 0 };
      },
    });

    expect(report[0]).toMatchObject({ status: "partial", error: "revision_topic_failures:1" });
    expect(runStatus).toBe("partial");
    expect(runError).toBe("revision_topic_failures:1");
  });
});
