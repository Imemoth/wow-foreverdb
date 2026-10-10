import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { data } from "@/lib/data";
import type { SourceType } from "@/lib/data/types";
import { LOOT_KIND_LABEL, displayId, fmtDate, fmtInt, sourceTypeLabel } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { robotsFor } from "@/lib/seo";
import { searchPath, sourcePath, zonePath } from "@/lib/routes";
import { parseEntityId } from "@/lib/validation";
import { ConfidenceBadge, LootKindBadge } from "./Badges";
import { Breadcrumbs } from "./Breadcrumbs";
import { DataNote, ObservedRateNote } from "./DataNote";
import { DropTable } from "./DropTable";
import { LocationPlot } from "./LocationPlot";
import { StatTile } from "./StatTile";

const loadSource = cache(async (type: SourceType, raw: string) => {
  const id = parseEntityId(raw, { allowNegative: type === "gameobject" });
  if (id == null) return null;
  return data().source(type, id);
});

const CATEGORY: Record<SourceType, { label: string; href: string }> = {
  creature: { label: "Creatures", href: searchPath({ category: "creature", kind: "mob" }) },
  gameobject: { label: "Objects & nodes", href: "/database?category=object" },
  fishing: { label: "Fishing", href: searchPath({ kind: "fishing" }) },
  item: { label: "Items", href: "/database?category=item" },
};

export async function sourceMetadata(type: SourceType, raw: string): Promise<Metadata> {
  const s = await loadSource(type, raw);
  const first = s?.variants[0];
  if (!s || !first) return { title: "Not found", robots: { index: false } };
  const label = sourceTypeLabel(type, s.id);
  const id = displayId(type, s.id);
  const total = s.variants.reduce((a, v) => a + v.totalObservations, 0);
  const kinds = [...new Set(s.variants.flatMap((v) => v.buckets.map((b) => LOOT_KIND_LABEL[b.lootKind])))].join(", ");
  const description = `${first.name}${id ? ` (${label.toLowerCase()} ${id})` : ""} in WoW: Forever: ${fmtInt(total)} observations (${kinds}) across ${s.variants.length} variant${s.variants.length === 1 ? "" : "s"}, with observed item rates and locations.`;
  const canonical = sourcePath(type, s.id);
  return {
    title: `${first.name} — ${label}${id ? ` ${id}` : ""}`,
    description,
    alternates: { canonical },
    openGraph: { title: `${first.name} · ForeverDB`, description, url: canonical },
    robots: robotsFor(s.variants.some((v) => v.indexable)),
  };
}

export async function SourcePage({ type, rawId }: { type: SourceType; rawId: string }) {
  const { nonce, baseUrl } = await pageContext();
  const s = await loadSource(type, rawId);
  const first = s?.variants[0];
  if (!s || !first) notFound();

  const label = sourceTypeLabel(type, s.id);
  const id = displayId(type, s.id);
  const total = s.variants.reduce((a, v) => a + v.totalObservations, 0);
  const last = s.variants.map((v) => v.lastObservedAt).filter(Boolean).sort().at(-1) ?? null;
  const byZone = new Map<number, typeof s.locations>();
  for (const p of s.locations) byZone.set(p.mapId, [...(byZone.get(p.mapId) ?? []), p]);
  const zoneName = new Map(s.zones.map((z) => [z.mapId, z.zoneName]));

  return (
    <article className="space-y-8">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Database", href: "/database" }, { name: CATEGORY[type].label, href: CATEGORY[type].href }, { name: first.name }]} />
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-bronze-400">{label}</p>
          <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl font-bold text-gold-300 sm:text-4xl">{first.name}</h1>
          <p className="mt-1 font-[family-name:var(--font-mono)] text-sm text-mist">
            {id ? `${label} ID ${id}` : "Fishing pool (identified by name and zone; no stable game ID)"}
            {type === "creature" && ` · ${s.variants.length} observed level${s.variants.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <StatTile label="Observations" value={fmtInt(total)} />
          <StatTile label="Zones" value={fmtInt(s.zones.length)} />
          <StatTile label="Last observed" value={fmtDate(last)} />
        </div>
      </header>

      <ObservedRateNote />
      {type === "creature" && s.variants.length > 1 && (
        <DataNote>Each creature level is a separate statistical source; levels are never merged.</DataNote>
      )}

      {type === "creature" && s.variants.length > 1 && (
        <nav aria-label="Level variants" className="flex flex-wrap gap-2">
          {s.variants.map((v) => (
            <a key={v.level} href={`#level-${v.level}`} className="btn-ghost text-sm">{v.level > 0 ? `Level ${v.level}` : "Level ? (historical)"}</a>
          ))}
        </nav>
      )}

      {s.variants.map((v) => (
        <section key={v.level} id={type === "creature" ? `level-${v.level}` : undefined} aria-labelledby={`v-${v.level}`} className="scroll-mt-6 space-y-4">
          <h2 id={`v-${v.level}`} className="panel-title text-2xl">
            {type === "creature" ? (v.level > 0 ? `Level ${v.level}` : "Level unknown (historical)") : "Observed loot"}
          </h2>
          <ul className="flex flex-wrap gap-3">
            {v.buckets.map((b) => (
              <li key={b.lootKind} className="panel flex items-center gap-3 px-3 py-2 text-sm">
                <LootKindBadge kind={b.lootKind} />
                <span className="text-parchment">{fmtInt(b.observations)} observed</span>
                <ConfidenceBadge confidence={b.confidence} />
              </li>
            ))}
          </ul>
          {v.drops.length === 0 ? (
            <p className="text-sm text-mist">No published item observations for this variant.</p>
          ) : (
            <DropTable rows={v.drops} perspective="source" caption={`Items observed from ${v.name}${type === "creature" ? ` level ${v.level}` : ""}`} />
          )}
        </section>
      ))}

      <section aria-labelledby="loc-title" className="space-y-4">
        <h2 id="loc-title" className="panel-title text-2xl">Where it was observed</h2>
        {s.zones.length === 0 ? <p className="text-sm text-mist">No located observations.</p> : (
          <>
            <ul className="flex flex-wrap gap-2">
              {s.zones.map((z) => (
                <li key={z.mapId}><Link className="btn-ghost text-sm" href={zonePath(z.mapId)}>{z.zoneName} <span className="text-mist">· {z.observations != null ? fmtInt(z.observations) : "n/a"}</span></Link></li>
              ))}
            </ul>
            <p className="text-xs text-mist">
              Positions are aggregated to an approximate 1% map grid and cells with very few observations are hidden.
              {type === "gameobject" && s.id < 0 && " Fishing-pool positions are projected best-effort estimates."}
              {" "}Map artwork is not shown — see <Link href="/about/data#maps">why</Link>.
            </p>
            <div className="grid gap-4 lg:grid-cols-2">
              {[...byZone.entries()].map(([mapId, pts]) => (
                <LocationPlot key={mapId} mapId={mapId} points={pts} zoneName={zoneName.get(mapId) ?? `Zone ${mapId}`} />
              ))}
            </div>
          </>
        )}
      </section>
    </article>
  );
}
