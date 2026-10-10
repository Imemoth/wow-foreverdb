import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { DataNote, ObservedRateNote } from "@/components/DataNote";
import { DropTable } from "@/components/DropTable";
import { EntityLink } from "@/components/EntityLink";
import { StatTile } from "@/components/StatTile";
import { data } from "@/lib/data";
import { LOOT_KIND_LABEL, fmtDate, fmtInt, fmtRate } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { robotsFor } from "@/lib/seo";
import { itemPath, zonePath } from "@/lib/routes";
import { parseEntityId } from "@/lib/validation";

type Params = Promise<{ id: string }>;

const load = cache(async (raw: string) => {
  const id = parseEntityId(raw);
  if (id == null) return null;
  return data().item(id);
});

/** Items that were only observed as a disenchanting input (not as loot). */
const loadDisenchantSource = cache(async (raw: string) => {
  const id = parseEntityId(raw);
  if (id == null) return null;
  return data().source("item", id);
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const raw = (await params).id;
  const d = await load(raw);
  if (!d) {
    const de = await loadDisenchantSource(raw);
    const v = de?.variants[0];
    if (!de || !v) return { title: "Item not found", robots: { index: false } };
    return {
      title: `${v.name} — Item ${de.id} (disenchanting)`,
      description: `Observed disenchanting results for ${v.name} (item ${de.id}) in WoW: Forever, from ${fmtInt(v.totalObservations)} observed disenchants.`,
      alternates: { canonical: itemPath(de.id) },
      robots: robotsFor(v.indexable),
    };
  }
  const top = d.drops.find((x) => x.confidence !== "insufficient") ?? d.drops[0];
  const description = top
    ? `${d.item.name} (item ${d.item.id}) observed from ${d.item.sourceCount} source${d.item.sourceCount === 1 ? "" : "s"} in WoW: Forever. Top: ${top.source.name}, ${LOOT_KIND_LABEL[top.lootKind]}, ${fmtRate(top.rate, top.confidence)} observed over ${fmtInt(top.observations)} loots.`
    : `${d.item.name} (item ${d.item.id}) in the ForeverDB observed database.`;
  return {
    title: `${d.item.name} — Item ${d.item.id}`,
    description,
    alternates: { canonical: itemPath(d.item.id) },
    openGraph: { title: `${d.item.name} · ForeverDB`, description, url: itemPath(d.item.id) },
    robots: robotsFor(d.item.indexable),
  };
}

export default async function ItemPage({ params }: { params: Params }) {
  const { db, nonce, baseUrl } = await pageContext();
  const raw = (await params).id;
  const d = await load(raw);
  if (!d) {
    const de = await loadDisenchantSource(raw);
    const v = de?.variants[0];
    if (!de || !v) notFound();
    return (
      <article className="space-y-8">
        <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Database", href: "/database" }, { name: "Items", href: "/database?category=item" }, { name: v.name }]} />
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-bronze-400">Item · disenchanting input</p>
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300 sm:text-4xl">{v.name}</h1>
          <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-mist">Item ID {de.id} · {fmtInt(v.totalObservations)} observed disenchants</p>
        </header>
        <ObservedRateNote />
        <section id="disenchants-into" aria-labelledby="de-title" className="space-y-3">
          <h2 id="de-title" className="panel-title text-2xl">Disenchants into</h2>
          <DropTable rows={v.drops} perspective="source" caption={`Observed disenchanting results of ${v.name}`} />
        </section>
      </article>
    );
  }

  // Related items: other items observed from this item's best sources.
  const topSources = [...new Map(d.drops.map((x) => [`${x.source.type}|${x.source.id}`, x.source])).values()].slice(0, 2);
  const related = new Map<number, string>();
  for (const s of topSources) {
    const sd = await db.source(s.type, s.id);
    for (const v of sd?.variants ?? []) for (const x of v.drops) if (x.item.id !== d.item.id) related.set(x.item.id, x.item.name);
  }
  const allWeak = d.drops.length > 0 && d.drops.every((x) => x.confidence === "insufficient" || x.confidence === "low");

  return (
    <article className="space-y-8">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Database", href: "/database" }, { name: "Items", href: "/database?category=item" }, { name: d.item.name }]} />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-bronze-400">Item</p>
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300 sm:text-4xl">{d.item.name}</h1>
          <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-mist">Item ID {d.item.id}</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Sources" value={fmtInt(d.item.sourceCount)} />
          <StatTile label="Times seen" value={fmtInt(d.item.totalDrops)} />
          <StatTile label="Last observed" value={fmtDate(d.item.lastObservedAt)} />
        </div>
      </header>

      <ObservedRateNote />
      {allWeak && (
        <DataNote tone="warn">
          All observations for this item are still low-sample. Treat the numbers as early indications, not reliable rates.
        </DataNote>
      )}

      <section aria-labelledby="sources-title" className="space-y-3">
        <h2 id="sources-title" className="panel-title text-2xl">Observed sources</h2>
        {d.drops.length === 0 ? (
          <p className="text-mist">No published source observations for this item.</p>
        ) : (
          <DropTable rows={d.drops} perspective="item" caption={`Observed sources of ${d.item.name}`} />
        )}
      </section>

      {d.disenchantsInto.length > 0 && (
        <section id="disenchants-into" aria-labelledby="de-title" className="space-y-3">
          <h2 id="de-title" className="panel-title text-2xl">Disenchants into</h2>
          <DropTable rows={d.disenchantsInto} perspective="source" caption={`Observed disenchanting results of ${d.item.name}`} />
        </section>
      )}

      <div className="grid gap-8 md:grid-cols-2">
        <section aria-labelledby="zones-title">
          <h2 id="zones-title" className="panel-title text-xl">Zones</h2>
          <p className="mt-1 text-xs text-mist">Inferred: zones where a source of this item was observed. ForeverDB cannot prove the zone of any individual drop, so no zone-specific drop count is shown.</p>
          {d.zones.length === 0 ? <p className="mt-3 text-sm text-mist">No located observations.</p> : (
            <ul className="mt-3 space-y-1.5">
              {d.zones.map((z) => (
                <li key={z.mapId} className="flex justify-between gap-3 text-sm">
                  <Link href={zonePath(z.mapId)}>{z.zoneName}</Link>
                  <span className="text-mist">{z.sourceCount ? `via ${fmtInt(z.sourceCount)} source${z.sourceCount === 1 ? "" : "s"}` : "inferred"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="related-title">
          <h2 id="related-title" className="panel-title text-xl">Also observed from the same sources</h2>
          {related.size === 0 ? <p className="mt-3 text-sm text-mist">Nothing else yet.</p> : (
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
              {[...related.entries()].slice(0, 16).map(([id, name]) => (
                <li key={id}><EntityLink href={itemPath(id)} tooltip={`/api/v1/tooltip/item/${id}`}>{name}</EntityLink></li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </article>
  );
}
