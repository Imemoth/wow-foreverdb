import { ArcaneSurveyBanner } from "@/components/cartography/ArcaneSurveyBanner";
import { medallionFor } from "@/components/cartography/zoneMedallion";
import { fmtInt } from "@/lib/format";
import { heroPositionClass } from "@/lib/maps/hero-position";
import type { ResolvedZoneArtwork } from "@/lib/maps/zone-artwork";

/** Real figures from the public read model, or null when none exist (never 0 by assumption). */
export interface ZoneHeroStats { sources: number; items: number; locatedObservations: number }

interface Props {
  zoneName: string;
  /** Verified continent / region label, when known. */
  region?: string | null;
  /** "Zone" or "City". */
  kindLabel?: string;
  description?: string | null;
  stats: ZoneHeroStats | null;
  artwork: ResolvedZoneArtwork;
}

/**
 * Central, data-driven hero of every zone page (replaces the contained banner + three stat tiles).
 * Pure presentation: the internal uiMapID is deliberately NOT rendered here. Artwork comes from
 * lib/maps/zone-artwork.ts (cinematic -> atlas map -> vector fallback); zones never get their own component.
 */
export function ZoneCinematicHero({ zoneName, region, kindLabel = "Zone", description, stats, artwork }: Props) {
  const eyebrow = [region, kindLabel].filter(Boolean).join(" · ");
  const items: { label: string; value: number | undefined }[] = [
    { label: "Sources", value: stats?.sources },
    { label: "Items (inferred)", value: stats?.items },
    { label: "Located obs.", value: stats?.locatedObservations },
  ];
  return (
    <section
      aria-labelledby="zone-hero-title"
      data-testid="zone-hero"
      data-artwork={artwork.kind}
      className="relative isolate flex min-h-[340px] flex-col justify-end overflow-hidden rounded-2xl border border-violet-400/30 bg-ink-950 shadow-[inset_0_0_0_1px_rgb(217_185_120/0.16),0_8px_32px_rgb(7_9_28/0.5)] sm:min-h-[400px] lg:min-h-[440px]"
    >
      <ArcaneSurveyBanner />
      <HeroImage artwork={artwork} />
      {/* Legibility: bottom scrim on small screens (text sits over the lower image), left-to-right dark gradient from sm up. */}
      <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-t from-ink-950/95 via-ink-950/55 to-ink-950/5 sm:hidden" />
      <div aria-hidden="true" className="absolute inset-0 hidden bg-gradient-to-r from-ink-950/95 via-ink-950/60 via-45% to-transparent to-80% sm:block" />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-ink-950/70 to-transparent" />
      <Ornaments />

      <div className="relative z-10 flex flex-col gap-3 px-4 pb-5 pt-24 sm:gap-4 sm:px-8 sm:pb-8 lg:px-10">
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
          <img src={medallionFor(zoneName)} alt="" aria-hidden="true" width={40} height={40}
            className="h-9 w-9 shrink-0 rounded-full border border-gold-500/60 bg-ink-900/70 object-cover p-1.5 shadow-[0_0_14px_rgb(155_116_230/0.45)] sm:h-11 sm:w-11" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-violet-300 sm:text-xs">{eyebrow}</p>
        </div>
        <div className="max-w-3xl">
          <h1 id="zone-hero-title" className="break-words font-[family-name:var(--font-display)] text-[1.9rem] font-bold leading-[1.1] text-gold-300 [text-shadow:0_2px_18px_rgb(7_9_28/0.85)] sm:text-5xl lg:text-6xl">
            {zoneName}
          </h1>
          <div aria-hidden="true" className="mt-3 flex items-center gap-2 text-gold-500/80 sm:mt-4">
            <span className="h-px w-full max-w-[22rem] bg-gradient-to-r from-gold-500/70 via-gold-500/40 to-transparent" />
            <span className="h-1.5 w-1.5 shrink-0 rotate-45 border border-gold-400" />
          </div>
          {description && <p className="mt-3 max-w-2xl text-sm leading-relaxed text-parchment sm:text-lg">{description}</p>}
        </div>
        <dl className="mt-1 grid grid-cols-3 gap-x-3 sm:mt-3 sm:flex sm:gap-0" aria-label={`${zoneName} statistics`}>
          {items.map((it, i) => (
            <div key={it.label} className={`flex min-w-0 flex-col justify-between sm:pr-8 ${i > 0 ? "sm:border-l sm:border-gold-500/30 sm:pl-8" : ""}`}>
              <dt className="text-[10px] font-semibold uppercase leading-tight tracking-[0.16em] text-mist sm:text-xs sm:tracking-[0.2em]">{it.label}</dt>
              <dd className="mt-1 font-[family-name:var(--font-display)] text-2xl font-semibold tabular-nums text-gold-300 sm:text-4xl">
                {it.value == null ? (<><span aria-hidden="true">–</span><span className="sr-only">Not available</span></>) : fmtInt(it.value)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function HeroImage({ artwork }: { artwork: ResolvedZoneArtwork }) {
  if (artwork.kind === "cinematic") {
    const { desktop, mobile, intrinsic, objectPosition } = artwork.art;
    const set = (l: typeof desktop) => l.map((s) => `${s.src} ${s.width}w`).join(", ");
    return (
      <picture>
        <source media="(max-width: 639px)" srcSet={set(mobile)} sizes="100vw" />
        {/* next/image is unoptimized site-wide, so the art-directed srcset is authored here */}
        <img
          src={desktop[desktop.length - 1]!.src}
          srcSet={set(desktop)}
          sizes="(min-width: 1280px) 1232px, 100vw"
          width={intrinsic.width}
          height={intrinsic.height}
          alt=""
          aria-hidden="true"
          fetchPriority="high"
          decoding="async"
          className={`absolute inset-0 h-full w-full object-cover ${heroPositionClass(objectPosition) ?? "object-center"}`}
        />
      </picture>
    );
  }
  if (artwork.kind === "map") {
    // The zone's own atlas map as a mood layer: enlarged, soft and darkened so a flat map never reads as cinematic art.
    return (
      // eslint-disable-next-line @next/next/no-img-element -- CDN atlas asset (validated host), decorative here
      <img src={artwork.src} width={artwork.width} height={artwork.height} alt="" aria-hidden="true" decoding="async"
        className="absolute inset-0 h-full w-full scale-110 object-cover opacity-45 blur-[3px] saturate-[.7]" />
    );
  }
  return null; // fallback: the ArcaneSurveyBanner backdrop is already the background
}

/** Discreet fantasy ornaments: compass rose (top-left) and a few stars. Static, decorative, no animation. */
function Ornaments() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 400 200" preserveAspectRatio="xMinYMin meet"
      className="pointer-events-none absolute left-0 top-0 hidden h-44 w-[22rem] text-gold-400/45 sm:block">
      <g fill="none" stroke="currentColor" strokeWidth="1">
        <circle cx="110" cy="100" r="64" opacity=".5" />
        <circle cx="110" cy="100" r="40" opacity=".7" />
        <path d="M110 22v156M32 100h156" opacity=".45" />
        <path d="M110 58l18 42-18 42-18-42z" strokeWidth="1.5" />
        <path d="M-10 70C120 20 260 24 420 78" opacity=".3" />
      </g>
      <g fill="currentColor" opacity=".8">
        <circle cx="30" cy="40" r="1.5" /><circle cx="214" cy="46" r="1.2" /><circle cx="262" cy="20" r="1.5" /><circle cx="186" cy="150" r="1" />
      </g>
    </svg>
  );
}
