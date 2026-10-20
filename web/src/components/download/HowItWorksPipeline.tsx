const STAGES = [
  { title: "WoW: Forever", detail: "You play the game as normal." },
  { title: "ForeverDB Addon", detail: "Collects loot, gathering, fishing and disenchant observations locally. Never makes a network request." },
  { title: "Windows Companion", detail: "Reads the addon's exported SavedVariables and synchronizes permitted observations." },
  { title: "Private backend", detail: "Raw submissions are stored in a protected database, never served directly to the public website." },
  { title: "Approved publication", detail: "A separate, owner-reviewed process validates and aggregates data before anything reaches AzerDex." },
  { title: "AzerDex", detail: "The public site you're on now - built entirely from that approved, aggregated output." },
];

/**
 * Responsive visual explanation of the actual data pipeline (P2-E Phase 4). A row of
 * connected stages on wide screens, a stacked list on narrow ones - plain CSS, no
 * diagram library. Mirrors (and deliberately does not duplicate the authority of)
 * /about/data, which is linked at the end as the canonical explanation.
 */
export function HowItWorksPipeline() {
  return (
    <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
      {STAGES.map((s, i) => (
        <li key={s.title} className="panel relative flex flex-col gap-1.5 p-4">
          <span className="font-[family-name:var(--font-display)] text-xs font-semibold uppercase tracking-wide text-violet-300">Step {i + 1}</span>
          <span className="font-[family-name:var(--font-display)] text-sm font-bold text-gold-300">{s.title}</span>
          <span className="text-xs text-mist">{s.detail}</span>
          {i < STAGES.length - 1 && (
            <span aria-hidden="true" className="absolute -right-2.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center text-violet-400 lg:flex">
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
