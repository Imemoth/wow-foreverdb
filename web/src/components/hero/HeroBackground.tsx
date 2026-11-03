import { HeroThemeScript } from "./HeroThemeScript";
import { heroDataAttributes } from "./themes";

/**
 * Three original, vector-only atmospheric backdrops (no painted/photographic artwork,
 * nothing derived from Blizzard key art) for the session-rotating hero. Every layer is
 * absolutely positioned and hidden by default; HeroThemeScript sets data-hero-theme on
 * this wrapper, and plain CSS (.hero-theme-layer rules in globals.css) shows the match.
 * If JS never runs, no layer becomes visible and the hero's own fallback gradient
 * (set directly on the <section>, unconditionally) is what the visitor sees - that is
 * the required safe fallback, not an error state. heroDataAttributes carries the theme
 * list/storage key in as plain (React-escaped) HTML attributes for HeroThemeScript's
 * fixed script to read back - see themes.ts and HeroThemeScript.tsx for why.
 */
export function HeroBackground({ nonce }: { nonce: string | undefined }) {
  return (
    <div className="hero-bg" aria-hidden="true" {...heroDataAttributes}>
      <HeroThemeScript nonce={nonce} />
      <div className="hero-theme-layer hero-theme-layer--arcane-ruins">
        <ArcaneRuinsArt />
      </div>
      <div className="hero-theme-layer hero-theme-layer--violet-moon">
        <VioletMoonArt />
      </div>
      <div className="hero-theme-layer hero-theme-layer--floating-city">
        <FloatingCityArt />
      </div>
    </div>
  );
}

function ArcaneRuinsArt() {
  return (
    <svg viewBox="0 0 1200 500" preserveAspectRatio="xMidYMax slice" focusable="false">
      <defs>
        <radialGradient id="ar-crystal" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#C4B5FD" stopOpacity="0.95" />
          <stop offset="60%" stopColor="#8B5CF6" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ar-fog" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0D0F33" stopOpacity="0" />
          <stop offset="100%" stopColor="#07091C" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      {/* distant ruin spires */}
      <g fill="#13153f" opacity="0.8">
        <path d="M420 500V330l18-30 16 30v170zM470 500V300l14-26 14 26v200zM700 500V340l16-28 16 28v160zM745 500V310l12-22 12 22v190z" />
      </g>
      {/* broken archway, left */}
      <path d="M0 500V260c40-10 70-40 90-90 8-20 14-20 22 0 16 44 40 76 78 90v240H160V300c-18 24-40 40-60 48v152z" fill="#191A47" />
      <path d="M90 170c8-20 14-20 22 0" stroke="#D9B978" strokeOpacity="0.7" strokeWidth="2" fill="none" />
      {/* broken archway, right */}
      <path d="M1200 500V310c-36-8-62-36-80-80-7-18-13-18-20 0-16 42-38 72-74 86v184H960V330c16 18 34 30 50 36v134z" fill="#191A47" />
      <path d="M1040 230c7-18 13-18 20 0" stroke="#D9B978" strokeOpacity="0.7" strokeWidth="2" fill="none" />
      {/* floating crystal glows */}
      <circle cx="150" cy="220" r="26" fill="url(#ar-crystal)" />
      <circle cx="1060" cy="260" r="20" fill="url(#ar-crystal)" />
      <circle cx="600" cy="150" r="16" fill="url(#ar-crystal)" opacity="0.8" />
      <rect x="0" y="0" width="1200" height="500" fill="url(#ar-fog)" />
    </svg>
  );
}

function VioletMoonArt() {
  return (
    <svg viewBox="0 0 1200 500" preserveAspectRatio="xMidYMax slice" focusable="false">
      <defs>
        <radialGradient id="vm-moon" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#F3EDE2" stopOpacity="0.95" />
          <stop offset="45%" stopColor="#C4B5FD" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="vm-fog" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0D0F33" stopOpacity="0" />
          <stop offset="100%" stopColor="#07091C" stopOpacity="0.85" />
        </linearGradient>
      </defs>
      <g fill="#F3EDE2" opacity="0.55">
        <circle cx="140" cy="70" r="1.4" /><circle cx="260" cy="110" r="1.1" /><circle cx="330" cy="60" r="1.6" />
        <circle cx="520" cy="90" r="1.1" /><circle cx="780" cy="55" r="1.4" /><circle cx="900" cy="100" r="1.1" />
        <circle cx="1020" cy="70" r="1.6" /><circle cx="1140" cy="120" r="1.2" /><circle cx="60" cy="150" r="1.1" />
      </g>
      <circle cx="830" cy="150" r="150" fill="url(#vm-moon)" />
      <circle cx="830" cy="150" r="70" fill="#C4B5FD" opacity="0.5" />
      {/* distant skyline */}
      <g fill="#13153f">
        <path d="M0 500V380l40-10 10-20 10 20 40 10v120zM120 500V340l24-34 22 34v160zM300 500V400l16-18 16 18v100zM560 500V360l20-26 20 26v140zM900 500V420l14-16 14 16v80zM1040 500V350l22-30 20 30v150zM1180 500V400l16-18 16 18v100z" />
      </g>
      <rect x="0" y="0" width="1200" height="500" fill="url(#vm-fog)" />
    </svg>
  );
}

function FloatingCityArt() {
  return (
    <svg viewBox="0 0 1200 500" preserveAspectRatio="xMidYMax slice" focusable="false">
      <defs>
        <radialGradient id="fc-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#E7C98A" stopOpacity="0.55" />
          <stop offset="55%" stopColor="#8B5CF6" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="fc-beam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#A78BFA" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#A78BFA" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="fc-fog" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0D0F33" stopOpacity="0" />
          <stop offset="100%" stopColor="#07091C" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <circle cx="600" cy="190" r="200" fill="url(#fc-glow)" />
      {/* light beams */}
      <rect x="300" y="60" width="4" height="220" fill="url(#fc-beam)" />
      <rect x="860" y="90" width="3" height="190" fill="url(#fc-beam)" />
      {/* bridges */}
      <path d="M160 300 Q 420 230 620 260" stroke="#D9B978" strokeOpacity="0.5" strokeWidth="1.5" fill="none" />
      <path d="M620 260 Q 860 210 1060 280" stroke="#D9B978" strokeOpacity="0.5" strokeWidth="1.5" fill="none" />
      {/* floating islands */}
      <g fill="#13153f">
        <path d="M60 330 140 300 230 320 210 360 90 365z" />
        <path d="M150 300V260l8-14 8 14v40z" />
        <path d="M480 270 600 235 730 265 700 310 510 312z" />
        <path d="M600 235V180l12-20 12 20v55z" />
        <path d="M960 340 1050 305 1150 330 1125 375 985 378z" />
        <path d="M1050 305V260l10-16 10 16v45z" />
      </g>
      <rect x="0" y="0" width="1200" height="500" fill="url(#fc-fog)" />
    </svg>
  );
}
