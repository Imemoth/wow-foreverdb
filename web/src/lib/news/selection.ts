import type { NewsEntry } from "@/lib/data/types";
import { entryKindOf, officialAt } from "@/lib/news/cards";

const byActivity = (a: NewsEntry, b: NewsEntry) => officialAt(b).localeCompare(officialAt(a)) || b.id - a.id;

/**
 * One homepage candidate per region/topic, represented by its latest verified official post. The database already returns
 * one card per thread; this stays as defence in depth and for older rows without thread context.
 */
function groupThreads(entries: NewsEntry[]): NewsEntry[] {
  const grouped = new Map<string, NewsEntry>();
  for (const entry of entries) {
    const key = entry.threadKey ?? `entry:${entry.id}`;
    const current = grouped.get(key);
    if (!current) { grouped.set(key, entry); continue; }
    const winner = byActivity(entry, current) < 0 ? entry : current;
    grouped.set(key, { ...winner, featured: winner.featured || entry.featured || current.featured, importance: Math.max(winner.importance, entry.importance, current.importance) });
  }
  return [...grouped.values()].sort(byActivity);
}

/**
 * A Bluepost is displayable only as an authoritative opener or as a reply the database marked with verified provenance
 * (a thread origin). A reply WITHOUT that marker is never displayable, whatever its author name says.
 */
function displayable(entries: NewsEntry[]): NewsEntry[] {
  return entries.filter((entry) => {
    if (entry.sourceType !== "bluepost" && entry.category !== "bluepost") return true;
    if (entry.sourcePostNumber === 1) return true;
    const kind = entry.entryKind ?? entryKindOf(entry);
    return (kind === "official_update" || kind === "staff_reply") && entry.threadOrigin != null;
  });
}

export function selectHomepageNews(entries: NewsEntry[], limit = 3): { featured: NewsEntry | null; recent: NewsEntry[] } {
  const visible = displayable(entries);
  const candidates = groupThreads(visible).sort((a, b) =>
    Number(b.featured) - Number(a.featured) || b.importance - a.importance || byActivity(a, b));
  const featured = candidates[0] ?? null;
  const recent = groupThreads(visible)
    .filter((entry) => entry.id !== featured?.id)
    .sort(byActivity)
    .slice(0, Math.max(0, limit));
  return { featured, recent };
}
