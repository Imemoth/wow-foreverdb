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
 * Phase 2 integration point: per-theme optimized/responsive artwork, supplied by the
 * owner separately (never generated or substituted here, and no reference image is
 * committed to this repo). `null` = no owner-approved asset yet, so HeroBackground's
 * original SVG/gradient art for that theme stays the only thing rendered - it is a
 * permanent fallback, not a placeholder that needs removing later.
 *
 * To wire in an approved image once supplied: drop the optimized file under
 * `public/hero/<theme>.<ext>` (e.g. an AVIF/WebP with a sensible max width for a
 * full-bleed hero) and set that theme's entry below to `/hero/<theme>.<ext>`. Nothing
 * else changes - HeroImageLayer.tsx picks it up, next/image handles responsive
 * sizing/optimization, and the SVG layer keeps rendering underneath as the fallback
 * (no-JS, slow/failed image load, or a theme with no asset configured yet).
 */
export const HERO_ASSET_SRC: Record<HeroTheme, string | null> = {
  "arcane-ruins": null,
  "violet-moon": null,
  "floating-city": null,
};
