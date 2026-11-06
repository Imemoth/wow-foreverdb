import type { NewsCategory, NewsEntry, NewsSourceType } from "@/lib/data/types";

export type NewsVisualVariant = "bluepost" | "official" | "editorial";
export type NewsRegionFilter = "all" | "us" | "eu";

export function getNewsVisualVariant(entry: Pick<{ category: NewsCategory; sourceType: NewsSourceType }, "category" | "sourceType">): NewsVisualVariant {
  if (entry.category === "bluepost" || entry.sourceType === "bluepost") return "bluepost";
  if (entry.category === "official_news" || entry.sourceType === "official_news" || entry.category === "patch_notes") return "official";
  return "editorial";
}

export function filterNewsByRegion(entries: NewsEntry[], region: NewsRegionFilter): NewsEntry[] {
  return region === "all" ? entries : entries.filter((entry) => entry.region === region);
}

const ENTITY_REPLACEMENTS: Record<string, string> = {
  "&amp;": "&",
  "&hellip;": "…",
  "&#8230;": "…",
  "&#x2026;": "…",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

function decodeNewsEntities(value: string): string {
  return value.replace(/&(?:amp|hellip|lt|gt|quot);|&#(?:8230|x2026|39);/gi, (entity) => {
    const replacement = ENTITY_REPLACEMENTS[entity.toLowerCase()];
    return replacement ?? entity;
  });
}

/** Normalize stored source text without applying a card-preview length limit. */
export function normalizeNewsExcerpt(value: string): string {
  return decodeNewsEntities(value)
    .replace(/<[^>]*>/g, " ")
    // Some upstream fragments start with a bracket and an encoded ellipsis but
    // never close the bracket. Remove that broken fragment before presentation.
    .replace(/\[[^\]\r\n]*(?:…|\.\.\.)\s*\]/g, "...")
    .replace(/\[[^\]\r\n]*(?:…|\.\.\.)/g, "...")
    .replace(/\[[^\]\r\n]*$/g, "...")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanNewsExcerpt(value: string, maxLength = 180): string {
  const limit = Math.max(1, maxLength);
  const normalized = normalizeNewsExcerpt(value);
  if (normalized.length <= limit) return normalized;
  if (limit <= 3) return normalized.slice(0, limit);

  const clipped = normalized.slice(0, limit - 3).trimEnd();
  if (clipped.endsWith("...")) return clipped;
  const boundary = clipped.lastIndexOf(" ");
  const readable = boundary > 0 ? clipped.slice(0, boundary) : clipped;
  return `${readable.replace(/[\s,;:]+$/, "")}...`;
}

const HOUR_MS = 3_600_000;

/**
 * The three dates a card can show, kept separate: when the topic was first posted, when its latest VERIFIED official post/edit
 * happened, and whether that is a meaningful update (more than an hour after the original). Ingestion time is never shown.
 */
export function newsDates(entry: Pick<NewsEntry, "publishedAt" | "officialUpdatedAt" | "threadPublishedAt">): { original: string; latest: string; updated: boolean } {
  const latest = entry.officialUpdatedAt && entry.officialUpdatedAt > entry.publishedAt ? entry.officialUpdatedAt : entry.publishedAt;
  const original = entry.threadPublishedAt && entry.threadPublishedAt < entry.publishedAt ? entry.threadPublishedAt : entry.publishedAt;
  return { original, latest, updated: Date.parse(latest) - Date.parse(original) > HOUR_MS };
}

export function newsKindLabel(entry: Pick<NewsEntry, "category" | "entryKind">, base: string): string {
  if (entry.entryKind === "official_update") return "OFFICIAL UPDATE";
  if (entry.entryKind === "staff_reply") return "STAFF REPLY";
  return base;
}

const REGION_NAMES: Record<string, string> = { us: "US", eu: "EU", global: "Global" };

/** "Regions: EU · US" for a story shared by several regions, "US only" / "EU only" for a single-region Blizzard post, "" otherwise. */
export function newsRegionLabel(entry: Pick<NewsEntry, "region" | "regions" | "category">): string {
  const regions = (entry.regions && entry.regions.length ? entry.regions : [entry.region]).filter((r) => r !== "global");
  if (regions.length > 1) return `Regions: ${regions.map((r) => REGION_NAMES[r] ?? r.toUpperCase()).join(" · ")}`;
  if (regions.length === 1 && entry.category === "bluepost") return `${REGION_NAMES[regions[0]!] ?? regions[0]!.toUpperCase()} only`;
  return regions.length === 1 ? (REGION_NAMES[regions[0]!] ?? regions[0]!.toUpperCase()) : "";
}

export const isGlobalStory = (entry: Pick<NewsEntry, "regions">): boolean => (entry.regions?.filter((r) => r !== "global").length ?? 0) > 1;
export const regionName = (region: string): string => REGION_NAMES[region] ?? region.toUpperCase();
