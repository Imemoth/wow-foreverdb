import Link from "next/link";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyState } from "@/components/EmptyState";
import { fmtInt } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { zonePath } from "@/lib/routes";

export const metadata = {
  title: "Zones",
  description: "Every World of Warcraft: Forever zone with ForeverDB observations: creatures, items, gathering nodes and fishing.",
  alternates: { canonical: "/zones" },
};

export default async function ZonesPage() {
  const { db, nonce, baseUrl } = await pageContext();
  const zones = await db.zones();
  return (
    <div className="space-y-6">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Zones" }]} />
      <header>
        <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-parchment">Zones</h1>
        <p className="mt-1 text-mist">Zones appear here once players have observed something in them. Coverage grows with every sync.</p>
      </header>
      {zones.length === 0 ? <EmptyState title="No zones published yet" /> : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {zones.map((z) => (
            <li key={z.mapId}>
              <Link href={zonePath(z.mapId)} className="panel block p-5 no-underline transition hover:border-gold-500/70">
                <span className="block font-[family-name:var(--font-display)] text-lg font-semibold text-gold-300">{z.zoneName}</span>
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
