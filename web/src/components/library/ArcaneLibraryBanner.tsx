/**
 * Original, vector-only "Arcane Library" hero artwork for the Guides landing page - an archive
 * alcove motif (an arched nook, a floating knowledge-seal rune circle, scattered glowing tomes)
 * in the same technique and illustration palette as ArcaneSurveyBanner.tsx (P2-A) and the
 * homepage hero (hero/themes.ts): plain inline SVG gradients/paths, no raster image, no
 * third-party or Blizzard-derived artwork. Purely decorative chrome, never a coordinate surface.
 *
 * Respects prefers-reduced-motion trivially: nothing here is ever animated. If the SVG fails to
 * render for any reason, the wrapping banner's own gradient background (set directly on the
 * container in GuidesLibrary.tsx) is the graceful fallback.
 */
export function ArcaneLibraryBanner({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1400 420"
      preserveAspectRatio="xMidYMid slice"
      focusable="false"
      aria-hidden="true"
      className={`absolute inset-0 h-full w-full ${className}`}
    >
      <defs>
        <radialGradient id="al-glow" cx="50%" cy="38%" r="55%">
          <stop offset="0%" stopColor="#8B5CF6" stopOpacity="0.38" />
          <stop offset="55%" stopColor="#8B5CF6" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#8B5CF6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="al-base" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0%" stopColor="#0D0F33" />
          <stop offset="100%" stopColor="#07091C" />
        </linearGradient>
        <linearGradient id="al-fade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#07091C" stopOpacity="0" />
          <stop offset="70%" stopColor="#07091C" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#07091C" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id="al-tome" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#D9B978" />
          <stop offset="100%" stopColor="#A78BFA" />
        </linearGradient>
      </defs>

      <rect x="0" y="0" width="1400" height="420" fill="url(#al-base)" />
      <circle cx="700" cy="150" r="320" fill="url(#al-glow)" />

      {/* Archive alcove: a tall, receding arch suggesting shelved stacks either side, never meant
          to read as an architectural blueprint - just enough structure to frame the knowledge seal. */}
      <g stroke="#D9B978" strokeOpacity="0.18" strokeWidth="1.4" fill="none">
        <path d="M60 420V170 Q60 70 160 60 L220 60 Q300 60 300 160 V420" />
        <path d="M1340 420V170 Q1340 70 1240 60 L1180 60 Q1100 60 1100 160 V420" />
        <path d="M130 420V210 Q130 140 190 135 V420" />
        <path d="M1270 420V210 Q1270 140 1210 135 V420" />
      </g>
      {/* Shelf lines inside each alcove pillar - faint horizontal ticks, evoking stacked volumes
          without drawing literal book spines. */}
      <g stroke="#A78BFA" strokeOpacity="0.14" strokeWidth="1">
        {[110, 160, 210, 260, 310, 360].map((y) => (
          <g key={y}>
            <line x1="65" y1={y} x2="295" y2={y} />
            <line x1="1105" y1={y} x2="1335" y2={y} />
          </g>
        ))}
      </g>

      {/* Knowledge seal: a large rune circle centered on the banner, the same visual family as the
          compass medallion in ArcaneSurveyBanner.tsx, recontextualised as an arcane archive mark. */}
      <g transform="translate(700 190)" opacity="0.85">
        <circle r="108" fill="none" stroke="#D9B978" strokeOpacity="0.4" strokeWidth="1.5" />
        <circle r="108" fill="none" stroke="#A78BFA" strokeOpacity="0.18" strokeWidth="8" />
        <circle r="78" fill="none" stroke="#D9B978" strokeOpacity="0.3" strokeWidth="1" strokeDasharray="2 6" />
        <g stroke="#D9B978" strokeOpacity="0.5" strokeWidth="1.5" strokeLinecap="round">
          <path d="M0 -108v20M0 88v20M-108 0h20M88 0h20" />
          <path d="M-76 -76l14 14M62 62l14 14M76 -76l-14 14M-62 62l-14 14" />
        </g>
        <path d="M0 -40 28 0 0 40 -28 0z" fill="none" stroke="#A78BFA" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M0 -20 12 0 0 20 -12 0z" fill="#A78BFA" fillOpacity="0.55" />
      </g>

      {/* Floating tomes - simple closed-book glyphs (cover + spine + a small rune mark), drifting
          at irregular heights around the seal; the only figurative "library" motif in the scene. */}
      {[
        { x: 300, y: 110, s: 1, o: 0.55 },
        { x: 1080, y: 150, s: 0.85, o: 0.5 },
        { x: 430, y: 290, s: 0.75, o: 0.45 },
        { x: 960, y: 300, s: 0.9, o: 0.5 },
        { x: 220, y: 320, s: 0.6, o: 0.35 },
        { x: 1160, y: 260, s: 0.65, o: 0.4 },
      ].map((t, i) => (
        <g key={i} transform={`translate(${t.x} ${t.y}) scale(${t.s})`} opacity={t.o}>
          <rect x="-22" y="-16" width="44" height="32" rx="3" fill="url(#al-tome)" fillOpacity="0.9" />
          <rect x="-22" y="-16" width="44" height="32" rx="3" fill="none" stroke="#07091C" strokeOpacity="0.4" strokeWidth="1" />
          <line x1="0" y1="-16" x2="0" y2="16" stroke="#07091C" strokeOpacity="0.35" strokeWidth="1.5" />
          <circle cx="0" cy="0" r="3.2" fill="#07091C" fillOpacity="0.5" />
        </g>
      ))}

      {/* Scattered ambient points - same irregular, never-a-real-coordinate treatment as
          ArcaneSurveyBanner.tsx's survey points. */}
      <g fill="#E7C98A" opacity="0.45">
        <circle cx="520" cy="70" r="1.6" /><circle cx="880" cy="90" r="1.3" /><circle cx="640" cy="340" r="1.5" />
        <circle cx="780" cy="370" r="1.2" /><circle cx="360" cy="190" r="1.4" /><circle cx="1020" cy="200" r="1.3" />
      </g>

      <rect x="0" y="0" width="1400" height="420" fill="url(#al-fade)" />
    </svg>
  );
}
