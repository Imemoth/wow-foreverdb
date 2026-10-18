import { ArcaneSurveyBanner } from "./ArcaneSurveyBanner";

/**
 * Contained (not full-bleed) decorative header strip for Zones, Zone detail and Database -
 * these are data pages inside the shared `max-w-7xl` layout, not landing pages, so unlike the
 * homepage hero this never breaks out of that container. `compact` is the explicit requirement
 * for /database ("no giant homepage-style hero"); the taller default suits the Zones pages'
 * more "distinctive" banner while staying far short of the homepage hero's scale.
 */
export function CartographyBanner({ children, compact }: { children: React.ReactNode; compact?: boolean }) {
  return (
    <div className={`relative overflow-hidden rounded-xl border border-ink-700 ${compact ? "h-28 sm:h-32" : "h-44 sm:h-56"}`}>
      <ArcaneSurveyBanner />
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950/85 via-ink-950/20 to-transparent" />
      <div className="relative z-10 flex h-full flex-col justify-end p-4 sm:p-6">{children}</div>
    </div>
  );
}
