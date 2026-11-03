import type { NewsEntry, NewsEntryKind, NewsQuery } from "@/lib/data/types";

/**
 * Pure mirror of the database contract (pub.news_card_entries + web_api.news_cards). The synthetic-sample adapter and the
 * unit tests use it so the website is exercised against the SAME semantics as production:
 *   - a Bluepost reply is visible only with complete verified-staff provenance (fail closed);
 *   - one card per region/topic (thread), represented by the latest verified official post;
 *   - ordering by the latest verified OFFICIAL activity, never by ordinary replies or the forum's last_posted_at;
 *   - original publication timestamps are never modified.
 */
export interface NewsEntrySource extends NewsEntry {
  suppressedAt?: string | null;
  status?: "published" | "review" | "rejected";
  authorUserId?: number | null;
  authorGroup?: string | null;
  /** Fixture escape hatch kept from V1: false marks a record that was never in the authoritative feed. */
  authoritative?: boolean;
}

const FUTURE_TOLERANCE_MS = 15 * 60_000;

export const officialAt = (entry: Pick<NewsEntry, "publishedAt" | "officialUpdatedAt">): string =>
  entry.officialUpdatedAt && entry.officialUpdatedAt > entry.publishedAt ? entry.officialUpdatedAt : entry.publishedAt;

export function entryKindOf(entry: Pick<NewsEntry, "sourcePostNumber" | "threadOrigin">): NewsEntryKind {
  if (entry.sourcePostNumber == null) return "article";
  if (entry.sourcePostNumber === 1) return "announcement";
  return entry.threadOrigin === "official" ? "official_update" : "staff_reply";
}

export function isVisibleNewsEntry(entry: NewsEntrySource, now: Date): boolean {
  if (entry.authoritative === false) return false;
  if (entry.status && entry.status !== "published") return false;
  if (entry.suppressedAt) return false;
  if (entry.sourceType === "bluepost") {
    const isReply = (entry.sourcePostNumber ?? 0) > 1;
    const verifiedReply = isReply && entry.authorUserId != null && !!entry.authorGroup && !!entry.threadOrigin;
    if (!(entry.sourcePostNumber === 1 || verifiedReply)) return false;
  }
  return Date.parse(officialAt(entry)) <= now.getTime() + FUTURE_TOLERANCE_MS;
}

const byActivity = (a: NewsEntry, b: NewsEntry) => officialAt(b).localeCompare(officialAt(a)) || b.id - a.id;

export interface NewsCardOptions {
  category?: NewsQuery["category"];
  query?: string;
  region?: NewsQuery["region"];
  featuredFirst?: boolean;
  now?: Date;
}

export function buildNewsCards(entries: NewsEntrySource[], options: NewsCardOptions = {}): NewsEntry[] {
  const now = options.now ?? new Date();
  const text = (options.query ?? "").trim().toLowerCase();
  const threads = new Map<string, NewsEntrySource[]>();
  for (const entry of entries.filter((candidate) => isVisibleNewsEntry(candidate, now))) {
    const key = entry.threadKey ?? `entry:${entry.id}`;
    threads.set(key, [...(threads.get(key) ?? []), entry]);
  }
  const cards: NewsEntry[] = [];
  for (const members of threads.values()) {
    const ordered = [...members].sort(byActivity);
    const rep = ordered[0]!;
    if (options.category && rep.category !== options.category) continue;
    if (options.region && rep.region !== options.region) continue;
    if (text && !members.some((member) => `${member.title} ${member.excerpt}`.toLowerCase().includes(text))) continue;
    const openerDates = members.filter((member) => member.sourcePostNumber === 1).map((member) => member.publishedAt).sort();
    const firstDates = members.map((member) => member.publishedAt).sort();
    cards.push({
      ...rep,
      featured: members.some((member) => member.featured),
      importance: Math.max(...members.map((member) => member.importance)),
      threadPublishedAt: openerDates[0] ?? firstDates[0] ?? rep.publishedAt,
      officialUpdatedAt: officialAt(rep),
      updateCount: members.length,
      entryKind: entryKindOf(rep),
    });
  }
  return cards.sort((a, b) => options.featuredFirst
    ? Number(b.featured) - Number(a.featured) || b.importance - a.importance || byActivity(a, b)
    : byActivity(a, b));
}

export function threadUpdates(entries: NewsEntrySource[], slug: string, now = new Date()): NewsEntry | null {
  const visible = entries.filter((entry) => isVisibleNewsEntry(entry, now));
  const target = visible.find((entry) => entry.slug === slug);
  if (!target) return null;
  const key = target.threadKey ?? `entry:${target.id}`;
  const members = visible.filter((entry) => (entry.threadKey ?? `entry:${entry.id}`) === key).sort(byActivity);
  const openers = members.filter((member) => member.sourcePostNumber === 1).map((member) => member.publishedAt).sort();
  return {
    ...target,
    officialUpdatedAt: officialAt(target),
    threadPublishedAt: openers[0] ?? members.map((member) => member.publishedAt).sort()[0] ?? target.publishedAt,
    updateCount: members.length,
    entryKind: entryKindOf(target),
    updates: members.slice(0, 10).map((member) => ({
      slug: member.slug, postNumber: member.sourcePostNumber, canonicalUrl: member.canonicalUrl, publishedAt: member.publishedAt,
      officialUpdatedAt: officialAt(member), author: member.author, entryKind: entryKindOf(member),
    })),
  };
}
