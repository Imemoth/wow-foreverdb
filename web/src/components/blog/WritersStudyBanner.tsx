/**
 * Original, vector-only "Writer's Sanctuary" hero artwork for the Blog landing page - a warm
 * study nook: an arched window with candlelight, a writing desk silhouette with an open book,
 * quill and inkwell, and drifting loose pages. Same technique and illustration palette as
 * ArcaneLibraryBanner.tsx (P2-B) and ArcaneSurveyBanner.tsx (P2-A): plain inline SVG
 * gradients/paths, no raster image, no third-party or Blizzard-derived artwork. No owner-supplied
 * Blog photography exists in this repository (see docs/azerdex-news-blog-art/provenance.md) -
 * this banner is the original-vector fallback already established by P2-A, not a placeholder for
 * one. Purely decorative chrome, never a coordinate surface.
 *
 * Differentiated from both the Library (violet archive alcove) and News (cool blue-violet signal
 * tower) by a warm candlelight-amber glow and an intimate, grounded desk composition, so News and
 * Blog read as distinct places at a glance while sharing the same dark-fantasy language.
 */
export function WritersStudyBanner({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1400 420"
      preserveAspectRatio="xMidYMid slice"
      focusable="false"
      aria-hidden="true"
      className={`absolute inset-0 h-full w-full ${className}`}
    >
      <defs>
        <radialGradient id="ws-glow" cx="50%" cy="34%" r="55%">
          <stop offset="0%" stopColor="#E7A95A" stopOpacity="0.34" />
          <stop offset="55%" stopColor="#D9B978" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#D9B978" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ws-base" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#191A47" />
          <stop offset="100%" stopColor="#07091C" />
        </linearGradient>
        <linearGradient id="ws-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#07091C" stopOpacity="0" />
          <stop offset="70%" stopColor="#07091C" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#07091C" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id="ws-page" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F3E7C9" />
          <stop offset="100%" stopColor="#D9B978" />
        </linearGradient>
        <radialGradient id="ws-candle" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#FFE9B3" stopOpacity="0.95" />
          <stop offset="60%" stopColor="#E7A95A" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#E7A95A" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x="0" y="0" width="1400" height="420" fill="url(#ws-base)" />
      <circle cx="700" cy="160" r="300" fill="url(#ws-glow)" />

      {/* Arched window, centered, warm light pooling inside it. */}
      <g stroke="#D9B978" strokeOpacity="0.22" strokeWidth="1.4" fill="none">
        <path d="M560 420V210 Q560 90 700 90 Q840 90 840 210 V420" />
        <path d="M600 420V215 Q600 120 700 120 Q800 120 800 215 V420" />
      </g>
      <path d="M600 420V215 Q600 120 700 120 Q800 120 800 215 V420 Z" fill="#E7A95A" opacity="0.08" />
      {/* Window mullions. */}
      <g stroke="#D9B978" strokeOpacity="0.16" strokeWidth="1">
        <line x1="700" y1="120" x2="700" y2="420" />
        <line x1="600" y1="280" x2="800" y2="280" />
      </g>

      {/* Bookshelves flanking the window, faint stacked-volume ticks (same device as the Library banner). */}
      <g stroke="#A78BFA" strokeOpacity="0.14" strokeWidth="1">
        {[130, 175, 220, 265, 310, 355].map((y) => (
          <g key={y}>
            <line x1="90" y1={y} x2="500" y2={y} />
            <line x1="900" y1={y} x2="1310" y2={y} />
          </g>
        ))}
      </g>

      {/* Desk silhouette in the foreground, with an open book, quill and inkwell. */}
      <g transform="translate(700 420)">
        <path d="M-260 0 L-260 -36 L260 -36 L260 0 Z" fill="#14163D" />
        <path d="M-230 -36 L-230 -70 L230 -70 L230 -36 Z" fill="#191A47" />
        {/* Open book. */}
        <path d="M-60 -70 Q-60 -92 -4 -88 L-4 -70 Z" fill="url(#ws-page)" opacity="0.92" />
        <path d="M60 -70 Q60 -92 4 -88 L4 -70 Z" fill="url(#ws-page)" opacity="0.92" />
        <line x1="-4" y1="-70" x2="4" y2="-70" stroke="#07091C" strokeOpacity="0.4" strokeWidth="1" />
        {/* Inkwell + quill. */}
        <ellipse cx="96" cy="-66" rx="10" ry="6" fill="#0D0F33" stroke="#A78BFA" strokeOpacity="0.5" strokeWidth="1" />
        <path d="M100 -70 L128 -112" stroke="#D9B978" strokeWidth="2" strokeLinecap="round" />
        <path d="M128 -112 l10 -14 l-4 16 z" fill="#D9B978" />
        {/* Candle. */}
        <rect x="-108" y="-96" width="10" height="26" rx="2" fill="#F3E7C9" opacity="0.85" />
        <circle cx="-103" cy="-100" r="16" fill="url(#ws-candle)" />
        <circle cx="-103" cy="-100" r="3" fill="#FFE9B3" />
      </g>

      {/* Drifting loose pages, irregular placement, amber-gold. */}
      <g fill="url(#ws-page)" opacity="0.55">
        <rect x="260" y="140" width="28" height="36" rx="2" transform="rotate(-12 274 158)" />
        <rect x="1080" y="190" width="26" height="34" rx="2" transform="rotate(10 1093 207)" />
        <rect x="200" y="260" width="24" height="30" rx="2" transform="rotate(8 212 275)" />
      </g>

      <rect x="0" y="0" width="1400" height="420" fill="url(#ws-fade)" />
    </svg>
  );
}
