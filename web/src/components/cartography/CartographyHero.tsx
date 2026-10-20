import type { ReactNode } from "react";
import { ArcaneSurveyBanner } from "./ArcaneSurveyBanner";

/**
 * Full-bleed cinematic hero for the Database and Zones landing pages (P2-A visual polish),
 * built on the exact same technique as the Guides/News/Blog hub heroes
 * (components/content/ArticleHub.tsx): a breakout wrapper div, the existing ArcaneSurveyBanner SVG
 * mounted as a permanent fallback layer, an owner-supplied photo on top via a <picture> with a
 * separately art-directed mobile crop, `.hero-vignette` + an extra darkening scrim (globals.css)
 * for title legibility, and `.hero-fade-bottom` to blend into the page below. Left-aligned title,
 * same breadcrumb-precedes-hero placement as the other hubs (so no negative margin-top / no
 * `.hero-bleed`, same reasoning as GuidesLibrary.tsx).
 *
 * Unlike the content hubs, Database and Zones are functional pages, not landing/reading pages -
 * `compact` (Database) keeps the hero shallow so the search form stays close to the fold; Zones
 * (the default, taller) serves primarily as an exploration directory and can afford more scale.
 * zone/[id] detail pages intentionally do NOT use this component - they keep the existing
 * contained CartographyBanner, per the explicit "restrained, not another tall hero on every
 * data-heavy page" requirement.
 */
export function CartographyHero({
  variant, compact, eyebrow, eyebrowIcon, children,
}: {
  variant: "database" | "zones";
  compact?: boolean;
  eyebrow: string;
  eyebrowIcon: string;
  children: ReactNode;
}) {
  const photo = HERO_PHOTO[variant];
  return (
    <div className="relative left-1/2 w-screen -ml-[50vw]">
      <section
        className={`relative flex flex-col justify-center overflow-hidden bg-ink-950 ${
          compact
            ? "min-h-[260px] py-8 sm:min-h-[300px] sm:py-10 lg:min-h-[340px]"
            : "min-h-[360px] py-10 sm:min-h-[420px] sm:py-14 lg:min-h-[480px] lg:py-16"
        }`}
      >
        <ArcaneSurveyBanner />
        <picture>
          <source media="(max-width: 639px)" srcSet={photo.mobileSrc} />
          <img
            src={photo.desktopSrc}
            alt=""
            aria-hidden="true"
            className={`absolute inset-0 h-full w-full object-cover ${HERO_PHOTO_POSITION[variant]}`}
          />
        </picture>
        <div className="hero-vignette" />
        {/* Extra darkening scrim for the title zone once a busy photo sits behind it - same
            technique as the content hubs' hero, which needs it for the same reason. */}
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950/85 via-ink-950/35 to-ink-950/15" />
        <div className="hero-fade-bottom" />
        <div className="relative z-10 mx-auto w-full max-w-7xl px-4">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em] text-violet-300">
            {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
            <img src={eyebrowIcon} alt="" aria-hidden="true" className="h-5 w-5 sm:h-6 sm:w-6" />
            {eyebrow}
          </p>
          {children}
        </div>
      </section>
    </div>
  );
}

/**
 * Owner-supplied cinematic hero photography (P2-A visual polish round). Desktop/tablet serve the
 * full 1916x821 frame; mobile gets a separately cropped file that keeps each scene's focal point
 * in view - the Database archive's glass display cases and glowing armillary spheres sit on the
 * left third of the frame, and the Zones vista's floating-island/waterfall cluster plus both moons
 * sit left-of-center, so both mobile crops are left-weighted rather than a blind center crop (the
 * same rationale as the News/Blog hero crops). See docs/azerdex-database-zones-art/provenance.md.
 */
const HERO_PHOTO: Record<"database" | "zones", { desktopSrc: string; mobileSrc: string }> = {
  database: { desktopSrc: "/database/database-arcane-archive-hero.webp", mobileSrc: "/database/database-arcane-archive-hero-mobile.webp" },
  zones: { desktopSrc: "/zones/zones-arcane-cartography-hero.webp", mobileSrc: "/zones/zones-arcane-cartography-hero-mobile.webp" },
};

/** Two fixed literal classes, not a template-interpolated arbitrary value - Tailwind's JIT scanner
    needs static source text to pick up an arbitrary `object-[...]` value. */
const HERO_PHOTO_POSITION: Record<"database" | "zones", string> = {
  database: "object-[22%_42%]",
  zones: "object-[32%_38%]",
};
