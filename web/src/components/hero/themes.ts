export const HERO_THEMES = ["arcane-ruins", "violet-moon", "floating-city"] as const;
export type HeroTheme = (typeof HERO_THEMES)[number];

export const HERO_THEME_STORAGE_KEY = "azerdex-hero-theme";

export function isHeroTheme(value: unknown): value is HeroTheme {
  return typeof value === "string" && (HERO_THEMES as readonly string[]).includes(value);
}
