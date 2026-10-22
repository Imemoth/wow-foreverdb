import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { DataNote } from "@/components/DataNote";
import { EmptyState } from "@/components/EmptyState";
import { Pagination } from "@/components/Pagination";
import { ZoneMapSection, configuredAssetBase } from "@/components/maps/ZoneMapSection";
import { ResultsTable } from "@/components/ResultsTable";
import { ZoneCinematicHero } from "@/components/zones/ZoneCinematicHero";
import { data } from "@/lib/data";
import { DISPLAY_KINDS, InvalidQueryError, LOOT_KINDS, type Page, type ZoneDetail, type ZoneEntityQuery, type ZoneEntityRow } from "@/lib/data/types";
import { atlasCatalog } from "@/lib/maps/atlas/catalog";
import { isDirectoryMap } from "@/lib/maps/atlas/zone-catalog";
import { parseMapFocus } from "@/lib/maps/focus";
import { resolveZoneArtwork } from "@/lib/maps/zone-artwork";
import { zoneMapsEnabled } from "@/lib/maps/zone-maps-gate";
import { DISPLAY_KIND_PLURAL, LOOT_KIND_LABEL, fmtInt } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { robotsFor } from "@/lib/seo";
import { zonePath } from "@/lib/routes";
import { parseEntityId, parseZoneEntityQuery } from "@/lib/validation";

type Params = Promise<{ id: string }>;
type SP = Promise<Record<string, string | string[] | undefined>>;

/**
 * Resolves a zone. A zone with published observations always resolves (unchanged). With AZERDEX_ZONE_MAPS=1 a zone/city of the atlas
 * also resolves when it has NO published observations (`observed: false`): its real artwork is shown with an explicit empty-data state.
 * Counts of such a zone are never invented: they do not exist in the public read model.
 */
const load = cache(async (raw: string): Promise<{ z: ZoneDetail; observed: boolean } | null> => {
  const id = parseEntityId(raw);
  if (id == null || id > 999_999) return null;
  const z = await data().zone(id);
  if (z) return { z, observed: true };
  if (!zoneMapsEnabled()) return null;
  const m = (await atlasCatalog()).byId.get(id);
  if (!m || !isDirectoryMap(m)) return null;
  return { z: { mapId: m.uiMapId, zoneName: m.name, observations: 0, sourceCount: 0, itemCount: 0, displayKinds: {}, lootKinds: {} }, observed: false };
});

export async function generateMetadata({ params, searchParams }: { params: Params; searchParams: SP }): Promise<Metadata> {
  const r = await load((await params).id);
  if (!r) return { title: "Zone not found", robots: { index: false } };
  const { z, observed } = r;
  const filtered = Object.keys(await searchParams).length > 0;
  // A zone without published observations is a real, reachable map page but thin content: kept out of the index, no invented counts.
  const description = observed
    ? `${z.zoneName} in WoW: Forever: ${fmtInt(z.sourceCount)} observed creatures, nodes and fishing sources and ${fmtInt(z.itemCount)} related items (linked through those sources), from AzerDex player observations.`
    : `${z.zoneName} in WoW: Forever: interactive zone map from the AzerDex atlas. No public observations are available for this zone yet.`;
  return {
    title: `${z.zoneName} — Zone`,
    description,
    alternates: { canonical: zonePath(z.mapId) },
    openGraph: { title: `${z.zoneName} · AzerDex`, description, url: zonePath(z.mapId) },
    robots: robotsFor(!filtered && observed),
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
  const loaded = await load((await params).id);
  if (!loaded) notFound();
  const { z, observed } = loaded;
  const sp = toParams(await searchParams);
  const gated = zoneMapsEnabled();
  const atlasMap = gated ? (await atlasCatalog()).byId.get(z.mapId) : undefined;
  const parentId = atlasMap?.parentUiMapId;
  const parent = parentId != null ? (await atlasCatalog()).byId.get(parentId) : undefined;
  const continent = parent?.category === "continent" ? parent : undefined;
  const focus = parseMapFocus(sp);

  let q: ZoneEntityQuery | null = null;
  let result: Page<ZoneEntityRow> | null = null;
  let error: string | null = null;
  try {
    q = parseZoneEntityQuery(z.mapId, sp, "lenient");
    result = observed ? await db.zoneEntities(q) : { rows: [], total: 0 };
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

      {/* 1. Zone identity and summary: the central cinematic hero (artwork resolved per uiMapID in lib/maps/zone-artwork.ts).
          The three stats are real read-model figures; an atlas-only zone has none, so they render as "not available". */}
      <ZoneCinematicHero
        zoneName={z.zoneName}
        region={continent?.name ?? null}
        kindLabel={atlasMap?.category === "city" ? "City" : "Zone"}
        description={observed
          ? `Discover creatures, loot and gathering data across ${z.zoneName}.`
          : `Explore the ${z.zoneName} map. No public observations have been published for this zone yet.`}
        stats={observed ? { sources: z.sourceCount, items: z.itemCount, locatedObservations: z.observations } : null}
        artwork={resolveZoneArtwork(z.mapId, atlasMap, configuredAssetBase())}
      />

      {/* 2. Geographic observations. With the zone-map experience enabled this is the interactive atlas map (real CDN artwork + the
          published zone-wide observation layer); otherwise the original pointer to each source's own map. */}
      {gated ? (
        <ZoneMapSection mapId={z.mapId} zoneName={z.zoneName} atlasMap={atlasMap} kinds={focus.kinds} source={focus.source} knownEmpty={!observed} />
      ) : z.observations > 0 && (
        <section aria-labelledby="geo-title" className="panel p-4 sm:p-5">
          <h2 id="geo-title" className="panel-title text-lg">Geographic observations</h2>
          <p className="mt-1 text-sm text-mist">
            {fmtInt(z.observations)} observations in {z.zoneName} have a recorded location. Positions are aggregated to an
            approximate 1% map grid for privacy, shown on each individual source&apos;s own page below - open any creature,
            object or fishing entry under &ldquo;Observed entities&rdquo; to see its observation map and legend.
          </p>
        </section>
      )}

      {!observed && (
        <EmptyState title="No public observations are available for this zone yet">
          Nothing has been published for {z.zoneName}. The map above is the real zone artwork; it carries no markers because there is no published data to show.
        </EmptyState>
      )}

      {observed && (<>
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
      </>)}
    </div>
  );
}
