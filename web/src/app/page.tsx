import Link from "next/link";
import { DisplayKindBadge } from "@/components/Badges";
import { EntityLink } from "@/components/EntityLink";
import { StatTile } from "@/components/StatTile";
import { articlePath, visibleArticles } from "@/lib/content/loader";
import { fmtDate, fmtDateTime, fmtInt } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { entityPath, searchPath, zonePath } from "@/lib/routes";

export const metadata = { alternates: { canonical: "/" } };

const ENTRY_POINTS = [
  { title: "Items", text: "What drops it, from where, and how often it was seen.", href: "/database?category=item", accent: "text-gold-300", glyph: "M8 6h16l4 6-12 16L4 12z" },
  { title: "Creatures", text: "Loot and skinning, split by exact creature level.", href: searchPath({ category: "creature", kind: "mob" }), accent: "text-kind-mob", glyph: "M6 24c2-8 6-14 10-14s8 6 10 14M11 13l-3-5M21 13l3-5" },
  { title: "Mining", text: "Veins and the ore, stone and gems they yielded.", href: searchPath({ kind: "mining" }), accent: "text-kind-mining", glyph: "M6 26 20 12M17 6l9 9-4 1-6-6z" },
  { title: "Herbalism", text: "Herb nodes, their zones and observed locations.", href: searchPath({ kind: "herbalism" }), accent: "text-kind-herbalism", glyph: "M16 28V14M16 14c-6 0-9-4-9-9 5 0 9 3 9 9zm0 0c6 0 9-4 9-9-5 0-9 3-9 9z" },
  { title: "Fishing", text: "Per-zone catches and fishing pools, kept separate.", href: searchPath({ kind: "fishing" }), accent: "text-kind-fishing", glyph: "M4 16c4-6 14-6 20 0-6 6-16 6-20 0zm20 0 5-4v8z" },
  { title: "Zones", text: "Everything observed in an area, with filters.", href: "/zones", accent: "text-kind-object", glyph: "M4 8l8-3 8 3 8-3v19l-8 3-8-3-8 3zM12 5v19M20 8v19" },
];

export default async function HomePage() {
  const { db } = await pageContext();
  const [meta, recent, zones] = await Promise.all([db.meta(), db.recent(8), db.zones()]);
  const articles = visibleArticles();
  const news = articles.filter((a) => a.section === "news").slice(0, 3);
  const guides = articles.filter((a) => a.section === "guides").sort((a, b) => Number(b.featured) - Number(a.featured)).slice(0, 3);
  const c = meta.counts ?? {};

  return (
    <div className="space-y-14">
      {/* Hero + central search */}
      <section aria-labelledby="hero-title" className="relative overflow-hidden rounded-2xl border border-ink-700 bg-[radial-gradient(900px_300px_at_50%_0,rgb(201_151_61/0.18),transparent_70%)] px-5 py-12 text-center sm:px-10 sm:py-16">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-bronze-400">World of Warcraft: Forever</p>
        <h1 id="hero-title" className="mx-auto mt-3 max-w-3xl font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-parchment sm:text-5xl">
          Know where it drops — <span className="text-gold-300">and how sure we are.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-mist">
          ForeverDB is built from real in-game observations shared by players running the ForeverDB addon. Every rate shows its sample size.
        </p>
        <form action="/database" method="get" role="search" className="mx-auto mt-8 flex max-w-2xl flex-col gap-2 sm:flex-row">
          <label htmlFor="hero-q" className="sr-only">Search items, creatures, nodes or a game ID</label>
          <input id="hero-q" name="q" type="search" required minLength={2} maxLength={80} autoComplete="off"
            placeholder="Try “Copper Ore”, “Darkhound” or an ID like 2770"
            className="field h-12 flex-1 text-base" />
          <button type="submit" className="btn-gold h-12 px-6 text-base">Search database</button>
        </form>
        <div className="rule-ornament mx-auto mt-10 max-w-md" />
        <div className="mx-auto mt-6 grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Items" value={fmtInt(c.items ?? 0)} />
          <StatTile label="Sources" value={fmtInt(c.sources ?? 0)} hint="creatures, nodes, pools" />
          <StatTile label="Zones" value={fmtInt(c.zones ?? 0)} />
          <StatTile label="Last publish" value={fmtDate(meta.publishedAt)} />
        </div>
      </section>

      {/* Entry points */}
      <section aria-labelledby="browse-title">
        <h2 id="browse-title" className="panel-title text-2xl">Browse the database</h2>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ENTRY_POINTS.map((e) => (
            <li key={e.title}>
              <Link href={e.href} className="panel group flex h-full items-start gap-4 p-5 no-underline transition hover:border-gold-500/70">
                <svg viewBox="0 0 32 32" className={`h-9 w-9 shrink-0 ${e.accent}`} aria-hidden="true">
                  <path d={e.glyph} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>
                  <span className="block font-semibold text-parchment group-hover:text-gold-300">{e.title}</span>
                  <span className="mt-1 block text-sm text-mist">{e.text}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-10 lg:grid-cols-3">
        {/* Recently observed */}
        <section aria-labelledby="recent-title" className="lg:col-span-2">
          <h2 id="recent-title" className="panel-title text-2xl">Recently observed</h2>
          <p className="mt-1 text-sm text-mist">Entries with the newest observations in the current publication.</p>
          {recent.length === 0 ? (
            <p className="mt-4 text-mist">No published observations yet.</p>
          ) : (
            <ul className="panel mt-4 divide-y divide-ink-700/70">
              {recent.map((r) => (
                <li key={`${r.entityKind}-${r.itemId ?? `${r.sourceType}-${r.sourceId}-${r.sourceLevel}`}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <span className="flex items-center gap-2">
                    <DisplayKindBadge kind={r.displayKind} />
                    <EntityLink href={entityPath(r)} tooltip={r.entityKind === "item" ? `/api/v1/tooltip/item/${r.itemId}` : `/api/v1/tooltip/source/${r.sourceType}/${r.sourceId}`}>{r.name}</EntityLink>
                    {r.sourceType === "creature" && r.sourceLevel != null && <span className="text-xs text-mist">{r.sourceLevel > 0 ? `Lvl ${r.sourceLevel}` : "Lvl ?"}</span>}
                  </span>
                  <span className="text-xs text-mist">{fmtDateTime(r.lastObservedAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <h3 className="mt-8 font-semibold text-parchment">Observed zones</h3>
          <ul className="mt-3 flex flex-wrap gap-2">
            {zones.map((z) => (
              <li key={z.mapId}>
                <Link href={zonePath(z.mapId)} className="btn-ghost text-sm">{z.zoneName} <span className="text-mist">· {fmtInt(z.sourceCount)} sources</span></Link>
              </li>
            ))}
          </ul>
        </section>

        {/* How it works */}
        <section aria-labelledby="how-title" className="panel p-6">
          <h2 id="how-title" className="panel-title text-xl">How ForeverDB works</h2>
          <ol className="mt-4 space-y-4 text-sm text-mist">
            <li><strong className="text-parchment">1. The addon observes.</strong> While you play, it records loot, gathering and fishing results with the source, level and an approximate position.</li>
            <li><strong className="text-parchment">2. The Companion syncs.</strong> The Windows Companion uploads your installation&apos;s counters to the private ForeverDB backend. Private records, such as Guildbook rosters, never reach this website.</li>
            <li><strong className="text-parchment">3. We publish aggregates.</strong> A one-way pipeline validates and publishes only approved, aggregated statistics here.</li>
          </ol>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/download" className="btn-gold">Get the addon</Link>
            <Link href="/about/data" className="btn-ghost">Data methodology</Link>
          </div>
        </section>
      </div>

      <div className="grid gap-10 lg:grid-cols-2">
        <section aria-labelledby="news-title">
          <div className="flex items-baseline justify-between">
            <h2 id="news-title" className="panel-title text-2xl">Latest news</h2>
            <Link href="/news" className="text-sm">All news →</Link>
          </div>
          <ul className="mt-4 space-y-3">
            {news.map((a) => (
              <li key={a.slug} className="panel p-4">
                <Link href={articlePath(a)} className="font-semibold text-parchment no-underline hover:text-gold-300">{a.title}</Link>
                <p className="mt-1 text-sm text-mist">{a.description}</p>
                <p className="mt-2 text-xs text-mist">{fmtDate(a.publishedAt)}{a.sample && <span className="ml-2 rounded bg-conf-low/15 px-1.5 py-0.5 text-conf-low">Sample article</span>}</p>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="guides-title">
          <div className="flex items-baseline justify-between">
            <h2 id="guides-title" className="panel-title text-2xl">Featured guides</h2>
            <Link href="/guides" className="text-sm">All guides →</Link>
          </div>
          <ul className="mt-4 space-y-3">
            {guides.map((a) => (
              <li key={a.slug} className="panel p-4">
                <Link href={articlePath(a)} className="font-semibold text-parchment no-underline hover:text-gold-300">{a.title}</Link>
                <p className="mt-1 text-sm text-mist">{a.description}</p>
                <p className="mt-2 text-xs text-mist">{a.readingMinutes} min read · {a.category}{a.sample && <span className="ml-2 rounded bg-conf-low/15 px-1.5 py-0.5 text-conf-low">Sample article</span>}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
