import { describe, expect, it } from "vitest";
import {
  classifyRelevance,
  collectNews,
  evaluatePost,
  parseBluepostFeed,
  parseOfficialNewsFragment,
  parseTrackerPosts,
  type ApplySyncPayload,
  type BluepostSource,
  type CollectorOptions,
  type OfficialNewsSource,
  type RevisionContext,
} from "../../../supabase/functions/azerdex-news-collector/collector";

const us: BluepostSource = { sourceType: "bluepost", sourceKey: "blizzard-bluepost-us", region: "us", baseUrl: "https://us.forums.blizzard.com/en/wow" };
const eu: BluepostSource = { sourceType: "bluepost", sourceKey: "blizzard-bluepost-eu", region: "eu", baseUrl: "https://eu.forums.blizzard.com/en/wow" };
const official: OfficialNewsSource = { sourceType: "official_news", sourceKey: "blizzard-news-us", region: "us", baseUrl: "https://worldofwarcraft.blizzard.com/en-us" };

const NOW = new Date("2026-11-03T12:00:00.000Z");
const TOPIC_TITLE = "WoW Forever Beta Development Notes – Updated November 2";
const LONG = "Since the last full update to the Beta on October 15, we have continued to work on World of Warcraft: Forever issues.";

interface FeedPostInit {
  id: number; topic: number; post: number; created: string; user?: number; username?: string; name?: string;
  group?: string | null; title?: string; excerpt?: string; postType?: number;
}
const feedPost = (p: FeedPostInit) => ({
  id: p.id, created_at: p.created, topic_id: p.topic, topic_title: p.title ?? TOPIC_TITLE, topic_slug: "dev-notes",
  url: `/t/dev-notes/${p.topic}/${p.post}`, post_number: p.post, user_id: p.user ?? 3390, username: p.username ?? "Kaivax",
  name: p.name ?? "Kaivax", primary_group_name: p.group === undefined ? "community-manager" : p.group,
  post_type: p.postType ?? 1, excerpt: p.excerpt ?? LONG,
});
const feed = (...posts: FeedPostInit[]) => JSON.stringify({ posts: posts.map(feedPost) });

interface TopicPostInit extends FeedPostInit { updated?: string; version?: number; staff?: boolean; hidden?: boolean }
const topicDoc = (id: number, title: string, posts: TopicPostInit[]) => JSON.stringify({
  id, title, slug: "dev-notes", created_at: "2026-09-24T22:23:24.328Z",
  post_stream: { posts: posts.map((p) => ({
    id: p.id, post_number: p.post, created_at: p.created, updated_at: p.updated ?? p.created, version: p.version ?? 1,
    user_id: p.user ?? 3390, username: p.username ?? "Kaivax", name: p.name ?? "Kaivax",
    primary_group_name: p.group === undefined ? "community-manager" : p.group, staff: p.staff ?? true,
    post_type: p.postType ?? 1, hidden: p.hidden ?? false, cooked: `<p>${p.excerpt ?? LONG}</p>`,
  })) },
});

type Route = (url: string) => Response | Promise<Response> | undefined;
/**
 * `manualPaging` lets a test script the `before=` cursor itself. By default an older-page request answers with an empty
 * page (the true end of history), exactly like Blizzard does when no older posts exist.
 */
function harness(routes: Route[], extra: Partial<CollectorOptions> = {}, manualPaging = false) {
  const requests: string[] = [];
  const sleeps: number[] = [];
  const payloads: ApplySyncPayload[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (!manualPaging && isFeed(url) && url.includes("before=")) return new Response(JSON.stringify({ posts: [] }), { status: 200 });
    for (const route of routes) {
      const response = route(url);
      if (response) return response;
    }
    return new Response("not found", { status: 404 });
  };
  const options = (source: BluepostSource | OfficialNewsSource, overrides: Partial<CollectorOptions> = {}): CollectorOptions => ({
    sources: [source], fetcher, now: () => NOW, sleep: async (ms) => { sleeps.push(ms); },
    apply: async (payload) => { payloads.push(payload); return { inserted: payload.entries.length, updated: 0 }; },
    limits: { topicPauseMs: 0 },
    ...extra, ...overrides,
  });
  return { requests, sleeps, payloads, options, fetcher };
}
const json200 = (body: string) => new Response(body, { status: 200 });
const isFeed = (url: string) => url.includes("/groups/blizzard-tracker/posts.json");
const isTopic = (url: string, id: number) => url.endsWith(`/t/${id}.json`);
const ids = (payload: ApplySyncPayload | undefined) => (payload?.entries ?? []).map((entry) => entry.sourceEntryId).sort();

describe("Tracker post parsing and staff identity", () => {
  it("normalises a new official topic opener with stable identity, original timestamp and provenance", () => {
    const entries = parseBluepostFeed(feed({ id: 30563471, topic: 2388547, post: 1, created: "2026-10-21T16:28:54.400Z", title: "Testing WoW Forever Today - October 21" }), us);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sourceEntryId: "post:30563471", sourceTopicId: "topic:2388547", threadKey: "us:topic:2388547", sourcePostNumber: 1,
      region: "us", category: "bluepost", relevance: "relevant", status: "published", publishedAt: "2026-10-21T16:28:54.400Z",
      canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/dev-notes/2388547/1",
      authorUserId: 3390, authorGroup: "community-manager", threadOrigin: "official", observedVia: "feed",
    });
  });

  it("does not infer staff authority from a username or display name", () => {
    // A topic document whose author is called "Kaivax" but whose numeric id was never seen in the Tracker feed.
    const body = topicDoc(7, TOPIC_TITLE, [
      { id: 1, topic: 7, post: 1, created: "2026-10-22T00:00:00Z", user: 3390 },
      { id: 2, topic: 7, post: 2, created: "2026-10-22T01:00:00Z", user: 987654, username: "Kaivax", name: "Kaivax", staff: true },
    ]);
    const posts = parseTrackerPosts(body);
    const decision = evaluatePost(posts[1]!, us, { staff: new Map([[3390, "community-manager"]]), origins: new Map([["7", "official"]]) });
    expect(decision).toEqual({ reject: "unverified_identity" });
  });

  it("fails closed for a verified id with a non-allow-listed group, a false staff flag, or a non-regular post", () => {
    const staff = new Map([[3390, "community-manager"]]);
    const origins = new Map([["7", "official" as const]]);
    const base = { id: 2, topic: 7, post: 2, created: "2026-10-22T01:00:00Z" };
    const decide = (body: string) => evaluatePost(parseTrackerPosts(body)[0]!, us, { staff, origins });
    expect(decide(feed({ ...base, group: "trust_level_4" }))).toEqual({ reject: "group_not_allowlisted" });
    expect(decide(feed({ ...base, group: null }))).toEqual({ reject: "group_not_allowlisted" });
    expect(decide(feed({ ...base, postType: 3 }))).toEqual({ reject: "not_regular_post" });
    expect(decide(topicDoc(7, TOPIC_TITLE, [{ ...base, staff: false }]))).toEqual({ reject: "staff_flag_false" });
    expect(decide(topicDoc(7, TOPIC_TITLE, [{ ...base, hidden: true }]))).toEqual({ reject: "hidden_post" });
  });

  it("rejects posts with missing or invalid source metadata", () => {
    const staff = new Map([[3390, "community-manager"]]);
    const decide = (post: Record<string, unknown>) => {
      const parsed = parseTrackerPosts(JSON.stringify({ posts: [post] }));
      return parsed.length ? evaluatePost(parsed[0]!, us, { staff, origins: new Map() }) : { reject: "dropped" };
    };
    const good = feedPost({ id: 1, topic: 7, post: 1, created: "2026-10-22T00:00:00Z" });
    expect(decide({ ...good, created_at: "not-a-date" })).toEqual({ reject: "invalid_metadata" });
    expect(decide({ ...good, topic_title: "" })).toEqual({ reject: "invalid_metadata" });
    expect(decide({ ...good, url: undefined, topic_slug: undefined })).toEqual({ reject: "invalid_metadata" });
    expect(decide({ ...good, post_number: undefined })).toEqual({ reject: "invalid_metadata" });
    expect(decide({ ...good, user_id: undefined })).toEqual({ reject: "unverified_identity" });
    expect(decide({ ...good, id: "../etc" })).toEqual({ reject: "dropped" });
    expect(decide({ ...good, topic_id: "7; drop" })).toEqual({ reject: "dropped" });
    expect(parseTrackerPosts("not-json")).toEqual([]);
  });

  it("classifies relevance conservatively", () => {
    expect(classifyRelevance("12.1.5 Content Update Notes", "World of Warcraft: Forever", "official_news")).toBe("relevant");
    expect(classifyRelevance("Hotfixes: October 21, 2026", "Midnight and Classic changes", "official_news")).toBe("irrelevant");
    expect(classifyRelevance("Forever beta", "A beta mention without a game marker.", "bluepost")).toBe("ambiguous");
  });
});

describe("official staff replies, thread origin and admission", () => {
  it("accepts a verified staff reply in an official thread (origin proven by the opener in the same feed)", () => {
    const entries = parseBluepostFeed(feed(
      { id: 1009, topic: 77, post: 9, created: "2026-11-03T03:20:33.210Z" },
      { id: 1001, topic: 77, post: 1, created: "2026-09-24T22:23:24.328Z" },
    ), us);
    expect(entries.map((entry) => [entry.sourceEntryId, entry.threadOrigin])).toEqual([["post:1009", "official"], ["post:1001", "official"]]);
    expect(entries.find((entry) => entry.sourcePostNumber === 9)).toMatchObject({
      threadKey: "us:topic:77", canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/dev-notes/77/9", publishedAt: "2026-11-03T03:20:33.210Z",
    });
  });

  it("refuses a staff reply whose thread origin is not verified", () => {
    expect(parseBluepostFeed(feed({ id: 1009, topic: 77, post: 9, created: "2026-11-03T03:20:33Z" }), us)).toEqual([]);
  });

  it("admits a staff reply inside a player-created topic as a staff_reply and never promotes the player opener", () => {
    const entries = parseBluepostFeed(feed(
      { id: 2002, topic: 88, post: 2, created: "2026-11-02T10:00:00Z", title: "Question about the beta", excerpt: "Thanks for the report - this is fixed in the next WoW: Forever beta build." },
      { id: 2001, topic: 88, post: 1, created: "2026-11-02T09:00:00Z", user: 424242, username: "ordinary-player", name: "Kaivax", group: null, title: "Question about the beta", excerpt: "A player topic about WoW Forever." },
    ), us);
    expect(entries.map((entry) => entry.sourceEntryId)).toEqual(["post:2002"]);
    expect(entries[0]).toMatchObject({ threadOrigin: "community", sourcePostNumber: 2, authorUserId: 3390 });
  });

  it("derives relevance for a reply in a player thread from the staff post only (the title is player-controlled)", () => {
    const entries = parseBluepostFeed(feed(
      { id: 2002, topic: 88, post: 2, created: "2026-11-02T10:00:00Z", title: "WoW Forever OFFICIAL ANNOUNCEMENT", excerpt: "Thanks for the report - we have passed it along to the team for review." },
      { id: 2001, topic: 88, post: 1, created: "2026-11-02T09:00:00Z", user: 424242, group: null, title: "WoW Forever OFFICIAL ANNOUNCEMENT" },
    ), us);
    expect(entries).toEqual([]);
  });

  it("rejects conversational, irrelevant and ambiguous staff replies (no feed flooding)", () => {
    const opener = { id: 1, topic: 5, post: 1, created: "2026-10-01T00:00:00Z", title: "World of Warcraft: Midnight Hotfixes" };
    const reply = (excerpt: string, title = "World of Warcraft: Midnight Hotfixes") => parseBluepostFeed(feed(
      { id: 9, topic: 5, post: 9, created: "2026-11-02T10:00:00Z", title, excerpt }, opener), us).filter((entry) => entry.sourcePostNumber === 9);
    expect(reply("Thanks!")).toEqual([]);
    expect(reply("Housing: Tracking the source for the Nagrand plant decor now properly leads to her location in Nagrand.")).toEqual([]);
    expect(reply("We are looking into the Forever situation and will share more information when we have it available.", "Forever thread")).toEqual([]);
  });

  it("keeps US and EU identities and entries isolated", () => {
    const body = feed({ id: 9, topic: 77, post: 9, created: "2026-11-03T03:20:33Z", user: 11548 }, { id: 1, topic: 77, post: 1, created: "2026-09-24T22:23:24Z", user: 11548 });
    const euEntries = parseBluepostFeed(body, eu);
    expect(euEntries.every((entry) => entry.sourceKey === "blizzard-bluepost-eu" && entry.threadKey === "eu:topic:77" && entry.region === "eu")).toBe(true);
    // A US-verified id never authorises an EU post, even if the numeric id happens to match.
    const posts = parseTrackerPosts(topicDoc(77, TOPIC_TITLE, [{ id: 9, topic: 77, post: 9, created: "2026-11-03T03:20:33Z", user: 3390 }]));
    expect(evaluatePost(posts[0]!, eu, { staff: new Map([[11548, "community-manager"]]), origins: new Map([["77", "official"]]) })).toEqual({ reject: "unverified_identity" });
  });
});

describe("edits, versions and content hashing", () => {
  const staffCtx = { staff: new Map([[3390, "community-manager"]]), origins: new Map([["77", "official" as const]]) };

  it("records a meaningful edit as officialUpdatedAt and preserves the original publication time", () => {
    const [post] = parseTrackerPosts(topicDoc(77, TOPIC_TITLE, [{ id: 1, topic: 77, post: 1, created: "2026-09-24T22:23:24Z", updated: "2026-11-03T03:20:46Z", version: 6 }]));
    const decision = evaluatePost(post!, us, staffCtx);
    expect("entry" in decision && decision.entry).toMatchObject({
      publishedAt: "2026-09-24T22:23:24.000Z", officialUpdatedAt: "2026-11-03T03:20:46.000Z", sourceVersion: 6, observedVia: "topic",
    });
  });

  it("ignores an edit inside the posting grace period and a re-bake that did not change the version", () => {
    const [typo] = parseTrackerPosts(topicDoc(77, TOPIC_TITLE, [{ id: 1, topic: 77, post: 1, created: "2026-11-03T03:00:00Z", updated: "2026-11-03T03:02:00Z", version: 2 }]));
    const [rebake] = parseTrackerPosts(topicDoc(77, TOPIC_TITLE, [{ id: 2, topic: 77, post: 1, created: "2026-10-01T03:00:00Z", updated: "2026-11-02T18:21:56Z", version: 1 }]));
    for (const post of [typo!, rebake!]) {
      const decision = evaluatePost(post, us, staffCtx);
      expect("entry" in decision && decision.entry.officialUpdatedAt).toBeUndefined();
    }
  });

  it("hashes content, not the forum's volatile updated_at, so a re-bake is not an update", async () => {
    const run = async (updated: string) => {
      const h = harness([(url) => (isFeed(url) ? json200(feed({ id: 1, topic: 7, post: 1, created: "2026-11-03T11:00:00Z" })) : undefined)]);
      await collectNews(h.options(us));
      void updated;
      return h.payloads[0]!.entries[0]!.contentHash;
    };
    expect(await run("a")).toBe(await run("b"));
    const [a, b] = ["2026-11-02T18:21:56Z", "2026-11-02T19:21:56Z"].map((updated) =>
      evaluatePost(parseTrackerPosts(topicDoc(7, TOPIC_TITLE, [{ id: 1, topic: 7, post: 1, created: "2026-10-01T00:00:00Z", updated, version: 1 }]))[0]!, us,
        { staff: new Map([[3390, "community-manager"]]), origins: new Map() }));
    expect("entry" in a! && "entry" in b! && a.entry.modifiedAt !== b.entry.modifiedAt).toBe(true);
  });
});

describe("Tracker pagination (production defect: ?page= is ignored by Blizzard)", () => {
  it("walks back with the before=<created_at> cursor until the lookback window is covered", async () => {
    const page1 = feed(...Array.from({ length: 3 }, (_, i) => ({ id: 100 - i, topic: 10 + i, post: 1, created: `2026-11-03T11:${String(50 - i).padStart(2, "0")}:00.000Z` })));
    // 07:00 is inside the 6h lookback (since = 06:00); 05:00 is older than the window and must not be admitted.
    const page2 = feed({ id: 90, topic: 20, post: 1, created: "2026-11-03T07:00:00.000Z" }, { id: 89, topic: 21, post: 1, created: "2026-11-03T05:00:00.000Z" });
    const h = harness([(url) => (isFeed(url) && url.includes("before=") ? json200(page2) : isFeed(url) ? json200(page1) : undefined)], {}, true);
    const [report] = await collectNews(h.options(us, { limits: { topicPauseMs: 0, feedLookbackMs: 6 * 3_600_000 } }));
    expect(h.requests.filter(isFeed)).toHaveLength(2);
    expect(h.requests.find((url) => url.includes("before="))).toContain("before=2026-11-03T11%3A48%3A00.000Z");
    expect(report?.status).toBe("succeeded");
    expect(ids(h.payloads[0])).toEqual(["post:100", "post:90", "post:98", "post:99"]);
  });

  it("detects an endpoint that ignores the cursor and reports it instead of looping or silently truncating", async () => {
    const same = feed({ id: 1, topic: 7, post: 1, created: "2026-11-03T11:00:00Z" });
    const h = harness([(url) => (isFeed(url) ? json200(same) : undefined)], {}, true);
    const [report] = await collectNews(h.options(us, { limits: { topicPauseMs: 0, feedLookbackMs: 48 * 3_600_000 } }));
    expect(h.requests.filter(isFeed)).toHaveLength(2);
    expect(report).toMatchObject({ status: "partial", errorCategory: "pagination_stalled" });
    expect(h.payloads[0]?.run).toMatchObject({ status: "partial", fetchOk: true, errorCategory: "pagination_stalled" });
  });

  it("flags a window truncated by the page cap as partial", async () => {
    let n = 0;
    const h = harness([(url) => { if (!isFeed(url)) return undefined; n += 1; return json200(feed({ id: 1000 - n, topic: n, post: 1, created: `2026-11-03T11:${String(59 - n).padStart(2, "0")}:00Z` })); }], {}, true);
    const [report] = await collectNews(h.options(us, { limits: { topicPauseMs: 0, feedMaxPages: 2, feedLookbackMs: 24 * 3_600_000 } }));
    expect(h.requests.filter(isFeed)).toHaveLength(2);
    expect(report?.errorCategory).toBe("window_truncated");
  });
});

describe("origin lookup, old topics and thread completion", () => {
  it("surfaces a fresh official reply in an OLD topic, completing the opener (original publication time) via one bounded topic fetch", async () => {
    const h = harness([
      (url) => (isFeed(url) ? json200(feed({ id: 1009, topic: 77, post: 9, created: "2026-11-03T11:55:00Z" })) : undefined),
      (url) => (isTopic(url, 77) ? json200(topicDoc(77, TOPIC_TITLE, [
        { id: 1001, topic: 77, post: 1, created: "2026-09-24T22:23:24Z", updated: "2026-11-03T03:20:46Z", version: 6 },
        { id: 1007, topic: 77, post: 7, created: "2026-10-26T20:35:27Z" },
        { id: 1009, topic: 77, post: 9, created: "2026-11-03T11:55:00Z" },
      ])) : undefined),
    ]);
    const [report] = await collectNews(h.options(us));
    expect(h.requests.filter((url) => isTopic(url, 77))).toHaveLength(1);
    // The opener (completion) and the new reply; the Oct 26 reply is outside the window and is NOT resurrected.
    expect(ids(h.payloads[0])).toEqual(["post:1001", "post:1009"]);
    const opener = h.payloads[0]!.entries.find((entry) => entry.sourceEntryId === "post:1001")!;
    expect(opener).toMatchObject({ publishedAt: "2026-09-24T22:23:24.000Z", officialUpdatedAt: "2026-11-03T03:20:46.000Z", observedVia: "topic" });
    expect(h.payloads[0]!.run.topicChecks).toEqual([expect.objectContaining({ topicId: "topic:77", ok: true, threadOrigin: "official" })]);
    expect(report?.status).toBe("succeeded");
  });

  it("verifies a community thread by its opener's identity and never ingests the player opener", async () => {
    const h = harness([
      (url) => (isFeed(url) ? json200(feed({ id: 2002, topic: 88, post: 2, created: "2026-11-03T11:50:00Z", title: "Question about the beta", excerpt: "Thanks for the report - this is fixed in the next WoW: Forever beta build." })) : undefined),
      (url) => (isTopic(url, 88) ? json200(topicDoc(88, "Question about the beta", [
        { id: 2001, topic: 88, post: 1, created: "2026-11-03T11:00:00Z", user: 424242, username: "ordinary-player", group: null, staff: false },
        { id: 2002, topic: 88, post: 2, created: "2026-11-03T11:50:00Z", excerpt: "Thanks for the report - this is fixed in the next WoW: Forever beta build." },
      ])) : undefined),
    ]);
    await collectNews(h.options(us));
    expect(ids(h.payloads[0])).toEqual(["post:2002"]);
    expect(h.payloads[0]!.entries[0]).toMatchObject({ threadOrigin: "community", authorUserId: 3390 });
  });

  it("bounds origin lookups per run and leaves the rest for the next run", async () => {
    const posts = Array.from({ length: 5 }, (_, i) => ({ id: 500 + i, topic: 600 + i, post: 3, created: `2026-11-03T11:${50 - i}:00Z` }));
    const h = harness([
      (url) => (isFeed(url) ? json200(feed(...posts)) : undefined),
      (url) => (url.includes("/t/6") ? json200(topicDoc(600, TOPIC_TITLE, [{ id: 1, topic: 600, post: 1, created: "2026-10-01T00:00:00Z" }])) : undefined),
    ]);
    const [report] = await collectNews(h.options(us, { limits: { topicPauseMs: 0, originLookups: 2 } }));
    expect(h.requests.filter((url) => /\/t\/\d+\.json$/.test(url))).toHaveLength(2);
    expect(h.payloads[0]!.run.diagnostics).toMatchObject({ deferredTopics: 3 });
    expect(report?.status).toBe("succeeded");
  });
});

describe("persistent revision tracking", () => {
  const ctx = (due: RevisionContext["dueTopics"]): RevisionContext => ({ verifiedStaff: [{ userId: 3390, group: "community-manager" }], dueTopics: due, knownOrigins: [] });
  const due = (id: number, extra: Partial<RevisionContext["dueTopics"][number]> = {}) => ({
    topicId: `topic:${id}`, threadOrigin: "official" as const, consecutiveFailures: 0, lastOfficialAt: "2026-11-03T03:20:46Z", firstSeenAt: "2026-10-01T00:00:00Z", officialPostIds: ["1001"], ...extra,
  });

  it("revises a due topic that is no longer in the newest Tracker window", async () => {
    const h = harness([
      (url) => (isFeed(url) ? json200(feed({ id: 9999, topic: 5, post: 1, created: "2026-11-03T11:00:00Z", title: "Unrelated topic" })) : undefined),
      (url) => (isTopic(url, 77) ? json200(topicDoc(77, TOPIC_TITLE, [{ id: 1001, topic: 77, post: 1, created: "2026-09-24T22:23:24Z", updated: "2026-11-04T01:00:00Z", version: 7 }])) : undefined),
    ]);
    const [report] = await collectNews(h.options(us, { mode: "revision", loadContext: async () => ctx([due(77)]) }));
    expect(h.requests.some((url) => isTopic(url, 77))).toBe(true);
    expect(ids(h.payloads[0])).toContain("post:1001");
    expect(h.payloads[0]!.entries.find((entry) => entry.sourceEntryId === "post:1001")).toMatchObject({ sourceVersion: 7, officialUpdatedAt: "2026-11-04T01:00:00.000Z" });
    expect(h.payloads[0]!.run.topicChecks).toEqual([expect.objectContaining({ topicId: "topic:77", ok: true })]);
    expect(report?.status).toBe("succeeded");
  });

  it("refreshes a known reply edit but never resurrects older unknown replies", async () => {
    const doc = topicDoc(77, TOPIC_TITLE, [
      { id: 1001, topic: 77, post: 1, created: "2026-09-24T22:23:24Z" },
      { id: 1007, topic: 77, post: 7, created: "2026-10-26T20:35:27Z", updated: "2026-10-27T16:47:14Z", version: 4 },
      { id: 1008, topic: 77, post: 8, created: "2026-10-27T15:37:37Z" },
      { id: 1009, topic: 77, post: 9, created: "2026-11-03T03:20:33Z", updated: "2026-11-03T09:00:00Z", version: 2 },
    ]);
    const h = harness([(url) => (isFeed(url) ? json200(feed()) : isTopic(url, 77) ? json200(doc) : undefined)]);
    await collectNews(h.options(us, { mode: "revision", loadContext: async () => ctx([due(77, { officialPostIds: ["1001", "1009"] })]) }));
    expect(ids(h.payloads[0])).toEqual(["post:1001", "post:1009"]);
    expect(h.payloads[0]!.entries.find((entry) => entry.sourceEntryId === "post:1009")?.officialUpdatedAt).toBe("2026-11-03T09:00:00.000Z");
    expect(h.payloads[0]!.run.diagnostics).toMatchObject({ rejectReasons: expect.objectContaining({ topic_reply_outside_coverage: 2 }) });
  });

  it("honours the batch limit and leaves unreached topics due instead of failing them", async () => {
    const h = harness([
      (url) => (isFeed(url) ? json200(feed()) : undefined),
      (url) => { const m = /\/t\/(\d+)\.json$/.exec(url); return m ? json200(topicDoc(Number(m[1]), TOPIC_TITLE, [{ id: Number(m[1]) * 10, topic: Number(m[1]), post: 1, created: "2026-09-24T00:00:00Z" }])) : undefined; },
    ]);
    const many = Array.from({ length: 6 }, (_, i) => due(700 + i, { officialPostIds: [] }));
    const [report] = await collectNews(h.options(us, { mode: "revision", loadContext: async () => ctx(many), limits: { topicPauseMs: 0, topicBatch: 4 } }));
    expect(h.requests.filter((url) => /\/t\/\d+\.json$/.test(url))).toHaveLength(4);
    expect(h.payloads[0]!.run.topicChecks).toHaveLength(4);
    expect(report?.status).toBe("succeeded");
  });

  it("stops on HTTP 429, records it, defers the remaining topics and reports a categorised partial run", async () => {
    const h = harness([
      (url) => (isFeed(url) ? json200(feed()) : undefined),
      (url) => (isTopic(url, 701) ? json200(topicDoc(701, TOPIC_TITLE, [{ id: 7010, topic: 701, post: 1, created: "2026-09-24T00:00:00Z" }])) : undefined),
      (url) => (isTopic(url, 702) ? new Response("slow down", { status: 429 }) : undefined),
    ]);
    const topics = [701, 702, 703, 704].map((id) => due(id, { officialPostIds: [] }));
    const [report] = await collectNews(h.options(us, { mode: "revision", loadContext: async () => ctx(topics), limits: { topicPauseMs: 0, topicConcurrency: 1, fetchAttempts: 1 } }));
    expect(h.requests.some((url) => isTopic(url, 703))).toBe(false);
    expect(report).toMatchObject({ status: "partial", errorCategory: "http_429" });
    expect(h.payloads[0]!.run.topicChecks?.find((check) => check.topicId === "topic:702")).toMatchObject({ ok: false, httpStatus: 429 });
    expect(h.payloads[0]!.run.diagnostics).toMatchObject({ deferredTopics: 2 });
  });

  it("audits a topic failure as a partial run while still persisting what succeeded", async () => {
    const h = harness([
      (url) => (isFeed(url) ? json200(feed({ id: 1, topic: 7, post: 1, created: "2026-11-03T11:00:00Z" })) : undefined),
      (url) => (isTopic(url, 77) ? new Response("boom", { status: 404 }) : undefined),
    ]);
    const [report] = await collectNews(h.options(us, { mode: "revision", loadContext: async () => ctx([due(77)]) }));
    expect(report).toMatchObject({ status: "partial", error: "revision_topic_failures:1" });
    expect(ids(h.payloads[0])).toEqual(["post:1"]);
  });
});

describe("source failures, retry and persistence", () => {
  it("retries transient failures with exponential back-off and then succeeds", async () => {
    let calls = 0;
    const h = harness([(url) => {
      if (!isFeed(url)) return undefined;
      calls += 1;
      return calls < 3 ? new Response("unavailable", { status: 503 }) : json200(feed({ id: 1, topic: 7, post: 1, created: "2026-11-03T11:00:00Z" }));
    }]);
    const [report] = await collectNews(h.options(us));
    expect(calls).toBe(3);
    expect(h.sleeps).toEqual([500, 1000]);
    expect(report?.status).toBe("succeeded");
  });

  it("records a persistent source outage with its category and HTTP status (still audited, fetchOk=false)", async () => {
    const h = harness([(url) => (isFeed(url) ? new Response("unavailable", { status: 503 }) : undefined)]);
    const [report] = await collectNews(h.options(us));
    expect(report).toMatchObject({ status: "failed", errorCategory: "http_503", httpStatus: 503, error: "source_http_503" });
    expect(h.payloads[0]?.run).toMatchObject({ status: "failed", fetchOk: false, errorCategory: "http_503", httpStatus: 503 });
  });

  it("does not retry permanent 4xx errors", async () => {
    let calls = 0;
    const h = harness([(url) => { if (isFeed(url)) { calls += 1; return new Response("gone", { status: 403 }); } return undefined; }]);
    const [report] = await collectNews(h.options(us));
    expect(calls).toBe(1);
    expect(report).toMatchObject({ errorCategory: "http_403" });
  });

  it("categorises timeouts and network errors", async () => {
    const abort = new Error("aborted"); abort.name = "AbortError";
    const h1 = harness([() => { throw abort; }]);
    expect((await collectNews(h1.options(us)))[0]).toMatchObject({ status: "failed", errorCategory: "timeout" });
    const h2 = harness([() => { throw new Error("connection reset"); }]);
    expect((await collectNews(h2.options(us)))[0]).toMatchObject({ status: "failed", errorCategory: "network" });
  });

  it("records malformed source payloads as failures without disabling the source", async () => {
    const h = harness([() => json200("not-json")]);
    const [report] = await collectNews(h.options(us));
    expect(report).toMatchObject({ status: "failed", error: "source_invalid_bluepost_payload", errorCategory: "invalid_payload" });
    expect(h.payloads[0]?.source.enabled).toBe(true);
  });

  it("separates 'fetched but failed to persist' from source failures", async () => {
    const h = harness([(url) => (isFeed(url) ? json200(feed({ id: 1, topic: 7, post: 1, created: "2026-11-03T11:00:00Z" })) : undefined)]);
    const [report] = await collectNews(h.options(us, { apply: async () => { throw new Error("connection refused"); } }));
    expect(report).toMatchObject({ status: "failed", errorCategory: "persistence_failed", fetchedCount: 1, acceptedCount: 1 });
  });

  it("still loads when the persisted revision context is unavailable (feed attests identities)", async () => {
    const h = harness([(url) => (isFeed(url) ? json200(feed({ id: 1, topic: 7, post: 1, created: "2026-11-03T11:00:00Z" })) : undefined)]);
    const [report] = await collectNews(h.options(us, { mode: "revision", loadContext: async () => { throw new Error("db down"); } }));
    expect(report?.status).toBe("succeeded");
    expect(ids(h.payloads[0])).toEqual(["post:1"]);
  });
});

describe("idempotency", () => {
  it("produces identical payloads (and hashes) for repeated normal runs", async () => {
    const body = feed({ id: 1, topic: 7, post: 1, created: "2026-11-03T11:00:00Z" }, { id: 2, topic: 7, post: 2, created: "2026-11-03T11:30:00Z" });
    const h = harness([(url) => (isFeed(url) ? json200(body) : undefined)]);
    await collectNews(h.options(us));
    await collectNews(h.options(us));
    expect(JSON.stringify(h.payloads[0]!.entries)).toBe(JSON.stringify(h.payloads[1]!.entries));
    expect(h.payloads[0]!.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.contentHash))).toBe(true);
  });

  it("sends the verified staff identities observed in the feed (id + group, never a name-based claim)", async () => {
    const h = harness([(url) => (isFeed(url) ? json200(feed({ id: 1, topic: 7, post: 1, created: "2026-11-03T11:00:00Z" }, { id: 2, topic: 8, post: 1, created: "2026-11-03T11:01:00Z", user: 424242, group: null, name: "Kaivax" })) : undefined)]);
    await collectNews(h.options(us));
    expect(h.payloads[0]!.run.verifiedStaff).toEqual([{ userId: 3390, username: "Kaivax", group: "community-manager" }]);
    expect(ids(h.payloads[0])).toEqual(["post:1"]);
    expect(h.payloads[0]!.run.diagnostics).toMatchObject({ rejectReasons: expect.objectContaining({ group_not_allowlisted: 1 }) });
  });
});

describe("historical backfill", () => {
  const window = { since: "2026-10-30T00:00:00.000Z", until: "2026-11-03T23:59:59.999Z" };
  const routes = (): Route[] => [
    (url) => (isFeed(url) && url.includes("before=2026-11-04T00%3A00%3A00.000Z") ? json200(feed(
      { id: 1009, topic: 77, post: 9, created: "2026-11-03T03:20:33Z" },
      { id: 1500, topic: 90, post: 150, created: "2026-10-31T02:17:54Z", title: "World of Warcraft: Midnight Hotfixes", excerpt: "October 30, 2026 Housing: Tracking the source for the Nagrand plant decor now properly leads to her location." },
      { id: 1100, topic: 55, post: 1, created: "2026-10-29T21:00:50Z", title: "World of Warcraft: Forever Goes Live Globally November 4!", excerpt: "Begin your first adventure in World of Warcraft: Forever." },
    )) : undefined),
    (url) => (isFeed(url) ? json200(feed({ id: 900, topic: 40, post: 1, created: "2026-10-20T00:00:00Z" })) : undefined),
    (url) => (isTopic(url, 77) ? json200(topicDoc(77, TOPIC_TITLE, [
      { id: 1001, topic: 77, post: 1, created: "2026-09-24T22:23:24Z", updated: "2026-11-03T03:20:46Z", version: 6 },
      { id: 1007, topic: 77, post: 7, created: "2026-10-26T20:35:27Z" },
      { id: 1009, topic: 77, post: 9, created: "2026-11-03T03:20:33Z" },
    ])) : undefined),
  ];

  it("defaults to a read-only preview, is bounded to the window, completes the thread opener and excludes everything else", async () => {
    const h = harness(routes(), {}, true);
    const [report] = await collectNews(h.options(us, { mode: "backfill", backfill: { ...window, dryRun: true } }));
    expect(h.payloads[0]!.run).toMatchObject({ mode: "backfill", dryRun: true });
    expect(report).toMatchObject({ dryRun: true, status: "succeeded" });
    // in-window official reply + thread opener (original date, edited). Not: Oct 26 reply, Oct 29 post, Midnight hotfix reply.
    expect(ids(h.payloads[0])).toEqual(["post:1001", "post:1009"]);
    expect(h.payloads[0]!.entries.map((entry) => entry.publishedAt).sort()).toEqual(["2026-09-24T22:23:24.000Z", "2026-11-03T03:20:33.000Z"]);
    expect(h.requests.find((url) => url.includes("before="))).toContain("before=2026-11-04T00%3A00%3A00.000Z");
  });

  it("only sends a non-dry run when the caller explicitly asks for it", async () => {
    const h = harness(routes(), {}, true);
    await collectNews(h.options(us, { mode: "backfill", backfill: { ...window, dryRun: false } }));
    expect(h.payloads[0]!.run.dryRun).toBe(false);
  });

  it("refuses to run when the V2 schema is not proven (a pre-V2 apply would ignore dryRun and WRITE): no fetch, no apply", async () => {
    const h = harness(routes(), {}, true);
    const preflight = async () => { throw new Error("function pub_admin.news_revision_batch does not exist"); };
    const [report] = await collectNews(h.options(us, { mode: "backfill", backfill: { ...window, dryRun: true }, preflight }));
    expect(report).toMatchObject({ status: "failed", errorCategory: "schema_not_ready", error: "database_schema_not_ready" });
    expect(h.payloads).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
  });

  it("runs a backfill when the preflight passes, and never calls the preflight for normal or revision runs", async () => {
    let calls = 0;
    const preflight = async () => { calls += 1; };
    const ok = harness(routes(), {}, true);
    const [report] = await collectNews(ok.options(us, { mode: "backfill", backfill: { ...window, dryRun: true }, preflight }));
    expect(report?.status).toBe("succeeded");
    expect(calls).toBe(1);
    const normal = harness([(url) => (isFeed(url) ? json200(feed({ id: 1, topic: 7, post: 1, created: "2026-11-03T11:00:00Z" })) : undefined)]);
    await collectNews(normal.options(us, { mode: "normal", preflight }));
    await collectNews(normal.options(us, { mode: "revision", preflight }));
    expect(calls).toBe(1);
  });

  it("rejects an invalid window and skips Official News", async () => {
    const h = harness(routes(), {}, true);
    const [bad] = await collectNews(h.options(us, { mode: "backfill", backfill: { since: window.until, until: window.since, dryRun: true } }));
    expect(bad).toMatchObject({ status: "failed", errorCategory: "config" });
    const reports = await collectNews(h.options(official, { sources: [official], mode: "backfill", backfill: { ...window, dryRun: true } }));
    expect(reports).toEqual([]);
  });

  it("is idempotent: two preview runs yield identical entries", async () => {
    const a = harness(routes(), {}, true); const b = harness(routes(), {}, true);
    await collectNews(a.options(us, { mode: "backfill", backfill: { ...window, dryRun: true } }));
    await collectNews(b.options(us, { mode: "backfill", backfill: { ...window, dryRun: true } }));
    expect(JSON.stringify(a.payloads[0]!.entries)).toBe(JSON.stringify(b.payloads[0]!.entries));
  });
});

describe("Official News (unchanged)", () => {
  it("parses Blizzard's first-party paginated news fragment and preserves article IDs", () => {
    const fragment = `<div class="Paginator" data-url="/news/river.frag" data-page="2" data-total="209"><article class="NewsBlog"><div class="NewsBlog-title">Gather Around the Campfire in World of Warcraft: Forever</div><p class="NewsBlog-desc color-beige-medium">The Camping system in World of Warcraft: Forever lets players create shared campsites.</p><div class="NewsBlog-date" data-props="{&quot;iso8601&quot;:&quot;2026-10-21T17:00:00.000Z&quot;,&quot;relative&quot;:true}">yesterday</div><a class="Link NewsBlog-link" href="/news/24301516/gather-around-the-campfire-in-world-of-warcraft-forever"></a></article></div>`;
    const entries = parseOfficialNewsFragment(fragment, official);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      sourceEntryId: "article:24301516", category: "official_news", publishedAt: "2026-10-21T17:00:00.000Z", status: "published",
      canonicalUrl: "https://worldofwarcraft.blizzard.com/en-us/news/24301516/gather-around-the-campfire-in-world-of-warcraft-forever",
    });
    // No provenance keys: the Official News content hash must not change with V2.
    expect(Object.keys(entries[0]!)).not.toContain("authorUserId");
  });

  it("follows the first-party fragment pages, isolates an EU outage and audits it", async () => {
    const article = `<article class="NewsBlog"><div class="NewsBlog-title">World of Warcraft: Forever News</div><p class="NewsBlog-desc">A Forever article.</p><div data-props="{&quot;iso8601&quot;:&quot;2026-10-22T02:00:00.000Z&quot;}"></div><a class="Link NewsBlog-link" href="/news/24300001/forever"></a></article>`;
    const h = harness([
      (url) => (url.includes("eu.forums") ? new Response("down", { status: 500 }) : undefined),
      (url) => (isFeed(url) ? json200(feed({ id: 1, topic: 1, post: 1, created: "2026-11-03T11:00:00Z" })) : undefined),
      (url) => (url.includes("river.frag") ? json200(article) : undefined),
    ]);
    const reports = await collectNews({ ...h.options(us), sources: [us, eu, official] });
    expect(reports.map((report) => [report.sourceKey, report.status])).toEqual([
      ["blizzard-bluepost-us", "succeeded"], ["blizzard-bluepost-eu", "failed"], ["blizzard-news-us", "succeeded"],
    ]);
    expect(h.payloads.find((payload) => payload.source.sourceKey === "blizzard-news-us")?.entries[0]?.sourceEntryId).toBe("article:24300001");
  });

  it("rejects a non-article payload as invalid", async () => {
    const h = harness([() => json200("<html>maintenance</html>")]);
    const [report] = await collectNews(h.options(official));
    expect(report).toMatchObject({ status: "failed", errorCategory: "invalid_payload" });
  });
});
