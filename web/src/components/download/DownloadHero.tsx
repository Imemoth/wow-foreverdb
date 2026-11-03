import type { ReactNode } from "react";

/**
 * Full-bleed cinematic hero for /download (P2-E), built on the exact same technique as
 * CartographyHero.tsx / ArticleHub.tsx: a breakout wrapper, a permanent inline-SVG
 * fallback mounted underneath (always rendered, so there is never a broken-image state
 * even if the photo fails to load), the owner-supplied photo on top via <picture> with a
 * separately art-directed mobile crop, `.hero-vignette`/`.hero-fade-bottom` plus an extra
 * darkening scrim, and left-aligned title/eyebrow typography. See
 * docs/azerdex-download-art/provenance.md for the photo's provenance and the fallback's
 * own design rationale.
 */
export function DownloadHero({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <div className="relative left-1/2 w-screen -ml-[50vw]">
      <section className="relative flex min-h-[360px] flex-col justify-center overflow-hidden bg-ink-950 py-10 sm:min-h-[440px] sm:py-14 lg:min-h-[500px] lg:py-16">
        <ArcaneInstallationFallback />
        <picture>
          <source media="(max-width: 639px)" srcSet="/download/download-arcane-chamber-hero-mobile.webp" />
          <img
            src="/download/download-arcane-chamber-hero.webp"
            alt=""
            aria-hidden="true"
            className="absolute inset-0 h-full w-full object-cover object-[50%_45%]"
          />
        </picture>
        <div className="hero-vignette" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink-950/85 via-ink-950/35 to-ink-950/15" />
        <div className="hero-fade-bottom" />
        <div className="relative z-10 mx-auto w-full max-w-7xl px-4">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.3em] text-violet-300">
            {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
            <img src="/icons/items.webp" alt="" aria-hidden="true" className="h-5 w-5 sm:h-6 sm:w-6" />
            {eyebrow}
          </p>
          {children}
        </div>
      </section>
    </div>
  );
}

/**
 * Permanent decorative fallback, always mounted underneath the photo (same layering as
 * ArcaneSurveyBanner/ArcaneLibraryBanner): an original inline-SVG scene - a symmetrical
 * arcane installation chamber with a central light column and violet conduit pillars,
 * echoing the owner photo's composition without reproducing it - so the hero never shows
 * a broken image if the photo fails to load, and still reads as "on brand" on its own.
 */
function ArcaneInstallationFallback() {
  return (
    <svg
      viewBox="0 0 1400 460"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="dl-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0c0e2e" />
          <stop offset="100%" stopColor="#07091c" />
        </linearGradient>
        <linearGradient id="dl-beam" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#c3aef2" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#6c41c7" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="dl-pillar" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#9b74e6" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#9b74e6" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <rect width="1400" height="460" fill="url(#dl-bg)" />
      {/* central descending light column */}
      <rect x="668" y="0" width="64" height="460" fill="url(#dl-beam)" />
      {/* paired violet conduit pillars, symmetrical */}
      {[120, 260, 1020, 1160].map((x) => (
        <rect key={x} x={x} y="40" width="26" height="420" fill="url(#dl-pillar)" rx="13" />
      ))}
      {/* arch silhouettes */}
      <g stroke="#3d3570" strokeWidth="2" fill="none" opacity="0.6">
        <path d="M60 460 V220 Q60 120 180 120 Q300 120 300 220 V460" />
        <path d="M1100 460 V220 Q1100 120 1220 120 Q1340 120 1340 220 V460" />
      </g>
      {/* floor rings */}
      <g stroke="#6c41c7" strokeOpacity="0.35" fill="none">
        <ellipse cx="700" cy="440" rx="260" ry="26" />
        <ellipse cx="700" cy="440" rx="180" ry="18" />
      </g>
      {/* scattered gold accent points */}
      {[[150, 90], [1250, 100], [200, 380], [1200, 380], [700, 60]].map(([cx, cy]) => (
        <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="2.4" fill="#e8cf8f" opacity="0.8" />
      ))}
    </svg>
  );
}
