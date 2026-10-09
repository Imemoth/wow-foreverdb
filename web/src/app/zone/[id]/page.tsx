import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { DataNote } from "@/components/DataNote";
import { EmptyState } from "@/components/EmptyState";
import { Pagination } from "@/components/Pagination";
import { ResultsTable } from "@/components/ResultsTable";
import { StatTile } from "@/components/StatTile";
import { data } from "@/lib/data";
import { DISPLAY_KINDS, InvalidQueryError, LOOT_KINDS, type Page, type SearchRow, type ZoneEntityQuery } from "@/lib/data/types";
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
  const description = `${z.zoneName} in WoW: Forever: ${fmtInt(z.sourceCount)} observed creatures, nodes and fishing sources and ${fmtInt(z.itemCount)} items, from ForeverDB player observations.`;
  return {
    title: `${z.zoneName} — Zone`,
    description,
    alternates: { canonical: zonePath(z.mapId) },
    openGraph: { title: `${z.zoneName} · ForeverDB`, description, url: zonePath(z.mapId) },
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
  let result: Page<SearchRow> | null = null;
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
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-bronze-400">Zone · uiMapID {z.mapId}</p>
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300 sm:text-4xl">{z.zoneName}</h1>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Sources" value={fmtInt(z.sourceCount)} />
          <StatTile label="Items" value={fmtInt(z.itemCount)} />
          <StatTile label="Located obs." value={fmtInt(z.observations)} />
        </div>
      </header>

      <nav aria-label="Quick filters" className="flex flex-wrap gap-2 text-sm">
        <Link className="btn-ghost" href={href({ type: "creature", kind: "", page: 1 })}>Creatures <span className="text-mist">{fmtInt(z.displayKinds.creature ?? 0)}</span></Link>
        <Link className="btn-ghost" href={href({ type: "item", kind: "", page: 1 })}>Items <span className="text-mist">{fmtInt(z.displayKinds.item ?? 0)}</span></Link>
        <Link className="btn-ghost" href={href({ type: "", kind: "mining", page: 1 })}>Mining <span className="text-mist">{fmtInt(lk.mining ?? 0)}</span></Link>
        <Link className="btn-ghost" href={href({ type: "", kind: "herbalism", page: 1 })}>Herbalism <span className="text-mist">{fmtInt(lk.herbalism ?? 0)}</span></Link>
        <Link className="btn-ghost" href={href({ type: "", kind: "fishing_pool", page: 1 })}>Fishing pools <span className="text-mist">{fmtInt(lk.fishing_pool ?? 0)}</span></Link>
        <Link className="btn-ghost" href={href({ type: "", kind: "chest", page: 1 })}>Chests <span className="text-mist">{fmtInt(lk.chest ?? 0)}</span></Link>
      </nav>

      <DataNote>
        This directory lists only what ForeverDB players have observed in {z.zoneName}. It is not a complete list of
        everything in the zone. Items are linked to the zone through sources observed here.
      </DataNote>

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
        <button type="submit" className="btn-gold">Apply</button>
      </form>

      <div aria-live="polite" className="space-y-4">
        {error && <div role="alert" className="panel p-4 text-sm text-danger">{error}</div>}
        {result && q && (
          <>
            <h2 className="font-semibold text-parchment">{fmtInt(result.total)} observed {result.total === 1 ? "entry" : "entries"}</h2>
            {result.rows.length === 0 ? (
              <EmptyState title="Nothing observed for this filter yet">Try another filter, or help by collecting data with the addon.</EmptyState>
            ) : (
              <ResultsTable rows={result.rows} zones={zones} caption={`Observed entries in ${z.zoneName}`} observationsLabel="In-zone obs." />
            )}
            <Pagination page={q.page} pageSize={q.pageSize} total={result.total} maxPage={41} hrefFor={(p) => href({ page: p })} />
          </>
        )}
      </div>
    </div>
  );
}
