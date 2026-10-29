import type { RaceGuide } from "@/lib/races/types";
import { FACTION_LABEL, formatDate } from "@/lib/races/format";
import { RACE_ART_SIZE, RACE_HERO_POSITION, RACE_HERO_SIZES, raceArt } from "@/lib/races/art";
import { FACTION_STYLE } from "./faction-style";

/**
 * Illustrated banner at the top of a race page, built the way ClassHero is: the race illustration fills a clipped hero (the right
 * half on desktop, fading into the dark on its left edge; a poster-shaped block above the text on phones), and the name, faction,
 * summary and latest update sit on a dark gradient on the left (desktop) or on solid dark below the picture (phones), so the text never
 * lies on the busy picture.
 * The picture is decorative; the faction colour stays as the accent border.
 */
export function RaceHero({ guide, isNewRace }: { guide: RaceGuide; isNewRace: boolean }) {
  const s = FACTION_STYLE[guide.faction];
  const art = raceArt(guide.slug);
  return (
    <header
      className={`relative isolate flex flex-col overflow-hidden rounded-xl border border-l-4 bg-ink-950 shadow-xl sm:min-h-[26rem] sm:justify-center lg:min-h-[28rem] ${s.border}`}
      data-testid="race-hero"
      data-faction={guide.faction}
      data-race={guide.slug}
    >
      {/* The picture. Phones: a poster-shaped block above the text, so no text is ever laid over the artwork. From sm: the right half of
          the banner, fading into the dark on its left edge. */}
      <div className="relative aspect-[5/6] w-full overflow-hidden sm:absolute sm:inset-y-0 sm:right-0 sm:-z-10 sm:aspect-auto sm:w-1/2">
        {/* eslint-disable-next-line @next/next/no-img-element -- static same-origin asset; responsive srcset without next/image's inline styles (page CSP) */}
        <img
          src={art.src}
          srcSet={art.srcSet}
          sizes={RACE_HERO_SIZES}
          alt=""
          aria-hidden="true"
          width={RACE_ART_SIZE.width}
          height={RACE_ART_SIZE.height}
          loading="eager"
          fetchPriority="high"
          decoding="async"
          draggable={false}
          data-testid="race-hero-art"
          className={`h-full w-full object-cover sm:[mask-image:linear-gradient(to_right,transparent,black_30%)] ${RACE_HERO_POSITION[guide.slug] ?? "object-top"}`}
        />
        {/* Phones: the bottom of the picture melts into the text block. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-ink-950 to-transparent sm:hidden" />
      </div>
      {/* From sm: protects the text on the left; the character's face stays untouched. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 -z-10 hidden w-3/5 bg-gradient-to-r from-ink-950/95 via-ink-950/75 to-transparent sm:block" />
      <div className="relative max-w-xl space-y-3 px-6 pb-6 pt-1 sm:max-w-md sm:p-10 lg:max-w-lg">
        <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.25em]">
          <span className={s.text}>{FACTION_LABEL[guide.faction]}</span>
          {isNewRace && <span className="rounded border border-violet-400/60 px-1.5 py-0.5 tracking-wider text-violet-300">New race in Forever</span>}
        </p>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-bold leading-tight text-parchment [text-shadow:0_2px_12px_rgb(0_0_0/0.8)] sm:text-5xl">{guide.name}</h1>
        <p className="text-parchment/90 [text-shadow:0_1px_6px_rgb(0_0_0/0.9)]">{guide.summary}</p>
        <p className="text-sm text-mist [text-shadow:0_1px_6px_rgb(0_0_0/0.9)]">
          {guide.latestUpdate ? <>Latest documented change: <time dateTime={guide.latestUpdate} className="text-parchment">{formatDate(guide.latestUpdate)}</time>.</> : "No changes documented since the earliest published definitions."}
        </p>
      </div>
    </header>
  );
}
