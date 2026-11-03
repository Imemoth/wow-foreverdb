export const CATEGORY_ICON_IDS = ["items", "creatures", "quests", "zones", "mining", "herbalism", "fishing", "professions"] as const;
export type CategoryIconId = (typeof CATEGORY_ICON_IDS)[number];

/**
 * One of the eight illustrated category icons (public/icons/<id>.webp) - see
 * docs/azerdex-card-art/provenance.md for sourcing. Only "items", "creatures",
 * "mining", "herbalism", "fishing" and "zones" are wired into real navigation today
 * (ENTRY_POINTS in page.tsx); "quests" and "professions" have no backing route yet
 * and are intentionally unused until one exists.
 *
 * Plain <img>, not next/image, for the same reason as FeatureCard: this app sets
 * `images.unoptimized: true` site-wide, and this is rendered by a server component,
 * so any inline `style` attribute next/image would add (it always adds one) would be
 * blocked by this site's CSP (style-src with no 'unsafe-inline'). Sizing comes from a
 * literal Tailwind class, never a computed style value, for the same reason.
 */
export function CategoryIcon({ id, className = "h-12 w-12 sm:h-14 sm:w-14" }: { id: CategoryIconId; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see doc comment above
    <img src={`/icons/${id}.webp`} alt="" aria-hidden="true" loading="lazy" className={`shrink-0 ${className}`} />
  );
}
