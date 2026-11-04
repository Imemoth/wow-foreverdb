import { afterEach, describe, expect, it, vi } from "vitest";
import type { NewsEntrySource } from "@/lib/news/cards";
import { isGlobalStory, newsRegionLabel } from "@/lib/news/presentation";
import { buildStoryCards, matchStories, normalizeStoryText, storyDetail } from "@/lib/news/stories";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const LONG = "Official Blizzard announcement text for World of Warcraft Forever that is long enough to count as evidence. ";
let seq = 0;
const opener = (region: "us" | "eu", topic: number, title: string, publishedAt: string, o: Partial<NewsEntrySource> = {}): NewsEntrySource => {
  seq += 1;
  return {
    id: seq, slug: `${region}-${topic}-1`, sourceType: "bluepost", sourceKey: `blizzard-bluepost-${region}`, sourceEntryId: `post:${topic}0`,
    sourceTopicId: `topic:${topic}`, sourcePostNumber: 1, threadKey: `${region}:topic:${topic}`,
    canonicalUrl: `https://${region}.forums.blizzard.com/en/wow/t/x/${topic}/1`, title, author: "Blizzard Entertainment", region,
    publishedAt, modifiedAt: null, ingestedAt: publishedAt, excerpt: LONG + title, category: "bluepost", importance: 0, featured: false,
    authorUserId: 520262, authorGroup: "api_users", threadOrigin: "official", ...o,
  };
};
const reply = (region: "us" | "eu", topic: number, post: number, publishedAt: string, excerpt: string, verified = true, o: Partial<NewsEntrySource> = {}): NewsEntrySource => {
  seq += 1;
  return {
    id: seq, slug: `${region}-${topic}-${post}`, sourceType: "bluepost", sourceKey: `blizzard-bluepost-${region}`, sourceEntryId: `post:${topic}${post}`,
    sourceTopicId: `topic:${topic}`, sourcePostNumber: post, threadKey: `${region}:topic:${topic}`,
    canonicalUrl: `https://${region}.forums.blizzard.com/en/wow/t/x/${topic}/${post}`, title: "Update", author: "Kaivax", region, publishedAt,
    officialUpdatedAt: publishedAt, modifiedAt: null, ingestedAt: publishedAt, excerpt, category: "bluepost", importance: 0, featured: false,
    ...(verified ? { authorUserId: 3390, authorGroup: "community-manager", threadOrigin: "official" as const } : {}), ...o,
  };
};
const links = (entries: NewsEntrySource[], overrides = []) => matchStories(entries, overrides, NOW).links;

describe("matching rule exact_content_v1", () => {
  it("normalises case, punctuation, curly quotes and entities", () => {
    expect(normalizeStoryText("Watch the WoW: Forever Short Story, “Unbowed” &amp; more")).toBe("watch the wow forever short story unbowed more");
    expect(normalizeStoryText("Player’s Guide — Welcome")).toBe(normalizeStoryText("player's guide - welcome"));
  });

  it("1. identical verified EU/US announcement -> one story (earliest thread is canonical)", () => {
    const e = [opener("us", 2400119, "Explore WoW: Forever with a Gamepad", "2026-11-03T20:00:09.000Z"), opener("eu", 639280, "Explore WoW: Forever with a Gamepad", "2026-11-03T20:00:07.000Z")];
    const plan = matchStories(e, [], NOW);
    expect(plan.stories).toEqual([{ storyKey: "story:eu:topic:639280", members: expect.arrayContaining(["us:topic:2400119", "eu:topic:639280"]) }]);
    expect(plan.review).toEqual([]);
  });

  it("2./3. a US-only and an EU-only announcement are never linked", () => {
    const e = [opener("us", 1, "US Only Maintenance Notice", "2026-11-03T20:00:00.000Z"), opener("eu", 2, "EU Only Server Merge", "2026-11-03T20:00:00.000Z")];
    expect(links(e).size).toBe(0);
  });

  it("4. similar titles with different meaning stay separate (different title, or same title with different content/author)", () => {
    const e = [
      opener("us", 1, "The WoW Forever Podcast: Episode 5", "2026-11-03T20:00:00.000Z"), opener("eu", 2, "The WoW Forever Podcast: Episode 6", "2026-11-03T20:00:00.000Z"),
      opener("us", 3, "Hotfixes", "2026-11-03T21:00:00.000Z", { excerpt: LONG + "quest fix" }), opener("eu", 4, "Hotfixes", "2026-11-03T21:00:00.000Z", { excerpt: LONG + "auction house crash" }),
      opener("us", 5, "Maintenance", "2026-11-03T22:00:00.000Z"), opener("eu", 6, "Maintenance", "2026-11-03T22:00:00.000Z", { author: "Someone Else" }),
    ];
    const plan = matchStories(e, [], NOW);
    expect(plan.links.size).toBe(0);
    expect(plan.review.map((r) => r.title).sort()).toEqual(["Hotfixes", "Maintenance"]);
    expect(plan.review.find((r) => r.title === "Hotfixes")!.reasons).toEqual(["content_differs_or_excerpt_too_short"]);
    expect(plan.review.find((r) => r.title === "Maintenance")!.reasons).toEqual(["author_differs"]);
  });

  it("5. same-title topics inside one region: weekly repeats never merge; an identical same-minute cross-post is one story", () => {
    const e = [
      opener("us", 1, "Weekly Reset Reminder", "2026-10-20T17:00:00.000Z"), opener("us", 2, "Weekly Reset Reminder", "2026-10-27T17:00:00.000Z"),
      opener("us", 3, "Cross Posted in Two Categories", "2026-11-03T17:00:00.000Z"), opener("us", 4, "Cross Posted in Two Categories", "2026-11-03T17:00:31.000Z"),
    ];
    const plan = matchStories(e, [], NOW);
    expect([...plan.links.keys()].sort()).toEqual(["us:topic:3", "us:topic:4"]);
    expect(plan.links.has("us:topic:1") || plan.links.has("us:topic:2")).toBe(false);
  });

  it("6. different wording or dates: never merged automatically; the empty-excerpt case is not evidence; only a reviewed override merges", () => {
    const e = [
      opener("us", 1, "Beta Celebration", "2026-11-03T17:00:00.000Z", { excerpt: LONG + "10/22 at 5pm Eastern" }), opener("eu", 2, "Beta Celebration", "2026-11-03T17:00:00.000Z", { excerpt: LONG + "22/10 at 22:00 BST" }),
      opener("us", 3, "Podcast Episode 6", "2026-11-03T18:00:00.000Z", { excerpt: "" }), opener("eu", 4, "Podcast Episode 6", "2026-11-03T18:00:30.000Z", { excerpt: "" }),
      opener("us", 5, "Dev Notes - Updated November 2", "2026-09-24T22:23:00.000Z"), opener("eu", 6, "Dev Notes - Updated 3 November", "2026-09-24T22:37:00.000Z"),
    ];
    expect(links(e).size).toBe(0);
    const allowed = matchStories(e, [{ threadA: "eu:topic:6", threadB: "us:topic:5", decision: "allow" }], NOW);
    expect(allowed.stories).toHaveLength(1);
    expect(allowed.stories[0]!.members.sort()).toEqual(["eu:topic:6", "us:topic:5"]);
    const denied = matchStories([opener("us", 7, "Same", "2026-11-03T17:00:00.000Z"), opener("eu", 8, "Same", "2026-11-03T17:00:00.000Z")], [{ threadA: "eu:topic:8", threadB: "us:topic:7", decision: "deny" }], NOW);
    expect(denied.links.size).toBe(0);
    expect(denied.review[0]!.reasons).toContain("denied_by_override");
  });

  it("a chain A~B~C where A and C are > 15 minutes apart is ambiguous and not linked", () => {
    const e = [opener("us", 1, "Chain", "2026-11-03T17:00:00.000Z"), opener("eu", 2, "Chain", "2026-11-03T17:10:00.000Z"), opener("us", 3, "Chain", "2026-11-03T17:20:00.000Z")];
    const plan = matchStories(e, [], NOW);
    expect(plan.links.size).toBe(0);
    expect(plan.ambiguous).toHaveLength(1);
  });

  it("Official News articles and unverified/suppressed rows are never matched", () => {
    const article: NewsEntrySource = { ...opener("us", 9, "Same", "2026-11-03T17:00:00.000Z"), sourceType: "official_news", sourcePostNumber: null, threadKey: null, category: "official_news" };
    const suppressed = { ...opener("eu", 10, "Same", "2026-11-03T17:00:00.000Z"), suppressedAt: "2026-10-22T12:00:00.000Z" };
    expect(links([article, opener("us", 11, "Same", "2026-11-03T17:00:00.000Z"), suppressed]).size).toBe(0);
  });
});

describe("story cards, filters, totals and pagination", () => {
  const base = () => [
    opener("us", 1001, "Explore WoW: Forever with a Gamepad", "2026-11-03T20:00:09.000Z"), opener("eu", 2001, "Explore WoW: Forever with a Gamepad", "2026-11-03T20:00:07.000Z"),
    opener("us", 1002, "US Only Notice", "2026-11-02T10:00:00.000Z"), opener("eu", 2003, "EU Only Notice", "2026-11-01T10:00:00.000Z"),
  ];

  it("global view: ONE card for the shared story listing both regions; US/EU views use each region's own member", () => {
    const e = base(); const l = links(e);
    const all = buildStoryCards(e, l, { now: NOW });
    expect(all).toHaveLength(3);
    const story = all.find((c) => c.storyKey === "story:eu:topic:2001")!;
    expect(story).toMatchObject({ regions: ["eu", "us"], memberCount: 2, canonicalSlug: "eu-2001-1" });
    expect(newsRegionLabel(story)).toBe("Regions: EU · US");
    expect(isGlobalStory(story)).toBe(true);
    expect(buildStoryCards(e, l, { now: NOW, region: "us" }).map((c) => c.slug)).toEqual(["us-1001-1", "us-1002-1"]);
    expect(buildStoryCards(e, l, { now: NOW, region: "eu" }).map((c) => c.slug)).toEqual(["eu-2001-1", "eu-2003-1"]);
    const single = buildStoryCards(e, l, { now: NOW }).find((c) => c.slug === "us-1002-1")!;
    expect(newsRegionLabel(single)).toBe("US only");
    expect(newsRegionLabel(buildStoryCards(e, l, { now: NOW }).find((c) => c.slug === "eu-2003-1")!)).toBe("EU only");
  });

  it("7. a new verified update in only one region moves that region's card; the other region is unchanged", () => {
    const e = [...base(), reply("us", 1001, 2, "2026-11-04T10:00:00.000Z", "US-only addendum with the zebrafish setting renamed in the US client of Forever.")];
    const l = links(e);
    const all = buildStoryCards(e, l, { now: NOW });
    expect(all[0]).toMatchObject({ slug: "us-1001-2", updateCount: 2, regions: ["eu", "us"] });
    expect(buildStoryCards(e, l, { now: NOW, region: "eu" }).find((c) => c.storyKey)).toMatchObject({ slug: "eu-2001-1", updateCount: 1 });
  });

  it("8. unverified and suppressed replies stay invisible, also in the story detail", () => {
    const e = [...base(), reply("us", 1001, 3, "2026-11-04T10:00:00.000Z", "no provenance zebrafish", false), reply("eu", 2001, 9, "2026-11-04T10:00:00.000Z", "suppressed zebrafish", true, { suppressedAt: "2026-10-22T12:00:00.000Z" })];
    const l = links(e);
    expect(buildStoryCards(e, l, { now: NOW, query: "zebrafish" })).toHaveLength(0);
    const detail = storyDetail(e, l, "us-1001-1", NOW)!;
    expect(JSON.stringify(detail)).not.toMatch(/zebrafish/);
    expect(storyDetail(e, l, "us-1001-3", NOW)).toBeNull();
  });

  it("9. totals and pagination: filters run before counting; pages partition the list", () => {
    const e = [...base(), ...Array.from({ length: 20 }, (_, i) => opener(i % 2 ? "us" : "eu", 3000 + i, `Distinct announcement number ${i}`, `2026-10-${String(1 + (i % 25)).padStart(2, "0")}T10:00:00.000Z`))];
    const l = links(e);
    for (const region of [undefined, "us", "eu"] as const) {
      const cards = buildStoryCards(e, l, { now: NOW, region });
      const keys = cards.map((c) => c.storyKey ?? c.slug);
      expect(new Set(keys).size).toBe(cards.length);
    }
    expect(buildStoryCards(e, l, { now: NOW })).toHaveLength(e.length - 1); // the one merged pair
    expect(buildStoryCards(e, l, { now: NOW, region: "us" }).length).toBe(e.filter((x) => x.region === "us").length);
    const pages = [0, 1, 2].flatMap((p) => buildStoryCards(e, l, { now: NOW }).slice(p * 8, p * 8 + 8)).map((c) => c.id);
    expect(new Set(pages).size).toBe(pages.length);
  });

  it("10. search matches verified content from either regional source (and respects the region filter)", () => {
    const e = [...base(), reply("us", 1001, 2, "2026-11-04T10:00:00.000Z", "US-only addendum with the zebrafish setting renamed in the US client of Forever."), reply("eu", 2001, 2, "2026-11-04T09:00:00.000Z", "EU-only addendum about the pufferfish toggle in the EU client of Forever.")];
    const l = links(e);
    expect(buildStoryCards(e, l, { now: NOW, query: "zebrafish" })).toHaveLength(1);
    expect(buildStoryCards(e, l, { now: NOW, query: "pufferfish" })).toHaveLength(1);
    expect(buildStoryCards(e, l, { now: NOW, query: "pufferfish", region: "us" })).toHaveLength(0);
    expect(buildStoryCards(e, l, { now: NOW, query: "zebrafish", region: "eu" })).toHaveLength(0);
  });

  it("12./13. old entry URLs resolve with the whole story; sources, provenance and original publication times are untouched", () => {
    const e = [...base(), reply("us", 1001, 2, "2026-11-04T10:00:00.000Z", "US-only addendum with the zebrafish setting renamed in the US client.")];
    const frozen = JSON.stringify(e);
    const l = links(e);
    for (const slug of ["us-1001-1", "eu-2001-1", "us-1001-2"]) {
      const d = storyDetail(e, l, slug, NOW)!;
      expect(d.slug).toBe(slug);
      expect(d.story).toMatchObject({ storyKey: "story:eu:topic:2001", canonicalSlug: "eu-2001-1", regions: ["eu", "us"] });
      expect(d.story!.members.map((m) => m.sourceUrl).sort()).toEqual(["https://eu.forums.blizzard.com/en/wow/t/x/2001/1", "https://us.forums.blizzard.com/en/wow/t/x/1001/1"]);
      expect(d.story!.members.find((m) => m.region === "us")!.updates).toHaveLength(2);
      expect(d.story!.members.find((m) => m.region === "eu")!.updates).toHaveLength(1);
    }
    expect(storyDetail(e, l, "us-1002-1", NOW)!.story).toBeNull();
    expect(JSON.stringify(e)).toBe(frozen); // the builders never mutate source rows (hash, provenance, timestamps)
    expect(buildStoryCards(e, l, { now: NOW }).flatMap((c) => c.storyKey ? [c.publishedAt] : []).length).toBe(1);
    expect(e[0]!.publishedAt).toBe("2026-11-03T20:00:09.000Z");
  });
});

describe("production-shaped inventory (2026-11-04: 55 Blue Post threads)", () => {
  // The REAL confirmed groups found in production by the same rule: [title, US topics, EU topics].
  const CONFIRMED: Array<[string, number[], number[]]> = [
    ["Datamined in the Latest Beta Build", [2385060], [636148]], ["Explore the New Dungeons of World of Warcraft: Forever", [2387658], [636727]],
    ["World of Warcraft: Forever Raid Overview—Locations, Raid Bosses", [2387820, 2387821], [636735]], ["Gather Around the Campfire in World of Warcraft: Forever", [2388645], [636870]],
    ["The Roleplay-PvP Ruleset is Coming to WoW Forever", [2389502], [637031]], ["Thank You For Testing the WoW Forever Beta", [2390465, 2390466], [637227, 637228]],
    ["Dive Into WoW: Forever, the Gods of Zul’Aman, Hallow’s End", [2390480, 2390481], [637232]], ["Watch the WoW: Forever Short Story, “Unbowed”", [2392363], [637597]],
    ["Your Next Adventure in WoW: Forever Starts in the WoW Podcast", [2393349], [637932]], ["New Player’s Starter Guide: Welcome to World of Warcraft", [2394974], [638305]],
    ["Return to Azeroth in World of Warcraft: Forever", [2395922], [638484]], ["WoW: Forever—What’s New and What Feels Familiar", [2400000], [639257]],
    ["Explore WoW: Forever with a Gamepad", [2400119], [639280]],
  ];
  // Real near-misses that must stay separate: two empty-excerpt Podcast pairs and a different-wording pair.
  const REVIEW: Array<[string, number, number, string]> = [
    ["The WoW: Forever Podcast: Episode 5 - End of Beta Special", 2389565, 637043, ""], ["The WoW: Forever Podcast: Episode 6 - All About Tech", 2395799, 638462, ""],
    ["The WoW Forever Beta Celebration is Underway", 2389633, 637055, "differs"],
  ];
  const build = () => {
    const rows: NewsEntrySource[] = [];
    let minute = 0;
    const at = () => `2026-10-${String(10 + Math.floor(minute / 600)).padStart(2, "0")}T${String(Math.floor((minute % 600) / 60) + 8).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
    for (const [title, us, eu] of CONFIRMED) {
      minute += 70;
      us.forEach((t, i) => rows.push(opener("us", t, title, new Date(Date.parse(at()) + i * 31_000).toISOString())));
      eu.forEach((t, i) => rows.push(opener("eu", t, title, new Date(Date.parse(at()) + 3_000 + i * 57_000).toISOString())));
    }
    for (const [title, us, eu, kind] of REVIEW) {
      minute += 70;
      rows.push(opener("us", us, title, at(), { excerpt: kind === "" ? "" : LONG + "10/22 5pm Eastern" }), opener("eu", eu, title, at(), { excerpt: kind === "" ? "" : LONG + "22/10 22:00 BST" }));
    }
    for (let i = 0; i < 10; i += 1) { minute += 70; rows.push(opener("us", 2380000 + i, `US single announcement ${i}`, at())); }
    for (let i = 0; i < 9; i += 1) { minute += 70; rows.push(opener("eu", 630000 + i, `EU single announcement ${i}`, at())); }
    return rows;
  };

  it("has the real shape: 55 threads (29 US / 26 EU)", () => {
    const rows = build();
    expect(rows).toHaveLength(55);
    expect(rows.filter((r) => r.region === "us")).toHaveLength(29);
    expect(rows.filter((r) => r.region === "eu")).toHaveLength(26);
  });

  it("merges exactly 13 stories (30 threads); 3 near-misses stay separate for review; cards 55 -> 38", () => {
    const rows = build();
    const plan = matchStories(rows, [], NOW);
    expect(plan.stories).toHaveLength(13);
    expect(plan.links.size).toBe(30);
    expect(plan.stories.map((s) => s.members.length).sort((a, b) => a - b)).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 4]);
    expect(plan.review).toHaveLength(3);
    expect(plan.ambiguous).toEqual([]);
    expect(buildNewsCardsCount(rows, plan.links)).toEqual({ before: 55, all: 38, us: 26, eu: 25 });
    const story = plan.stories.find((s) => s.members.includes("us:topic:2390465"))!;
    expect(story.members.sort()).toEqual(["eu:topic:637227", "eu:topic:637228", "us:topic:2390465", "us:topic:2390466"]);
  });
  function buildNewsCardsCount(rows: NewsEntrySource[], l: ReadonlyMap<string, string>) {
    return {
      before: buildStoryCards(rows, new Map(), { now: NOW }).length,
      all: buildStoryCards(rows, l, { now: NOW }).length,
      us: buildStoryCards(rows, l, { now: NOW, region: "us" }).length,
      eu: buildStoryCards(rows, l, { now: NOW, region: "eu" }).length,
    };
  }
});

describe("RSS: one item per story, stable GUIDs", () => {
  afterEach(() => { vi.doUnmock("@/lib/data"); vi.doUnmock("@/lib/content/loader"); vi.doUnmock("@/lib/env"); vi.resetModules(); });
  async function rss(rows: ReturnType<typeof buildStoryCards>) {
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({ serverEnv: () => ({ SITE_URL: "https://foreverdb.example" }) }));
    vi.doMock("@/lib/data", () => ({ data: () => ({ newsList: async () => ({ rows, total: rows.length }) }) }));
    vi.doMock("@/lib/content/loader", () => ({ visibleArticles: () => [], articlePath: () => "/x" }));
    const mod = await import("@/app/news/rss.xml/route");
    return (await mod.GET()).text();
  }
  const items = (xml: string) => [...xml.matchAll(/<item>[\s\S]*?<guid isPermaLink="true">([^<]+)<\/guid>[\s\S]*?<\/item>/g)].map((m) => m[1]!);

  it("11. a story linked across regions is ONE item; its GUID is an existing permalink, so linking creates no new notification", async () => {
    const e = base2();
    const before = buildStoryCards(e, new Map(), { now: NOW });
    const after = buildStoryCards(e, links(e), { now: NOW });
    const guidsBefore = items(await rss(before)); const guidsAfter = items(await rss(after));
    expect(guidsBefore).toHaveLength(2);
    expect(guidsAfter).toHaveLength(1);
    expect(guidsBefore).toContain(guidsAfter[0]); // no new GUID appears when two existing threads are merged
    expect(guidsAfter[0]).toMatch(/\/news\/entry\/(us|eu)-\d+-1$/);
    const xml = await rss(after);
    expect(xml).toContain("<category>eu</category><category>us</category>");
  });

  it("a genuinely new verified official post in either region has a new permalink (a new item), the story stays ONE item", async () => {
    const e = [...base2(), reply("us", 1001, 2, "2026-11-04T10:00:00.000Z", "US-only addendum about the zebrafish setting renamed in the US client of Forever.")];
    const guids = items(await rss(buildStoryCards(e, links(e), { now: NOW })));
    expect(guids).toHaveLength(1);
    expect(guids[0]).toMatch(/\/news\/entry\/us-1001-2$/);
  });
  function base2() { return [opener("us", 1001, "Explore WoW: Forever with a Gamepad", "2026-11-03T20:00:09.000Z"), opener("eu", 2001, "Explore WoW: Forever with a Gamepad", "2026-11-03T20:00:07.000Z")]; }
});

describe("sitemap: one canonical URL per story", () => {
  afterEach(() => { vi.doUnmock("@/lib/data"); vi.resetModules(); });
  it("lists the canonical entry once, never the regional duplicate", async () => {
    const SITE = "https://foreverdb.example";
    const production = {
      VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "foreverdb.example", FOREVERDB_DEPLOYMENT: "production",
      FOREVERDB_DATA_SOURCE: "postgres", SITE_URL: SITE,
      AZERDEX_READ_DB_URL: "postgresql://foreverdb_web_reader.abcdefghijklmnop:pw@aws-0-eu.pooler.example.com:6543/postgres",
      RATE_LIMIT_BACKEND: "upstash", UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t".repeat(30),
      RATE_LIMIT_SALT: "s".repeat(40), TRUSTED_IP_HEADER: "x-real-ip",
    };
    vi.resetModules();
    for (const k of Object.keys(process.env)) if (/^(FOREVERDB_|VERCEL|SITE_URL|RATE_LIMIT|UPSTASH|AZERDEX_READ|TRUSTED_IP)/.test(k)) delete process.env[k];
    Object.assign(process.env, production);
    const e = [opener("us", 1001, "Explore WoW: Forever with a Gamepad", "2026-11-03T20:00:09.000Z"), opener("eu", 2001, "Explore WoW: Forever with a Gamepad", "2026-11-03T20:00:07.000Z"), opener("us", 1002, "US Only Notice", "2026-11-02T10:00:00.000Z")];
    const rows = buildStoryCards(e, links(e), { now: NOW });
    vi.doMock("@/lib/data", () => ({ data: () => ({ sitemap: async () => [], newsList: async () => ({ rows, total: rows.length }) }) }));
    const urls = (await (await import("@/app/sitemap")).default()).map((x) => x.url).filter((u) => u.includes("/news/entry/"));
    expect(urls.sort()).toEqual([`${SITE}/news/entry/eu-2001-1`, `${SITE}/news/entry/us-1002-1`]);
  });
});
