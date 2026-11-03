import type { NewsEntry } from "@/lib/data/types";

const byPublished = (a: NewsEntry, b: NewsEntry) =>
  b.publishedAt.localeCompare(a.publishedAt) || b.id - a.id;

/** Collapse Bluepost replies into one homepage candidate per region/topic. */
function groupThreads(entries: NewsEntry[]): NewsEntry[] {
  const grouped = new Map<string, NewsEntry>();
  for (const entry of entries) {
    const key = entry.threadKey ?? `entry:${entry.id}`;
    const current = grouped.get(key);
    if (!current || byPublished(entry, current) < 0 || (entry.featured && !current.featured)) grouped.set(key, entry);
  }
  return [...grouped.values()].sort(byPublished);
}

function publishedBluepostsOnly(entries: NewsEntry[]): NewsEntry[] {
  return entries.filter((entry) =>
    entry.sourceType !== "bluepost" && entry.category !== "bluepost"
      || entry.sourcePostNumber === 1,
  );
}

export function selectHomepageNews(entries: NewsEntry[], limit = 3): { featured: NewsEntry | null; recent: NewsEntry[] } {
  const visible = publishedBluepostsOnly(entries);
  const candidates = groupThreads(visible).sort((a, b) =>
    Number(b.featured) - Number(a.featured) || b.importance - a.importance || byPublished(a, b));
  const featured = candidates[0] ?? null;
  const recent = groupThreads(visible)
    .filter((entry) => entry.id !== featured?.id)
    .sort(byPublished)
    .slice(0, Math.max(0, limit));
  return { featured, recent };
}
