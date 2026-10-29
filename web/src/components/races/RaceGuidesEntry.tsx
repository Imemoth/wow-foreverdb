import Link from "next/link";
import { RACE_GUIDES, racePath } from "@/lib/races/registry";
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
      <ul className="flex flex-wrap gap-2" aria-label="Races" data-testid="race-nav">
        {RACE_GUIDES.map((g) => (
          <li key={g.slug}>
            <Link href={racePath(g.slug)} data-testid={`race-link-${g.slug}`} className="inline-flex min-h-11 items-center rounded-lg border border-ink-600 px-3 text-sm text-parchment no-underline hover:border-gold-400/70 hover:text-gold-300 focus-visible:text-gold-300">
              {g.name}<span className="sr-only"> ({FACTION_LABEL[g.faction]}) race guide</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
