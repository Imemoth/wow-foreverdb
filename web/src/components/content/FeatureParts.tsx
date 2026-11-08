import type { FeatureArticle } from "@/lib/content/feature-articles";
import { classIconPath } from "@/lib/classes/art";

/** Three compact highlight statistics, shown directly under a feature article's hero. */
export function FeatureStats({ feature }: { feature: FeatureArticle }) {
  return (
    <dl aria-label="Achievement at a glance" className="mx-auto mt-6 grid max-w-5xl grid-cols-3 gap-px overflow-hidden rounded-xl border border-gold-500/40 bg-gold-500/20">
      {feature.stats.map((s) => (
        <div key={s.label} className="bg-ink-900 px-3 py-4 text-center sm:py-5">
          <dd className="font-[family-name:var(--font-display)] text-3xl font-bold leading-none text-gold-300 sm:text-5xl">{s.value}</dd>
          <dt className="mt-2 text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-mist sm:text-xs">{s.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** Five-player roster with class identities: class colour edge, official-class emblem, name, class and race. */
export function FeatureRoster({ feature }: { feature: FeatureArticle }) {
  return (
    <section aria-labelledby="feature-roster-title">
      <p id="feature-roster-title" className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-bronze-400">{feature.rosterTitle}</p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {feature.roster.map((p) => (
          <li key={p.name} className="panel relative flex items-center gap-4 overflow-hidden p-4" style={{ borderLeft: `4px solid ${p.color}` }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
            <img src={classIconPath(p.classId)} alt="" aria-hidden="true" width={56} height={56} loading="lazy" className="h-14 w-14 shrink-0 rounded-lg border border-ink-600 bg-ink-950" />
            <div className="min-w-0 flex-1">
              <p className="break-words font-[family-name:var(--font-display)] text-base font-bold leading-tight sm:text-lg text-parchment">{p.name}</p>
              <p className="text-sm font-semibold" style={{ color: p.color }}>{p.className}</p>
              <p className="text-xs text-mist">{p.race}</p>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
