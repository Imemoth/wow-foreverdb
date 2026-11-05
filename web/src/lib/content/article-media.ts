import type { Article, Section } from "./loader";

export interface CardImage {
  src: string;
  wideSrc: string;
}

/**
 * Full-bleed hub hero photos (P2-C visual polish). Desktop/tablet serve the full frame; mobile
 * gets a separately cropped, left-weighted file that keeps each scene's focal instrument (the
 * News observatory's armillary sphere; the Blog desk's candles/quill/inkwell) in view instead of
 * relying on CSS object-position alone to rescue a crop that was composed for a 2.33:1 frame - see
 * docs/azerdex-news-blog-art/provenance.md for the source and crop rationale. The SVG banners
 * (NewsObservatoryBanner / WritersStudyBanner) stay mounted underneath as the permanent fallback
 * layer, exactly like GuidesLibrary.tsx's photo-over-SVG technique.
 */
export const HUB_HERO_PHOTO: Record<"news" | "blog", { desktopSrc: string; mobileSrc: string }> = {
  news: { desktopSrc: "/news/news-observatory-hero.webp", mobileSrc: "/news/news-observatory-hero-mobile.webp" },
  blog: { desktopSrc: "/blog/blog-writers-study-hero.webp", mobileSrc: "/blog/blog-writers-study-hero-mobile.webp" },
};

/**
 * Content-specific card art: tied to one exact article by slug, because the image depicts that
 * article's actual subject (a fantasy cartography/arcane-database desk scene for the
 * website-preview announcement) rather than generic decoration. Never reused for a different
 * article even if it is also marked `featured` - using it elsewhere would misrepresent that
 * article's content.
 */
export const SLUG_FEATURED_IMAGE: Record<string, CardImage> = {
  "introducing-foreverdb-web": { src: "/news/news-featured-card.webp", wideSrc: "/news/news-featured-wide.webp" },
};

/**
 * Generic decorative spotlight art per section, used by ArticleSpotlight.tsx whenever exactly one
 * unfiltered article is visible. Unlike SLUG_FEATURED_IMAGE this is not tied to any one article's
 * content - the illustration is explicitly decorative (a candlelit writing desk), so it stays
 * correct no matter which single Blog article happens to be the only one published.
 */
export const SECTION_SPOTLIGHT_IMAGE: Partial<Record<Section, CardImage>> = {
  blog: { src: "/blog/blog-featured-card.webp", wideSrc: "/blog/blog-featured-wide.webp" },
};

/**
 * Small per-category medallion icons. All four reuse existing, already-approved medallions from
 * public/library/medallions/ (P2-B's medallion sheet) rather than the near-duplicate crops
 * supplied alongside this round's asset package - see docs/azerdex-news-blog-art/provenance.md
 * for the side-by-side comparison that found them to be the same source art. A category with no
 * entry here simply renders without a medallion rather than guessing one.
 */
export const CATEGORY_MEDALLION: Record<string, string> = {
  "ForeverDB development": "/library/medallions/chronicle.webp",
  Companion: "/library/medallions/wayfinder.webp",
  Engineering: "/library/medallions/cartography.webp",
  Editorial: "/library/medallions/inkwell.webp",
};

/**
 * Responsive variants of an article's frontmatter `cover` (the 1920x1080 hero master). They are listed per slug,
 * not derived from the file name, so a typo fails a unit test (tests/unit/article-cover.test.ts checks that every
 * file exists with the documented dimensions) instead of silently shipping a broken <img>.
 *
 *  - `mobileSrc`: 810x1080 portrait crop around the focal subject, served below 640px.
 *  - `cardSrc`: 800x600 (4:3) thumbnail for hub cards.
 *  - `socialSrc`: 1200x630 crop for og:image / twitter:image.
 *  - `heroPosition`: object-position classes (phone first, then `sm:`) that keep the subject in frame when the
 *    hero is cropped to a short band. Literal class strings, because Tailwind's JIT needs static source text.
 *
 * Each image depicts that one article's subject: never reuse an entry for another article (same rule as
 * SLUG_FEATURED_IMAGE above). Source and rebuild steps: docs/azerdex-blog-articles-art/provenance.md.
 */
export interface ArticleCoverArt {
  mobileSrc: string;
  cardSrc: string;
  socialSrc: string;
  heroPosition: string;
}

export const COVER_MASTER_SIZE = { width: 1920, height: 1080 } as const;
export const COVER_MOBILE_SIZE = { width: 810, height: 1080 } as const;
export const COVER_CARD_SIZE = { width: 800, height: 600 } as const;
export const COVER_SOCIAL_SIZE = { width: 1200, height: 630 } as const;

export const SLUG_COVER_ART: Record<string, ArticleCoverArt> = {
  "wow-forever-beginners-guide-2026": {
    mobileSrc: "/content-images/blog/wow-forever-beginners-guide-2026-mobile.webp",
    cardSrc: "/content-images/blog/wow-forever-beginners-guide-2026-card.webp",
    socialSrc: "/content-images/blog/wow-forever-beginners-guide-2026-social.webp",
    heroPosition: "object-[50%_45%]",
  },
  "wow-forever-new-race-class-combinations": {
    mobileSrc: "/content-images/blog/wow-forever-new-race-class-combinations-mobile.webp",
    cardSrc: "/content-images/blog/wow-forever-new-race-class-combinations-card.webp",
    socialSrc: "/content-images/blog/wow-forever-new-race-class-combinations-social.webp",
    heroPosition: "object-[50%_15%] sm:object-[50%_40%]",
  },
};

export interface ArticleCoverImages {
  hero: { src: string; mobileSrc: string; alt: string; attribution: string; width: number; height: number; position: string };
  card: { src: string; alt: string; width: number; height: number };
  social: { src: string; width: number; height: number };
}

/**
 * Everything the reader, hub cards and metadata need to show an article's cover, or null when the article has none.
 * An article with a `cover` but no SLUG_COVER_ART entry still gets a hero from `cover.src` alone (the master is used
 * for the mobile, card and social slots too) rather than silently dropping its art.
 */
export function articleCoverImages(a: Pick<Article, "slug" | "cover">): ArticleCoverImages | null {
  if (!a.cover) return null;
  const art = SLUG_COVER_ART[a.slug];
  return {
    hero: {
      src: a.cover.src,
      mobileSrc: art?.mobileSrc ?? a.cover.src,
      alt: a.cover.alt,
      attribution: a.cover.attribution,
      ...COVER_MASTER_SIZE,
      position: art?.heroPosition ?? "object-center",
    },
    card: { src: art?.cardSrc ?? a.cover.src, alt: a.cover.alt, ...(art ? COVER_CARD_SIZE : COVER_MASTER_SIZE) },
    social: { src: art?.socialSrc ?? a.cover.src, ...(art ? COVER_SOCIAL_SIZE : COVER_MASTER_SIZE) },
  };
}
