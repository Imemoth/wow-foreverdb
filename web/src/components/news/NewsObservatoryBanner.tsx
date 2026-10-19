/**
 * Original, vector-only "Arcane Observatory" hero artwork for the News landing page - a signal
 * tower silhouette on a cliff, a lit beacon lens at its crown, and radiating dispatch rings
 * (the "news travels outward" motif), under a starfield. Same technique and illustration
 * palette as ArcaneLibraryBanner.tsx (P2-B) and ArcaneSurveyBanner.tsx (P2-A): plain inline SVG
 * gradients/paths, no raster image, no third-party or Blizzard-derived artwork. No owner-supplied
 * News photography exists in this repository (see docs/azerdex-news-blog-art/provenance.md) -
 * this banner is the original-vector fallback already established by P2-A, not a placeholder for
 * one. Purely decorative chrome, never a coordinate surface.
 *
 * Differentiated from the Library's violet archive-alcove treatment by a cooler, more clinical
 * blue-violet beacon glow and concentric "signal" rings instead of a static rune seal, so News and
 * Blog read as distinct places at a glance while sharing the same dark-fantasy language.
 */
export function NewsObservatoryBanner({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1400 420"
      preserveAspectRatio="xMidYMid slice"
      focusable="false"
      aria-hidden="true"
      className={`absolute inset-0 h-full w-full ${className}`}
    >
      <defs>
        <radialGradient id="ob-glow" cx="50%" cy="22%" r="60%">
          <stop offset="0%" stopColor="#8AB4F8" stopOpacity="0.4" />
          <stop offset="50%" stopColor="#6C41C7" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#6C41C7" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ob-base" x1="0" y1="0" x2="0.2" y2="1">
          <stop offset="0%" stopColor="#0D0F33" />
          <stop offset="100%" stopColor="#07091C" />
        </linearGradient>
        <linearGradient id="ob-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#07091C" stopOpacity="0" />
          <stop offset="70%" stopColor="#07091C" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#07091C" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id="ob-tower" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3B3F7A" />
          <stop offset="100%" stopColor="#191A47" />
        </linearGradient>
        <radialGradient id="ob-lens" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#F3E7C9" stopOpacity="0.95" />
          <stop offset="55%" stopColor="#D9B978" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#D9B978" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x="0" y="0" width="1400" height="420" fill="url(#ob-base)" />

      {/* Starfield - irregular, never a real constellation. */}
      <g fill="#E7C98A">
        {[
          [120, 50, 1.3, 0.5], [260, 95, 1, 0.35], [430, 40, 1.4, 0.45], [610, 80, 1, 0.3],
          [980, 55, 1.3, 0.4], [1110, 100, 1, 0.35], [1260, 45, 1.4, 0.5], [60, 150, 1, 0.3],
          [340, 130, 1.1, 0.35], [1340, 140, 1.1, 0.4],
        ].map(([cx, cy, r, o], i) => <circle key={i} cx={cx} cy={cy} r={r} opacity={o} />)}
      </g>

      {/* Distant cliff/horizon line the tower stands on. */}
      <path d="M0 420V300 Q260 260 520 290 T1000 280 T1400 300V420Z" fill="#0A0C28" opacity="0.9" />

      {/* Signal rings radiating from the beacon - the "dispatch" motif, concentric and fading. */}
      <g transform="translate(700 150)" fill="none" stroke="#8AB4F8">
        <circle r="60" opacity="0.28" strokeWidth="1.5" />
        <circle r="100" opacity="0.2" strokeWidth="1.5" />
        <circle r="145" opacity="0.14" strokeWidth="1.5" />
        <circle r="195" opacity="0.08" strokeWidth="1.5" />
      </g>
      <circle cx="700" cy="150" r="130" fill="url(#ob-glow)" />

      {/* Observatory / signal tower: a tapered shaft on a rocky base, a railed crown platform and
          the lit beacon lens at the top - figurative but simple, no literal architecture claim. */}
      <g transform="translate(700 0)">
        <path d="M-46 420 L-30 150 L30 150 L46 420 Z" fill="url(#ob-tower)" />
        <path d="M-30 150 L-18 60 L18 60 L30 150 Z" fill="url(#ob-tower)" />
        {/* Crown platform + railing. */}
        <rect x="-34" y="52" width="68" height="10" rx="2" fill="#4A4E8F" />
        <g stroke="#6468A6" strokeWidth="2" strokeLinecap="round">
          <line x1="-28" y1="52" x2="-28" y2="38" /><line x1="-12" y1="52" x2="-12" y2="38" />
          <line x1="4" y1="52" x2="4" y2="38" /><line x1="20" y1="52" x2="20" y2="38" />
          <line x1="-28" y1="38" x2="28" y2="38" />
        </g>
        {/* Beacon lens. */}
        <circle cy="22" r="26" fill="url(#ob-lens)" />
        <circle cy="22" r="10" fill="#F3E7C9" opacity="0.9" />
        {/* Window slits down the shaft, faintly lit. */}
        <g fill="#D9B978" opacity="0.35">
          <rect x="-5" y="110" width="10" height="20" rx="2" />
          <rect x="-5" y="200" width="10" height="24" rx="2" />
          <rect x="-5" y="300" width="10" height="24" rx="2" />
        </g>
      </g>

      {/* Flanking rock outcrops, same device as P2-A's survey banner for scene grounding. */}
      <g fill="#14163D" opacity="0.8">
        <path d="M0 420V330 Q90 300 180 335 T360 340 V420Z" />
        <path d="M1040 420V340 Q1140 300 1240 330 T1400 325 V420Z" />
      </g>

      {/* Two small drifting dispatch banderoles - a paper/parchment dispatch motif, abstract, no text. */}
      <g opacity="0.5">
        <path d="M250 180 q20 -10 40 0 l-6 22 q-14 -8 -28 0 z" fill="#D9B978" />
        <path d="M1120 210 q20 -10 40 0 l-6 22 q-14 -8 -28 0 z" fill="#A78BFA" />
      </g>

      <rect x="0" y="0" width="1400" height="420" fill="url(#ob-fade)" />
    </svg>
  );
}
