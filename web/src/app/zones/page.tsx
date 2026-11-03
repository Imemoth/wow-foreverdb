import Link from "next/link";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { CartographyHero } from "@/components/cartography/CartographyHero";
import { medallionFor } from "@/components/cartography/zoneMedallion";
import { EmptyState } from "@/components/EmptyState";
import { ZoneDirectory } from "@/components/ZoneDirectory";
import { atlasCatalog } from "@/lib/maps/atlas/catalog";
import { buildZoneEntries, groupByContinent, observedOutsideCatalog } from "@/lib/maps/atlas/zone-catalog";
import { zoneMapsEnabled } from "@/lib/maps/zone-maps-gate";
import { fmtInt } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { zonePath } from "@/lib/routes";

export const metadata = {
  title: "Zones",
  description: "Every World of Warcraft: Forever zone with AzerDex observations: creatures, items, gathering nodes and fishing.",
  alternates: { canonical: "/zones" },
};

export default async function ZonesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { db, nonce, baseUrl } = await pageContext();
  const zones = await db.zones();
  if (zoneMapsEnabled()) return <CatalogZones zones={zones} nonce={nonce} baseUrl={baseUrl} sp={await searchParams} />;
  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Zones" }]} />
      <CartographyHero variant="zones" eyebrow="Arcane Cartography" eyebrowIcon="/library/medallions/cartography.webp">
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-4xl font-bold leading-tight text-parchment sm:text-5xl lg:text-6xl">Zones</h1>
        <p className="mt-3 max-w-2xl text-sm text-mist sm:text-base lg:text-lg">
          Every surveyed region, charted from real player observations. Zones appear here once something has been seen in them.
        </p>
      </CartographyHero>
      {zones.length === 0 ? <EmptyState title="No zones published yet" /> : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {zones.map((z) => (
            <li key={z.mapId}>
              <Link href={zonePath(z.mapId)}
                className="panel group relative flex items-start gap-3 overflow-hidden p-5 no-underline transition hover:border-gold-500/70 focus-visible:border-gold-500/70">
                <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-gold-500/60 to-transparent opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
                {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
                <img src={medallionFor(z.zoneName)} alt="" aria-hidden="true"
                  className="h-11 w-11 shrink-0 rounded-full border border-ink-600 bg-ink-900/60 object-cover p-1.5 opacity-90 transition group-hover:opacity-100" />
                <div className="min-w-0">
                  <span className="block min-w-0 break-words font-[family-name:var(--font-display)] text-lg font-semibold text-gold-300">{z.zoneName}</span>
                  <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-sm text-mist">
                    <span><span className="font-semibold text-parchment">{fmtInt(z.sourceCount)}</span> sources</span>
                    <span aria-hidden="true" className="text-ink-600">·</span>
                    <span><span className="font-semibold text-parchment">{fmtInt(z.itemCount)}</span> related items</span>
                    <span aria-hidden="true" className="text-ink-600">·</span>
                    <span><span className="font-semibold text-parchment">{fmtInt(z.observations)}</span> located observations</span>
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** AZERDEX_ZONE_MAPS=1: the directory is the atlas catalog (every zone and capital city), enriched with published observation figures. */
async function CatalogZones({ zones, nonce, baseUrl, sp }: { zones: Awaited<ReturnType<Awaited<ReturnType<typeof pageContext>>["db"]["zones"]>>; nonce: string | undefined; baseUrl: string; sp: Record<string, string | string[] | undefined> }) {
  const catalog = await atlasCatalog();
  const entries = buildZoneEntries(catalog, zones);
  const groups = groupByContinent(entries);
  const raw = typeof sp.continent === "string" ? sp.continent : "all";
  const keys = new Set(groups.map((g) => (g.continentId != null ? String(g.continentId) : "other")));
  const active = raw === "all" || keys.has(raw) ? raw : "all";
  const filters = [
    { key: "all", label: "All", count: entries.length },
    ...groups.map((g) => ({ key: g.continentId != null ? String(g.continentId) : "other", label: g.label, count: g.entries.length })),
  ];
  const shown = active === "all" ? groups : groups.filter((g) => (g.continentId != null ? String(g.continentId) : "other") === active);
  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Zones" }]} />
      <CartographyHero variant="zones" eyebrow="Arcane Cartography" eyebrowIcon="/library/medallions/cartography.webp">
        <h1 className="mt-2 font-[family-name:var(--font-display)] text-4xl font-bold leading-tight text-parchment sm:text-5xl lg:text-6xl">Zones</h1>
        <p className="mt-3 max-w-2xl text-sm text-mist sm:text-base lg:text-lg">
          Every zone and capital city of the WoW: Forever atlas, with its map. Observation figures appear once players have published something there.
        </p>
      </CartographyHero>
      <ZoneDirectory groups={shown} filters={filters} activeFilter={active} otherObserved={observedOutsideCatalog(catalog, zones)} catalogSource={catalog.source} />
    </div>
  );
}
