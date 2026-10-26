import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Addon & Companion — Coming Soon",
  description:
    "The ForeverDB Addon for World of Warcraft: Forever and the Windows Companion are coming soon to AzerDex.",
  alternates: { canonical: "/addon-companion" },
};

/**
 * Standalone "coming soon" landing page. Deliberately independent of the /download implementation
 * (no shared components, assets or data) so that page can stay untouched until the Addon and
 * Companion are actually released. By design this page offers no downloads, installer links,
 * progress indicators or launch dates.
 */
const PRODUCTS = [
  {
    id: "addon",
    name: "WoW Addon",
    tagline: "Capture your discoveries in-game.",
    points: [
      "Records loot from creatures, gathering nodes, fishing and chests",
      "Keeps an approximate position for every source on a coarse map grid",
      "Stays in the game: the addon itself never makes network requests",
    ],
    icon: "addon",
  },
  {
    id: "companion",
    name: "Windows Companion",
    tagline: "Connect your adventures to AzerDex.",
    points: [
      "Sends aggregated observation counters to AzerDex, never raw private data",
      "Lets you search the database and browse zones on your own computer",
      "Links your computer to your AzerDex account",
    ],
    icon: "companion",
  },
] as const;

export default function AddonCompanionPage() {
  return (
    <div className="hero-bleed">
      <section
        aria-labelledby="ac-title"
        className="relative flex min-h-[560px] flex-col overflow-hidden bg-ink-950 pb-12 pt-8 text-center sm:min-h-[660px] sm:pb-20 sm:pt-10"
      >
        <HeroScene />
        <div className="hero-vignette" />
        <div className="hero-fade-bottom" />
        <div className="relative z-10 mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-5 sm:px-10">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-gold-400">AzerDex / ForeverDB</p>
          <p className="rounded-full border border-violet-400/50 bg-ink-950/70 px-3 py-1 text-xs font-semibold uppercase tracking-[0.15em] text-parchment">In development</p>
        </div>
        <div className="relative z-10 mx-auto my-auto w-full max-w-4xl px-5 py-10 sm:px-10">
          <SwordsMark />
          <h1 id="ac-title" className="mt-5 font-[family-name:var(--font-display)] text-4xl font-bold leading-tight text-gold-300 drop-shadow-[0_2px_18px_rgba(108,65,199,0.55)] sm:text-6xl">
            Your next adventure is loading.
          </h1>
          <p className="mt-4 text-sm font-semibold uppercase tracking-[0.3em] text-violet-300 sm:text-base">Addon &amp; Companion</p>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-parchment sm:text-lg">
            We&apos;re crafting the tools that will bring your Azeroth discoveries together. Until they arrive,
            the AzerDex database is open to explore.
          </p>
          <p className="mx-auto mt-6 inline-flex items-center gap-2 rounded-full border border-gold-500/50 bg-ink-950/70 px-5 py-2 text-sm font-semibold uppercase tracking-[0.2em] text-gold-300">
            Coming Soon
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Link href="/database" className="btn-primary">Browse the AzerDex Database</Link>
            <Link href="/about/data" className="btn-ghost">How the data works</Link>
          </div>
        </div>
      </section>

      <div className="mx-auto w-full max-w-5xl space-y-10 px-4 pb-6 pt-4 sm:px-6">
        <section aria-labelledby="ac-planned-title">
          <div className="text-center">
            <h2 id="ac-planned-title" className="panel-title text-2xl sm:text-3xl">What is coming</h2>
            <div className="rule-ornament mx-auto mt-3 w-40" aria-hidden="true" />
            <p className="mx-auto mt-4 max-w-2xl text-sm text-mist">
              Two tools, one purpose: turn real play into the observed loot and gathering data shown on AzerDex.
              Everything below describes planned functionality and may change before release.
            </p>
          </div>
          <ul className="mt-6 grid gap-5 md:grid-cols-2">
            {PRODUCTS.map((p) => (
              <li key={p.id}>
                <article aria-labelledby={`ac-${p.id}-title`} className="panel relative h-full overflow-hidden p-6 text-left sm:p-7">
                  <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-violet-500/15 blur-2xl" aria-hidden="true" />
                  <div className="relative flex items-start justify-between gap-4">
                    <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-violet-400/40 bg-ink-900 text-violet-300">
                      <ProductIcon kind={p.icon} />
                    </span>
                    <span className="rounded-full border border-gold-500/40 bg-ink-950/60 px-3 py-1 text-xs font-semibold uppercase tracking-[0.15em] text-gold-300">
                      Coming Soon
                    </span>
                  </div>
                  <h3 id={`ac-${p.id}-title`} className="relative mt-5 font-[family-name:var(--font-display)] text-2xl font-bold text-gold-300">{p.name}</h3>
                  <p className="relative mt-2 text-base font-semibold text-parchment">{p.tagline}</p>
                  <ul className="relative mt-4 space-y-2.5 text-left text-sm text-mist">
                    {p.points.map((point) => (
                      <li key={point} className="flex gap-2.5">
                        <svg viewBox="0 0 16 16" className="mt-1 h-3 w-3 shrink-0 text-gold-400" aria-hidden="true" fill="currentColor">
                          <path d="M8 0l1.9 5.1L15 7l-5.1 1.9L8 14l-1.9-5.1L1 7l5.1-1.9z" />
                        </svg>
                        <span>{point}</span>
                      </li>
                    ))}
                  </ul>
                </article>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="ac-back-title" className="panel p-6 text-center sm:p-8">
          <h2 id="ac-back-title" className="panel-title text-xl">Meanwhile, in Azeroth</h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-mist">
            Search every item, creature and gathering node observed so far, with honest sample sizes.
          </p>
          <div className="mt-5 flex justify-center">
            <Link href="/database" className="btn-primary">Back to the AzerDex Database</Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function SwordsMark() {
  return (
    <svg viewBox="0 0 32 32" className="mx-auto h-14 w-14 text-gold-400 drop-shadow-[0_0_12px_rgba(217,185,120,0.45)]" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12.5 12.5M6 6l.6 4.6 3 .5M6 6l4.6.6.5 3" />
      <path d="M26 6L13.5 18.5M26 6l-.6 4.6-3 .5M26 6l-4.6.6-.5 3" />
      <path d="M17 19.5l-3.5 3.5M15 17.5l-3.5 3.5M12 23l-3.5 3.5 1.4 1.4L13.4 24.4M20 23l3.5 3.5-1.4 1.4L18.6 24.4" />
    </svg>
  );
}

function ProductIcon({ kind }: { kind: "addon" | "companion" }) {
  return (
    <svg viewBox="0 0 32 32" className="h-8 w-8" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      {kind === "addon" ? (
        <>
          {/* shield with a rune */}
          <path d="M16 4l9 3.4v7.2c0 5.6-3.7 9.6-9 13.4-5.3-3.8-9-7.8-9-13.4V7.4z" />
          <path d="M16 11l1.5 3 3.3.5-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.4-2.3 3.3-.5z" />
        </>
      ) : (
        <>
          {/* desktop monitor */}
          <rect x="4" y="6" width="24" height="16" rx="2.5" />
          <path d="M12 27h8M16 22v5" />
          <path d="M10 14h12" />
        </>
      )}
    </svg>
  );
}

/** Original, vector-only arcane gate scene (no photographic or Blizzard artwork), decorative only. */
function HeroScene() {
  return (
    <svg viewBox="0 0 1400 620" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ac-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0c0e2e" />
          <stop offset="55%" stopColor="#1a1450" />
          <stop offset="100%" stopColor="#07091c" />
        </linearGradient>
        <radialGradient id="ac-portal" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f0dfae" stopOpacity="0.95" />
          <stop offset="35%" stopColor="#c3aef2" stopOpacity="0.7" />
          <stop offset="100%" stopColor="#6c41c7" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ac-moon" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ece6d9" stopOpacity="0.9" />
          <stop offset="55%" stopColor="#c3aef2" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#9b74e6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ac-ridge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#191a47" />
          <stop offset="100%" stopColor="#0d0f33" />
        </linearGradient>
      </defs>
      <rect width="1400" height="620" fill="url(#ac-sky)" />
      {/* stars */}
      <g fill="#ece6d9" opacity="0.7">
        {[[110, 90, 1.6], [240, 150, 1.2], [380, 70, 1.8], [520, 130, 1.1], [860, 80, 1.5], [980, 160, 1.2], [1120, 60, 1.8], [1260, 140, 1.3], [1330, 70, 1.1], [60, 210, 1.2]].map(([cx, cy, r]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} />
        ))}
      </g>
      <circle cx="1130" cy="150" r="120" fill="url(#ac-moon)" />
      {/* distant ridges */}
      <path d="M0 470c90-60 170-110 260-80 80 28 130 90 220 60 100-34 150-120 260-110 100 9 150 70 250 60 110-12 180-90 410-20v280H0z" fill="url(#ac-ridge)" opacity="0.85" />
      {/* the arcane gate */}
      <circle cx="700" cy="330" r="230" fill="url(#ac-portal)" />
      <g stroke="#d9b978" strokeOpacity="0.8" fill="none" strokeWidth="3">
        <path d="M600 560V330c0-60 45-105 100-105s100 45 100 105v230" />
        <path d="M630 560V335c0-44 32-78 70-78s70 34 70 78v225" strokeOpacity="0.45" strokeWidth="2" />
      </g>
      <g stroke="#9b74e6" strokeOpacity="0.55" fill="none" strokeWidth="1.5">
        <circle cx="700" cy="330" r="150" strokeDasharray="4 10" />
        <circle cx="700" cy="330" r="190" strokeDasharray="2 14" />
      </g>
      {/* flanking spires with crystal tips */}
      {[{ x: 330, y: 360 }, { x: 1070, y: 380 }].map(({ x, y }) => (
        <g key={x}>
          <path d={`M${x - 28} 620V${y + 40}l28-70 28 70V620z`} fill="#13153f" />
          <path d={`M${x} ${y - 78}l12 22-12 22-12-22z`} fill="#c3aef2" opacity="0.9" />
          <circle cx={x} cy={y - 56} r="34" fill="url(#ac-portal)" opacity="0.55" />
        </g>
      ))}
      {/* foreground ground haze */}
      <rect y="520" width="1400" height="100" fill="#07091c" opacity="0.7" />
      <ellipse cx="700" cy="560" rx="320" ry="22" fill="none" stroke="#6c41c7" strokeOpacity="0.4" />
    </svg>
  );
}
