import Link from "next/link";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { CartographyBanner } from "@/components/cartography/CartographyBanner";
import { EmptyState } from "@/components/EmptyState";
import { fmtInt } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { zonePath } from "@/lib/routes";

export const metadata = {
  title: "Zones",
  description: "Every World of Warcraft: Forever zone with AzerDex observations: creatures, items, gathering nodes and fishing.",
  alternates: { canonical: "/zones" },
};

export default async function ZonesPage() {
  const { db, nonce, baseUrl } = await pageContext();
  const zones = await db.zones();
  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Zones" }]} />
      <CartographyBanner>
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-violet-300">Arcane Cartography</p>
        <h1 className="mt-1 font-[family-name:var(--font-display)] text-3xl font-bold text-parchment sm:text-4xl">Zones</h1>
        <p className="mt-1 max-w-2xl text-sm text-mist sm:text-base">
          Every surveyed region, charted from real player observations. Zones appear here once something has been seen in them.
        </p>
      </CartographyBanner>
      {zones.length === 0 ? <EmptyState title="No zones published yet" /> : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {zones.map((z) => (
            <li key={z.mapId}>
              <Link href={zonePath(z.mapId)}
                className="panel group relative block overflow-hidden p-5 no-underline transition hover:border-gold-500/70 focus-visible:border-gold-500/70">
                <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-transparent via-gold-500/60 to-transparent opacity-0 transition group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
                <span className="block min-w-0 break-words font-[family-name:var(--font-display)] text-lg font-semibold text-gold-300">{z.zoneName}</span>
                <span className="mt-2 block text-sm text-mist">
                  {fmtInt(z.sourceCount)} sources · {fmtInt(z.itemCount)} related items · {fmtInt(z.observations)} located observations
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
