import Link from "next/link";
import { medallionFor } from "@/components/cartography/zoneMedallion";
import { EmptyState } from "@/components/EmptyState";
import type { ZoneSummary } from "@/lib/data/types";
import { fmtInt } from "@/lib/format";
import type { ZoneCatalogEntry, ZoneGroup } from "@/lib/maps/atlas/zone-catalog";
import { zonePath } from "@/lib/routes";

/**
 * Catalog-driven zone directory (AZERDEX_ZONE_MAPS=1): every atlas zone and capital city is listed, whether or not anything has
 * been observed there. Observation figures come from the public read model only; a zone without published data says so explicitly.
 */
export function ZoneDirectory({ groups, filters, activeFilter, otherObserved, catalogSource }: {
  groups: ZoneGroup[];
  filters: { key: string; label: string; count: number }[];
  activeFilter: string;
  otherObserved: ZoneSummary[];
  catalogSource: "cdn" | "snapshot";
}) {
  const total = groups.reduce((a, g) => a + g.entries.length, 0);
  return (
    <div className="space-y-6" data-testid="zone-directory" data-catalog-source={catalogSource}>
      <nav aria-label="Filter by continent" className="flex flex-wrap gap-2 text-sm">
        {filters.map((f) => (
          <Link key={f.key} href={f.key === "all" ? "/zones" : `/zones?continent=${f.key}`} aria-current={activeFilter === f.key ? "true" : undefined}
            className={`btn-ghost ${activeFilter === f.key ? "border-violet-300 bg-ink-700 text-parchment" : ""}`}>
            {f.label} <span className="text-mist">{fmtInt(f.count)}</span>
          </Link>
        ))}
      </nav>
      {total === 0 ? <EmptyState title="No zones match this filter" /> : groups.map((g) => (
        <section key={g.key} aria-labelledby={`g-${g.key}`} className="space-y-3">
          <h2 id={`g-${g.key}`} className="panel-title text-xl">{g.label} <span className="text-sm font-normal text-mist">· {fmtInt(g.entries.length)}</span></h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {g.entries.map((e) => <li key={e.uiMapId}><ZoneCard e={e} /></li>)}
          </ul>
        </section>
      ))}
      {otherObserved.length > 0 && activeFilter === "all" && (
        <section aria-labelledby="g-other" className="space-y-3">
          <h2 id="g-other" className="panel-title text-xl">Other observed maps <span className="text-sm font-normal text-mist">· {fmtInt(otherObserved.length)}</span></h2>
          <p className="text-sm text-mist">Maps with published observations that the atlas does not list as an ordinary zone or city. No artwork is attached.</p>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {otherObserved.map((z) => (
              <li key={z.mapId}>
                <Link href={zonePath(z.mapId)} className="panel flex flex-col gap-1 p-4 no-underline hover:border-gold-500/70">
                  <span className="font-[family-name:var(--font-display)] text-lg font-semibold text-gold-300">{z.zoneName}</span>
                  <span className="text-xs text-mist">uiMapID {z.mapId} · {fmtInt(z.sourceCount)} sources · {fmtInt(z.observations)} located observations</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ZoneCard({ e }: { e: ZoneCatalogEntry }) {
  const art = e.artwork === "available" ? (e.hasFullReveal ? "Full-reveal map" : "Base map") : "No artwork";
  return (
    <Link href={zonePath(e.uiMapId)} data-testid="zone-card" data-ui-map-id={e.uiMapId}
      className="panel group relative flex h-full items-start gap-3 overflow-hidden p-5 no-underline transition hover:border-gold-500/70 focus-visible:border-gold-500/70">
      <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-gold-500/60 to-transparent opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
      {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
      <img src={medallionFor(e.name)} alt="" aria-hidden="true"
        className="h-11 w-11 shrink-0 rounded-full border border-ink-600 bg-ink-900/60 object-cover p-1.5 opacity-90 transition group-hover:opacity-100" />
      <div className="min-w-0">
        <span className="block min-w-0 break-words font-[family-name:var(--font-display)] text-lg font-semibold text-gold-300">{e.name}</span>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-mist">
          {e.category === "city" && <span className="rounded border border-ink-600 px-1.5 py-0.5 text-parchment">City</span>}
          <span>uiMapID {e.uiMapId}</span>
          {e.ambiguousName && <span className="text-gold-300">same name as another map</span>}
        </p>
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-xs text-mist">
          <span data-testid="zone-art">{art}{e.latestVersion ? ` · ${e.latestVersion}` : ""}</span>
        </p>
        {e.observed ? (
          <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm text-mist">
            <span><span className="font-semibold text-parchment">{fmtInt(e.observed.sourceCount)}</span> sources</span>
            <span aria-hidden="true" className="text-ink-600">·</span>
            <span><span className="font-semibold text-parchment">{fmtInt(e.observed.itemCount)}</span> related items</span>
            <span aria-hidden="true" className="text-ink-600">·</span>
            <span><span className="font-semibold text-parchment">{fmtInt(e.observed.observations)}</span> located observations</span>
          </p>
        ) : (
          <p className="mt-2 text-sm text-mist" data-testid="zone-empty">No public observations yet</p>
        )}
      </div>
    </Link>
  );
}
