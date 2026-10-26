export const HERO_THEMES = ["arcane-ruins", "violet-moon", "floating-city"] as const;
export type HeroTheme = (typeof HERO_THEMES)[number];

export const HERO_THEME_STORAGE_KEY = "azerdex-hero-theme";

export function isHeroTheme(value: unknown): value is HeroTheme {
  return typeof value === "string" && (HERO_THEMES as readonly string[]).includes(value);
}

/**
 * How HERO_THEMES/HERO_THEME_STORAGE_KEY reach the browser: as ordinary JSX string
 * attributes on .hero-bg (React HTML-escapes these on every render), read back at
 * runtime by HeroThemeScript's fixed script body - never interpolated into script
 * text. Keeping this next to the constants it serializes is what stops a future edit
 * from reintroducing the template-literal-into-dangerouslySetInnerHTML pattern.
 */
export const heroDataAttributes = {
  "data-hero-themes": JSON.stringify(HERO_THEMES),
  "data-hero-key": HERO_THEME_STORAGE_KEY,
} as const;

/**
 * Phase 2 integration point: per-theme artwork, pre-optimized as a static file (this
 * repo runs Next's image pipeline with `unoptimized: true` site-wide - see
 * HeroImageLayer.tsx). `null` would mean
 * no owner-approved asset yet, in which case HeroBackground's original SVG/gradient art
 * for that theme stays the only thing rendered - it remains a fully valid, permanent
 * fallback, not a placeholder that needs removing later (see HeroImageLayer.tsx and the
 * no-JS/failed-load/unconfigured-theme cases it covers).
 *
 * All three theme slots below are now filled with owner-approved, ChatGPT-generated
 * artwork (not Blizzard-sourced; see docs/azerdex-hero-art/provenance.md for the full
 * provenance record and the focused IP review that cleared them). To replace or add a
 * theme's asset later: drop the optimized file under `public/hero/<theme>.<ext>` and
 * update the entry below - see web/src/components/hero/README.md for the full
 * procedure, including the source-record retention step.
 */
export const HERO_ASSET_SRC: Record<HeroTheme, string | null> = {
  "arcane-ruins": "/hero/arcane-ruins.webp",
  "violet-moon": "/hero/violet-moon.webp",
  "floating-city": "/hero/floating-city.webp",
};

/**
 * CSS object-position per theme, so next/image's object-fit: cover crops toward each
 * image's actual focal point instead of a blind center-crop - e.g. violet-moon's moon
 * sits in the upper-right of the source image, not the center, so a center crop on a
 * narrow mobile viewport would cut it off entirely. One value per theme is used across
 * all viewport widths deliberately (object-fit: cover's crop window narrows evenly
 * around this anchor as the viewport narrows, so an upper-right anchor keeps the moon
 * in frame on both mobile and desktop rather than needing separate breakpoint values).
 */
export const HERO_IMAGE_FOCAL: Record<HeroTheme, string> = {
  // Ruin arches and glowing pillars sit left-of-center; keep them in frame.
  "arcane-ruins": "32% 48%",
  // The moon sits in the upper-right quadrant of the source image.
  "violet-moon": "76% 22%",
  // Fairly balanced left/right architecture; bias up to keep the sky ring/towers in frame.
  "floating-city": "50% 32%",
};
