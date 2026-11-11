import type { NewsEntry, NewsRegion, NewsStory } from "@/lib/data/types";
import { buildNewsCards, isVisibleNewsEntry, officialAt, threadUpdates, type NewsCardOptions, type NewsEntrySource } from "@/lib/news/cards";

/**
 * Pure mirror of the global story grouping contract (migration 0013: pub.news_story_members, pub_admin.news_link_stories,
 * web_api.news_stories, web_api.news_story_entry). The fixture adapter and the unit tests use it so the website is exercised
 * against the SAME semantics as production. The matcher is deterministic and conservative; it is never run in a read path:
 * links are computed once (the database function, or `matchStories` for fixtures) and passed to the builders.
 *
 * Rule `exact_content_v1`: two verified Blue Post thread openers belong together only if the normalized title, the normalized
 * author and the normalized excerpt (>= 40 characters) are identical and the openers were published at most 15 minutes apart.
 * The group must be a clique; reviewed overrides can force ('allow') or forbid ('deny') a pair.
 */
export const STORY_RULE_VERSION = "exact_content_v1";
export const STORY_MAX_MINUTES = 15;
export const STORY_MIN_EXCERPT = 40;

export const normalizeStoryText = (value: string | null | undefined): string =>
  (value ?? "")
    .replace(/&[a-zA-Z#0-9]+;/g, " ")
    .replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export type StoryLinks = ReadonlyMap<string, string>;

export interface StoryOverride { threadA: string; threadB: string; decision: "allow" | "deny" }
export interface StoryMatchPlan {
  /** thread key -> story key (only threads that belong to a multi-thread story). */
  links: Map<string, string>;
  stories: Array<{ storyKey: string; members: string[] }>;
  review: Array<{ threadA: string; threadB: string; title: string; minutesApart: number; reasons: string[] }>;
  ambiguous: Array<{ threads: string[]; clique: boolean }>;
}

interface Opener { threadKey: string; region: NewsRegion; title: string; nt: string; ne: string; na: string; pub: number }

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function matchStories(entries: NewsEntrySource[], overrides: StoryOverride[] = [], now = new Date()): StoryMatchPlan {
  const openers: Opener[] = entries
    .filter((e) => isVisibleNewsEntry(e, now) && e.sourcePostNumber === 1 && e.category === "bluepost" && e.threadKey && (e.region === "us" || e.region === "eu"))
    .map((e) => ({ threadKey: e.threadKey!, region: e.region, title: e.title, nt: normalizeStoryText(e.title), ne: normalizeStoryText(e.excerpt), na: normalizeStoryText(e.author), pub: Date.parse(e.publishedAt) }))
    .sort((a, b) => a.pub - b.pub || a.threadKey.localeCompare(b.threadKey));
  const decisions = new Map(overrides.map((o) => [pairKey(o.threadA, o.threadB), o.decision] as const));
  const pass = new Set<string>();
  const review: StoryMatchPlan["review"] = [];
  for (let i = 0; i < openers.length; i += 1) {
    for (let j = i + 1; j < openers.length; j += 1) {
      const a = openers[i]!; const b = openers[j]!;
      const key = pairKey(a.threadKey, b.threadKey);
      const decision = decisions.get(key);
      const sameTitle = a.nt !== "" && a.nt === b.nt;
      if (!sameTitle && decision !== "allow") continue;
      const minutes = Math.round((Math.abs(a.pub - b.pub) / 60_000) * 10) / 10;
      const sameAuthor = a.na !== "" && a.na === b.na;
      const sameExcerpt = a.ne === b.ne && a.ne.length >= STORY_MIN_EXCERPT;
      const auto = sameTitle && sameAuthor && minutes <= STORY_MAX_MINUTES && sameExcerpt;
      if (decision === "allow" || (auto && decision !== "deny")) { pass.add(key); continue; }
      if (sameTitle && minutes <= STORY_MAX_MINUTES) {
        review.push({ threadA: a.threadKey, threadB: b.threadKey, title: a.title, minutesApart: minutes,
          reasons: [decision === "deny" ? "denied_by_override" : "", sameAuthor ? "" : "author_differs", sameExcerpt ? "" : "content_differs_or_excerpt_too_short"].filter(Boolean) });
      }
    }
  }
  // connected components over passing pairs
  const parent = new Map<string, string>(openers.map((o) => [o.threadKey, o.threadKey]));
  const find = (x: string): string => { const p = parent.get(x)!; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  for (const key of pass) { const [a, b] = key.split("|") as [string, string]; const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra > rb ? ra : rb, ra > rb ? rb : ra); }
  const groups = new Map<string, string[]>();
  for (const o of openers) groups.set(find(o.threadKey), [...(groups.get(find(o.threadKey)) ?? []), o.threadKey]);
  const links = new Map<string, string>();
  const stories: StoryMatchPlan["stories"] = [];
  const ambiguous: StoryMatchPlan["ambiguous"] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    let passes = 0;
    for (let i = 0; i < members.length; i += 1) for (let j = i + 1; j < members.length; j += 1) if (pass.has(pairKey(members[i]!, members[j]!))) passes += 1;
    if (passes !== (members.length * (members.length - 1)) / 2) { ambiguous.push({ threads: members, clique: false }); continue; }
    const earliest = openers.filter((o) => members.includes(o.threadKey))[0]!; // openers are sorted by (time, key)
    const storyKey = `story:${earliest.threadKey}`;
    stories.push({ storyKey, members });
    for (const m of members) links.set(m, storyKey);
  }
  return { links, stories: stories.sort((a, b) => a.storyKey.localeCompare(b.storyKey)), review, ambiguous };
}

const byActivity = (a: NewsEntry, b: NewsEntry) => officialAt(b).localeCompare(officialAt(a)) || b.id - a.id;
const storyOf = (entry: Pick<NewsEntry, "threadKey" | "id">, links: StoryLinks) => (entry.threadKey ? links.get(entry.threadKey) : undefined) ?? (entry.threadKey ?? `entry:${entry.id}`);

/**
 * One card per global story (or per thread when unlinked). Region/category/search filters apply to the member threads BEFORE
 * grouping, so totals and pagination count stories; a story shows the region-specific content of its best member.
 */
export function buildStoryCards(entries: NewsEntrySource[], links: StoryLinks, options: NewsCardOptions = {}): NewsEntry[] {
  const all = buildNewsCards(entries, { now: options.now });
  const filtered = buildNewsCards(entries, { ...options, featuredFirst: false });
  const regionsBy = new Map<string, Set<NewsRegion>>();
  const countBy = new Map<string, number>();
  for (const card of all) {
    const key = storyOf(card, links);
    regionsBy.set(key, (regionsBy.get(key) ?? new Set()).add(card.region));
    countBy.set(key, (countBy.get(key) ?? 0) + 1);
  }
  const grouped = new Map<string, NewsEntry[]>();
  for (const card of filtered) grouped.set(storyOf(card, links), [...(grouped.get(storyOf(card, links)) ?? []), card]);
  const cards: NewsEntry[] = [];
  for (const [key, members] of grouped) {
    const ordered = [...members].sort(byActivity);
    const rep = ordered[0]!;
    const canonicalThread = (links.get(rep.threadKey ?? "") ?? "").slice("story:".length);
    cards.push({
      ...rep,
      canonicalSlug: entries.find((e) => e.threadKey === canonicalThread && e.sourcePostNumber === 1 && isVisibleNewsEntry(e, options.now ?? new Date()))?.slug ?? rep.slug,
      featured: members.some((m) => m.featured), importance: Math.max(...members.map((m) => m.importance)),
      threadPublishedAt: members.map((m) => m.threadPublishedAt ?? m.publishedAt).sort()[0] ?? rep.publishedAt,
      officialUpdatedAt: officialAt(rep),
      storyKey: links.get(rep.threadKey ?? "") ?? null,
      regions: [...(regionsBy.get(key) ?? [rep.region])].sort(),
      memberCount: countBy.get(key) ?? 1,
    });
  }
  return cards.sort((a, b) => options.featuredFirst
    ? Number(b.featured) - Number(a.featured) || b.importance - a.importance || byActivity(a, b)
    : byActivity(a, b));
}

/** Detail of any entry URL (old URLs stay valid): the entry's own thread context plus the whole global story. */
export function storyDetail(entries: NewsEntrySource[], links: StoryLinks, slug: string, now = new Date()): NewsEntry | null {
  const base = threadUpdates(entries, slug, now);
  if (!base) return null;
  const storyKey = base.threadKey ? links.get(base.threadKey) : undefined;
  if (!storyKey) return { ...base, story: null, storyKey: null };
  const memberKeys = new Set([...links].filter(([, k]) => k === storyKey).map(([t]) => t));
  const visible = entries.filter((e) => isVisibleNewsEntry(e, now) && e.threadKey && memberKeys.has(e.threadKey));
  const members = [...memberKeys].flatMap((threadKey) => {
    const posts = visible.filter((e) => e.threadKey === threadKey).sort((a, b) => (a.sourcePostNumber ?? 0) - (b.sourcePostNumber ?? 0) || a.id - b.id);
    const opener = posts[0];
    if (!opener) return [];
    const newest = [...posts].sort(byActivity);
    return [{
      region: opener.region, threadKey, topicId: opener.sourceTopicId, title: opener.title, sourceUrl: opener.canonicalUrl, openerSlug: opener.slug,
      author: opener.author, firstPublishedAt: posts.map((p) => p.publishedAt).sort()[0]!, lastOfficialAt: officialAt(newest[0]!), updateCount: posts.length,
      updates: newest.slice(0, 10).map((p) => ({ slug: p.slug, postNumber: p.sourcePostNumber, canonicalUrl: p.canonicalUrl, publishedAt: p.publishedAt,
        officialUpdatedAt: officialAt(p), author: p.author, entryKind: (p.sourcePostNumber === 1 ? "announcement" : p.threadOrigin === "official" ? "official_update" : "staff_reply") as NewsEntry["entryKind"] & string })),
    }];
  }).sort((a, b) => a.firstPublishedAt.localeCompare(b.firstPublishedAt) || a.threadKey.localeCompare(b.threadKey));
  const canonicalThread = storyKey.slice("story:".length);
  const canonical = members.find((m) => m.threadKey === canonicalThread) ?? members[0]!;
  const story: NewsStory = {
    storyKey, canonicalSlug: canonical.openerSlug,
    regions: [...new Set(members.map((m) => m.region))].sort(), members,
  };
  return { ...base, storyKey, story, regions: story.regions, memberCount: members.length };
}
