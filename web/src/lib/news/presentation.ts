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

export function cleanNewsExcerpt(value: string, maxLength = 180): string {
  const normalized = decodeNewsEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\[[^\]]*…\]/g, "[…]")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= maxLength) return normalized;

  const words = normalized.split(" ");
  let result = "";
  for (const word of words) {
    const candidate = result ? `${result} ${word}` : word;
    if (candidate.length > maxLength) break;
    result = candidate;
  }
  if (result) return /…$|\[…\]$/.test(result) ? result : `${result.replace(/[\s,;:]+$/, "")}…`;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}
