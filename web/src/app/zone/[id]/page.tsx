import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { CartographyBanner } from "@/components/cartography/CartographyBanner";
import { medallionFor } from "@/components/cartography/zoneMedallion";
import { DataNote } from "@/components/DataNote";
import { EmptyState } from "@/components/EmptyState";
import { Pagination } from "@/components/Pagination";
import { ResultsTable } from "@/components/ResultsTable";
import { StatTile } from "@/components/StatTile";
import { data } from "@/lib/data";
import { DISPLAY_KINDS, InvalidQueryError, LOOT_KINDS, type Page, type ZoneEntityQuery, type ZoneEntityRow } from "@/lib/data/types";
import { DISPLAY_KIND_PLURAL, LOOT_KIND_LABEL, fmtInt } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { robotsFor } from "@/lib/seo";
import { zonePath } from "@/lib/routes";
import { parseEntityId, parseZoneEntityQuery } from "@/lib/validation";

type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

const load = cache(async (raw: string) => {
  const id = parseEntityId(raw);
  return id == null || id > 999_999 ? null : data().zone(id);
});

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: SP }): Promise<Metadata> {
  const z = await load((await params).id);
  if (!z) return { title: "Zone not found", robots: { index: false } };
  const filtered = Object.keys(await searchParams).length > 0;
  const description = `${z.zoneName} in WoW: Forever: ${fmtInt(z.sourceCount)} observed creatures, nodes and fishing sources and ${fmtInt(z.itemCount)} related items (linked through those sources), from AzerDex player observations.`;
  return {
    title: `${z.zoneName} — Zone`,
    description,
    alternates: { canonical: zonePath(z.mapId) },
    openGraph: { title: `${z.zoneName} · AzerDex`, description, url: zonePath(z.mapId) },
    robots: robotsFor(!filtered),
  };
}

function toParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
    else if (v != null) p.append(k, v);
  }
  return p;
}

export default async function ZonePage({ params, searchParams }: { params: Params; searchParams: SP }) {
  const { db, nonce, baseUrl } = await pageContext();
  const z = await load((await params).id);
  if (!z) notFound();
  const sp = toParams(await searchParams);

  let q: ZoneEntityQuery | null = null;
  let result: Page<ZoneEntityRow> | null = null;
  let error: string | null = null;
  try {
    q = parseZoneEntityQuery(z.mapId, sp, "lenient");
    result = await db.zoneEntities(q);
  } catch (e) {
    if (e instanceof InvalidQueryError) error = "Those filters are not valid.";
    else throw e;
  }
  const zones = await db.zones();
  const v = { q: sp.get("q")?.slice(0, 80) ?? "", type: sp.get("type") ?? "", kind: sp.get("kind") ?? "" };
  const href = (o: Partial<typeof v> & { page?: number }) => {
    const p = new URLSearchParams();
    const m = { ...v, ...o };
    if (m.q) p.set("q", m.q);
    if (m.type) p.set("type", m.type);
    if (m.kind) p.set("kind", m.kind);
    if (o.page && o.page > 1) p.set("page", String(o.page));
    const s = p.toString();
    return s ? `${zonePath(z.mapId)}?${s}` : zonePath(z.mapId);
  };
  const lk = z.lootKinds;

  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Zones", href: "/zones" }, { name: z.zoneName }]} />

      {/* 1. Zone identity and summary - a decorative medallion (same rotation as the Zones
          directory, see zoneMedallion.ts) ties this page back to its card, but the banner itself
          stays the existing contained CartographyBanner at its original height: this is a
          data-heavy detail page, not a landing hero. */}
      <CartographyBanner>
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
          <img src={medallionFor(z.zoneName)} alt="" aria-hidden="true"
            className="mt-0.5 hidden h-10 w-10 shrink-0 rounded-full border border-ink-600/80 bg-ink-900/60 object-cover p-1.5 opacity-90 sm:block" />
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-300">Zone · uiMapID {z.mapId}</p>
            <h1 className="mt-1 break-words font-[family-name:var(--font-display)] text-3xl font-bold text-parchment sm:text-4xl">{z.zoneName}</h1>
          </div>
        </div>
      </CartographyBanner>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Sources" value={fmtInt(z.sourceCount)} />
        <StatTile label="Items (inferred)" value={fmtInt(z.itemCount)} />
        <StatTile label="Located obs." value={fmtInt(z.observations)} />
      </div>

      {/* 2. Geographic observations - deliberately a pointer, not a new map: a zone-wide aggregated
          plot would need a new cross-source location aggregation this round does not add. Each
          source already listed below (Observed entities) carries its own observation map when it
          has located data - see e.g. its Object/Creature/Fishing detail page. */}
      {z.observations > 0 && (
        <section aria-labelledby="geo-title" className="panel p-4 sm:p-5">
          <h2 id="geo-title" className="panel-title text-lg">Geographic observations</h2>
          <p className="mt-1 text-sm text-mist">
            {fmtInt(z.observations)} observations in {z.zoneName} have a recorded location. Positions are aggregated to an
            approximate 1% map grid for privacy, shown on each individual source&apos;s own page below - open any creature,
            object or fishing entry under &ldquo;Observed entities&rdquo; to see its observation map and legend.
          </p>
        </section>
      )}

      {/* 3. Available entity categories - small 16px icons reuse the same public/icons/*.webp as
          the Database "Start browsing" tiles for visual continuity; Chests has no dedicated icon
          and stays plain, same "icon-less tile" rule as Database. */}
      <section aria-labelledby="categories-title" className="space-y-2">
        <h2 id="categories-title" className="panel-title text-lg">Entity categories</h2>
        <nav aria-label="Quick filters" className="flex flex-wrap gap-2 text-sm">
          <Link className="btn-ghost inline-flex items-center gap-1.5" href={href({ type: "creature", kind: "", page: 1 })}>
            {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
            <img src="/icons/creatures.webp" alt="" aria-hidden="true" className="h-4 w-4" />
            Creatures <span className="text-mist">{fmtInt(z.displayKinds.creature ?? 0)}</span>
          </Link>
          <Link className="btn-ghost inline-flex items-center gap-1.5" href={href({ type: "item", kind: "", page: 1 })}>
            {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
            <img src="/icons/items.webp" alt="" aria-hidden="true" className="h-4 w-4" />
            Items <span className="text-mist">{fmtInt(z.displayKinds.item ?? 0)}</span>
          </Link>
          <Link className="btn-ghost inline-flex items-center gap-1.5" href={href({ type: "", kind: "mining", page: 1 })}>
            {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
            <img src="/icons/mining.webp" alt="" aria-hidden="true" className="h-4 w-4" />
            Mining <span className="text-mist">{fmtInt(lk.mining ?? 0)}</span>
          </Link>
          <Link className="btn-ghost inline-flex items-center gap-1.5" href={href({ type: "", kind: "herbalism", page: 1 })}>
            {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
            <img src="/icons/herbalism.webp" alt="" aria-hidden="true" className="h-4 w-4" />
            Herbalism <span className="text-mist">{fmtInt(lk.herbalism ?? 0)}</span>
          </Link>
          <Link className="btn-ghost inline-flex items-center gap-1.5" href={href({ type: "", kind: "fishing_pool", page: 1 })}>
            {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
            <img src="/icons/fishing.webp" alt="" aria-hidden="true" className="h-4 w-4" />
            Fishing pools <span className="text-mist">{fmtInt(lk.fishing_pool ?? 0)}</span>
          </Link>
          <Link className="btn-ghost" href={href({ type: "", kind: "chest", page: 1 })}>Chests <span className="text-mist">{fmtInt(lk.chest ?? 0)}</span></Link>
        </nav>
      </section>

      <DataNote>
        This directory lists only what AzerDex players have observed in {z.zoneName}. It is not a complete list of
        everything in the zone. Creatures, objects and fishing pools show how often they were observed here. Items are
        linked to the zone <strong>by inference</strong> through the sources observed here; AzerDex cannot tell in
        which zone an individual drop happened, so items have no zone-specific count. Sources are listed first, then items.
      </DataNote>

      {/* 4. Search/filter interface */}
      <section aria-labelledby="filter-title" className="space-y-2">
        <h2 id="filter-title" className="panel-title text-lg">Search this zone</h2>
        <form method="get" action={zonePath(z.mapId)} autoComplete="off" aria-label={`Filter ${z.zoneName}`} className="panel grid gap-3 p-4 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
          <div className="flex flex-col gap-1">
            <label htmlFor="z-q" className="text-xs font-semibold uppercase tracking-wide text-mist">Name</label>
            <input id="z-q" name="q" type="search" defaultValue={v.q} maxLength={80} className="field" placeholder={`Filter ${z.zoneName}`} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="z-type" className="text-xs font-semibold uppercase tracking-wide text-mist">Type</label>
            <AutoSubmitSelect id="z-type" name="type" defaultValue={v.type} className="field">
              <option value="">All types</option>
              {DISPLAY_KINDS.map((k) => <option key={k} value={k}>{DISPLAY_KIND_PLURAL[k]}</option>)}
            </AutoSubmitSelect>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="z-kind" className="text-xs font-semibold uppercase tracking-wide text-mist">Acquisition</label>
            <AutoSubmitSelect id="z-kind" name="kind" defaultValue={v.kind} className="field">
              <option value="">Any method</option>
              {LOOT_KINDS.map((k) => <option key={k} value={k}>{LOOT_KIND_LABEL[k]}</option>)}
            </AutoSubmitSelect>
          </div>
          <button type="submit" className="btn-primary">Apply</button>
        </form>
      </section>

      {/* 5. Observed entities and associated items */}
      <div aria-live="polite" className="space-y-4">
        {error && <div role="alert" className="panel p-4 text-sm text-danger">{error}</div>}
        {result && q && (
          <>
            <h2 className="font-semibold text-parchment">{fmtInt(result.total)} observed {result.total === 1 ? "entry" : "entries"}</h2>
            {result.rows.length === 0 ? (
              <EmptyState title="Nothing observed for this filter yet">Try another filter, or help by collecting data with the addon.</EmptyState>
            ) : (
              <ResultsTable rows={result.rows} zones={zones} caption={`Observed entries in ${z.zoneName}`} observationsLabel="Observed in this zone" />
            )}
            <Pagination page={q.page} pageSize={q.pageSize} total={result.total} maxPage={41} hrefFor={(p) => href({ page: p })} />
          </>
        )}
      </div>
    </div>
  );
}
