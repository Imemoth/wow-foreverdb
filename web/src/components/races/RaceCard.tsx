import Link from "next/link";
import type { RaceGuide } from "@/lib/races/types";
import { FACTION_LABEL } from "@/lib/races/format";
import { RACE_ART_SIZE, RACE_CARD_POSITION, RACE_CARD_SIZES, raceArt } from "@/lib/races/art";
import { racePath } from "@/lib/races/registry";
import { FACTION_STYLE } from "./faction-style";

/**
 * One race card: the portrait illustration is the dominant element, shown at its own 3:4 (no crop) with a dark information footer
 * below it, so no text ever sits on the character. The race name's link is stretched over the whole card (the class chips are plain
 * text, so no link nests in another); the picture is decorative because the name next to it already identifies the destination.
 */
export function RaceCard({ guide, isNewRace }: { guide: RaceGuide; isNewRace: boolean }) {
  const s = FACTION_STYLE[guide.faction];
  const art = raceArt(guide.slug);
  return (
    <li
      className={`group relative flex flex-col overflow-hidden rounded-xl border border-t-2 bg-ink-900 shadow-lg transition-[border-color,box-shadow] duration-300 hover:shadow-xl has-[:focus-visible]:ring-2 ${s.border} ${s.ring}`}
      data-testid={`race-card-${guide.slug}`}
      data-faction={guide.faction}
    >
      {/* Dark fallback shows while the picture loads or if it ever fails. */}
      <div className="relative aspect-[3/4] overflow-hidden bg-ink-950">
        {/* eslint-disable-next-line @next/next/no-img-element -- static same-origin asset; responsive srcset without next/image's inline styles (page CSP) */}
        <img
          src={art.src}
          srcSet={art.srcSet}
          sizes={RACE_CARD_SIZES}
          alt=""
          aria-hidden="true"
          width={RACE_ART_SIZE.width}
          height={RACE_ART_SIZE.height}
          loading="lazy"
          decoding="async"
          draggable={false}
          data-testid="race-art"
          data-race={guide.slug}
          className={`h-full w-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.03] ${RACE_CARD_POSITION}`}
        />
        {/* Fades the bottom of the picture into the footer; nothing is written on the artwork except the two small labels below. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-1/5 bg-gradient-to-t from-ink-900 to-transparent" />
        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1.5 text-xs font-semibold uppercase tracking-wider">
          <span className={`rounded border bg-ink-950/80 px-2 py-0.5 backdrop-blur-sm ${s.border} ${s.text}`}>{FACTION_LABEL[guide.faction]}</span>
          {isNewRace && <span className="rounded border border-violet-400/60 bg-ink-950/80 px-2 py-0.5 text-violet-300 backdrop-blur-sm">New race</span>}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <h3 className="font-[family-name:var(--font-display)] text-2xl font-semibold leading-tight xl:text-xl">
          <Link href={racePath(guide.slug)} className="text-parchment no-underline after:absolute after:inset-0 after:content-[''] hover:text-gold-300 focus-visible:outline-none">
            {guide.name}
          </Link>
        </h3>
        <p className="flex-1 text-sm text-mist">{guide.summary}</p>
        <div>
          <p className="text-xs uppercase tracking-wide text-mist">Available classes ({guide.classes.length})</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label={`${guide.name} classes`}>
            {guide.classes.map((c) => (
              <li key={c.classId} className={`rounded-full border px-2 py-0.5 text-xs ${c.isNew ? "border-violet-400/60 text-violet-300" : "border-ink-600 text-parchment/90"}`}>
                {c.name}{c.isNew && <span className="sr-only"> (new in Forever)</span>}{c.isNew && <span aria-hidden="true"> ★</span>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </li>
  );
}
