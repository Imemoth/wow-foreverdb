/**
 * Original, vector-only "Arcane Survey" decorative banner - a calm cartography motif
 * (compass medallion, flowing survey arcs, a scattering of survey points) for the Zones,
 * Zone detail and Database page headers. Same technique and illustration palette as the
 * homepage hero art (hero/themes.ts): plain inline SVG gradients/paths, no raster image,
 * no third-party or Blizzard-derived artwork - see docs/web/arcane-cartography-phase2a.md
 * for the provenance note. This is purely decorative chrome: it carries no geographic
 * claim about any real zone and is never used as a coordinate surface (LocationPlot's
 * own in-SVG treatment, not this component, is what sits behind observation markers).
 *
 * Respects prefers-reduced-motion trivially: nothing here is ever animated.
 */
export function ArcaneSurveyBanner({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1200 260"
      preserveAspectRatio="xMidYMid slice"
      focusable="false"
      aria-hidden="true"
      className={`absolute inset-0 h-full w-full ${className}`}
    >
      <defs>
        <radialGradient id="cg-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.32" />
          <stop offset="60%" stopColor="#8B5CF6" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="cg-base" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#0D0F33" />
          <stop offset="100%" stopColor="#07091C" />
        </linearGradient>
        <linearGradient id="cg-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#07091C" stopOpacity="0" />
          <stop offset="100%" stopColor="#07091C" stopOpacity="0.65" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="1200" height="260" fill="url(#cg-base)" />
      <circle cx="960" cy="90" r="220" fill="url(#cg-glow)" />

      {/* Flowing survey arcs - a calm nod to latitude lines on an old atlas, never meant to read as a real map. */}
      <g stroke="#D9B978" strokeOpacity="0.22" strokeWidth="1.2" fill="none">
        <path d="M-40 60 Q 300 10 640 70 T 1260 40" />
        <path d="M-40 140 Q 320 90 660 150 T 1260 120" />
        <path d="M-40 220 Q 340 170 680 230 T 1260 200" />
      </g>

      {/* Compass medallion, left of center: outer ring, cardinal ticks, inner rune diamond - the
          same visual family as the main wordmark (Logo.tsx) at a larger, ambient scale. */}
      <g transform="translate(190 130)" opacity="0.8">
        <circle r="78" fill="none" stroke="#D9B978" strokeOpacity="0.45" strokeWidth="1.5" />
        <circle r="78" fill="none" stroke="#A78BFA" strokeOpacity="0.2" strokeWidth="6" />
        <g stroke="#D9B978" strokeOpacity="0.55" strokeWidth="1.5" strokeLinecap="round">
          <path d="M0 -78v16M0 62v16M-78 0h16M62 0h16" />
          <path d="M-55 -55l11 11M44 44l11 11M55 -55l-11 11M-44 44l-11 11" />
        </g>
        <path d="M0 -34 22 0 0 34 -22 0z" fill="none" stroke="#A78BFA" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M0 -18 10 0 0 18 -10 0z" fill="#A78BFA" fillOpacity="0.6" />
      </g>

      {/* Scattered survey points - deliberately irregular, never aligned to any real coordinate. */}
      <g fill="#E7C98A" opacity="0.5">
        <circle cx="420" cy="55" r="1.6" /><circle cx="520" cy="180" r="1.3" /><circle cx="700" cy="60" r="1.5" />
        <circle cx="810" cy="190" r="1.2" /><circle cx="900" cy="150" r="1.7" /><circle cx="1040" cy="200" r="1.3" />
        <circle cx="1120" cy="70" r="1.5" /><circle cx="330" cy="150" r="1.2" />
      </g>

      <rect x="0" y="0" width="1200" height="260" fill="url(#cg-fade)" />
    </svg>
  );
}
