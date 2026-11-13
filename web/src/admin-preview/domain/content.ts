import type { ArticleSnapshot, Classification } from "./types";

export const CATEGORIES = ["Announcements", "Data & Methodology", "Community", "Patch Notes", "Maintenance"] as const;
export const RESERVED_SLUGS = ["entry", "rss.xml", "new", "admin", "api"];

export interface MediaAsset { id: string; label: string; rightsVerified: boolean; provenance: string; tone: "violet" | "gold" | "teal" | "grey" }
/** Synthetic media library. No real image is stored or fetched; tiles are rendered with CSS only. */
export const MEDIA: MediaAsset[] = [
  { id: "media-compass", label: "Arcane compass — original AzerDex art", rightsVerified: true, provenance: "Original AzerDex artwork, owner-licensed", tone: "gold" },
  { id: "media-ember-vale", label: "Ember Vale panorama — original render", rightsVerified: true, provenance: "Original AzerDex render, attribution recorded", tone: "violet" },
  { id: "media-forum-shot", label: "Community forum screenshot", rightsVerified: false, provenance: "Third-party screenshot — rights NOT verified", tone: "grey" },
];
export const mediaById = (id: string | null): MediaAsset | undefined => MEDIA.find((m) => m.id === id);

export const effectiveClassification = (s: Pick<ArticleSnapshot, "classification" | "featured">): Classification =>
  s.featured || s.classification === "highlighted" ? "highlighted" : "normal";

export const emptySnapshot = (byline: string): ArticleSnapshot => ({
  title: "", summary: "", body: "", byline, category: CATEGORIES[0], tags: [], classification: "normal", featured: false,
  coverMediaId: null, coverAlt: "", seoDescription: "",
});

export function normalizeSnapshot(s: ArticleSnapshot): ArticleSnapshot {
  const featured = Boolean(s.featured);
  const classification: Classification = featured || s.classification === "highlighted" ? "highlighted" : "normal";
  const tags = [...new Set(s.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
  return {
    title: s.title.trim(), summary: s.summary.trim(), body: s.body.replace(/\r\n/g, "\n").trimEnd(), byline: s.byline.trim(),
    category: s.category, tags, classification, featured,
    coverMediaId: s.coverMediaId || null, coverAlt: s.coverMediaId ? s.coverAlt.trim() : "", seoDescription: s.seoDescription.trim(),
  };
}

/** Pre-submit / pre-publish validation. Returns field -> message; an empty object means valid. */
export function validateSnapshot(s: ArticleSnapshot): Record<string, string> {
  const e: Record<string, string> = {};
  if (s.title.length < 8) e.title = "Title needs at least 8 characters.";
  else if (s.title.length > 120) e.title = "Title must be 120 characters or fewer.";
  if (s.summary.length < 20) e.summary = "Summary needs at least 20 characters.";
  else if (s.summary.length > 280) e.summary = "Summary must be 280 characters or fewer.";
  if (s.body.length < 80) e.body = "Body needs at least 80 characters of Markdown.";
  else if (/<\s*script|javascript:|<\s*iframe|\son\w+\s*=/i.test(s.body)) e.body = "Raw HTML and unsafe links are not allowed in Markdown.";
  if (s.byline.length < 2) e.byline = "Byline is required.";
  if (!(CATEGORIES as readonly string[]).includes(s.category)) e.category = "Choose a category.";
  if (s.tags.length > 8) e.tags = "Use at most 8 tags.";
  else if (s.tags.some((t) => !/^[a-z0-9][a-z0-9-]{0,23}$/.test(t))) e.tags = "Tags are lowercase letters, digits and hyphens (max 24 characters).";
  if (s.seoDescription.length > 160) e.seoDescription = "SEO description must be 160 characters or fewer.";
  if (s.coverMediaId) {
    const m = mediaById(s.coverMediaId);
    if (!m) e.coverMediaId = "Unknown media asset.";
    else if (!m.rightsVerified) e.coverMediaId = "This asset's usage rights and provenance are not verified, so it cannot be used (ADM-03A V1: rights-cleared images only).";
    else if (s.coverAlt.length < 8) e.coverAlt = "Alt text is required for cover media (at least 8 characters).";
  }
  return e;
}

/** Fields that can be checked while a draft is still being typed (a draft may be incomplete). */
export function validateSlug(slug: string, taken: (s: string) => boolean): string | null {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return "Slug: lowercase letters, digits and single hyphens only.";
  if (slug.length < 3 || slug.length > 80) return "Slug must be 3–80 characters.";
  if (RESERVED_SLUGS.includes(slug)) return `"${slug}" is a reserved route segment.`;
  if (taken(slug)) return "This slug is already reserved by another article. Slugs are permanent.";
  return null;
}
