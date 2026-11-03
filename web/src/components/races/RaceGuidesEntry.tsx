import Link from "next/link";
import { raceThumbArt } from "@/lib/races/art";
import { RACE_GUIDES, racePath } from "@/lib/races/registry";
import { FACTION_STYLE } from "./faction-style";
import { FACTION_LABEL } from "@/lib/races/format";

/** Compact race navigation on the Guides landing page, shown under the class navigation. The large cards live on /guides/races. */
export function RaceGuidesEntry() {
  return (
    <section aria-labelledby="race-guides-entry" className="panel space-y-3 p-4" data-testid="race-guides-entry">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="max-w-2xl">
          <h2 id="race-guides-entry" className="panel-title text-xl">Race guides &amp; racial abilities</h2>
          <p className="hidden text-sm text-mist sm:block">All ten Alliance and Horde races, their classes and racial abilities, with Blizzard sources and version history.</p>
        </div>
        <Link href="/guides/races" className="btn-primary inline-flex text-sm">Browse races</Link>
      </div>
      <ul className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-x-1 gap-y-1" aria-label="Races" data-testid="race-nav">
        {RACE_GUIDES.map((g) => {
          const thumb = raceThumbArt(g.slug);
          return (
            <li key={g.slug} className="min-w-0">
              <Link
                href={racePath(g.slug)}
                aria-label={`${g.name} (${FACTION_LABEL[g.faction]}) race guide`}
                data-testid={`race-link-${g.slug}`}
                className="group flex min-h-[5rem] min-w-11 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-center text-xs text-mist no-underline transition-colors hover:bg-ink-800/70 hover:text-gold-300 focus-visible:bg-ink-800/70 focus-visible:text-gold-300"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- static same-origin asset; the race name below is the accessible name */}
                <img
                  src={thumb.src}
                  srcSet={thumb.srcSet}
                  sizes="40px"
                  alt=""
                  aria-hidden="true"
                  width={40}
                  height={53}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  data-testid="race-thumb"
                  className={`h-[3.25rem] w-10 rounded-lg border object-cover object-top shadow-[0_0_0_1px_rgb(0_0_0/0.5)] transition-[border-color,transform] motion-safe:group-hover:-translate-y-0.5 ${FACTION_STYLE[g.faction].border}`}
                />
                <span className="break-words leading-tight">{g.name.replace(" Skyborne", "")}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
