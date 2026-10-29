import Link from "next/link";
import type { RaceGuide } from "@/lib/races/types";
import { FACTION_LABEL } from "@/lib/races/format";
import { racePath } from "@/lib/races/registry";
import { FACTION_STYLE } from "./faction-style";

/** One race card. The race name's link is stretched over the whole card (class chips are plain text, so no link nests in another). */
export function RaceCard({ guide, isNewRace }: { guide: RaceGuide; isNewRace: boolean }) {
  const s = FACTION_STYLE[guide.faction];
  return (
    <li
      className={`group relative flex flex-col gap-3 rounded-xl border border-t-2 bg-ink-800 p-5 shadow-lg transition-[border-color,box-shadow] duration-300 hover:shadow-xl has-[:focus-visible]:ring-2 ${s.border} ${s.ring}`}
      data-testid={`race-card-${guide.slug}`}
      data-faction={guide.faction}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wider">
        <span className={s.text}>{FACTION_LABEL[guide.faction]}</span>
        {isNewRace && <span className="rounded border border-violet-400/60 px-1.5 py-0.5 text-violet-300">New race</span>}
      </div>
      <h3 className="font-[family-name:var(--font-display)] text-2xl font-semibold leading-tight">
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
    </li>
  );
}
