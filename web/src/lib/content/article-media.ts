import type { Section } from "./loader";

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
