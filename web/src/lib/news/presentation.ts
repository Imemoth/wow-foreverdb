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
