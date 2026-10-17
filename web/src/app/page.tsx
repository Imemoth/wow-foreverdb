import Link from "next/link";
import { DisplayKindBadge } from "@/components/Badges";
import { EntityLink } from "@/components/EntityLink";
import { CategoryIcon, type CategoryIconId } from "@/components/CategoryIcon";
import { FeatureCard, type FeatureCardData } from "@/components/FeatureCard";
import { HeroBackground } from "@/components/hero/HeroBackground";
import { HeroImageLayer } from "@/components/hero/HeroImageLayer";
import { StatTile } from "@/components/StatTile";
import { articlePath, visibleArticles } from "@/lib/content/loader";
import { fmtDate, fmtDateTime, fmtInt } from "@/lib/format";
import { pageContext } from "@/lib/page";
import { entityPath, searchPath, zonePath } from "@/lib/routes";

export const metadata = { alternates: { canonical: "/" } };

const ENTRY_POINTS: { title: string; text: string; href: string; icon: CategoryIconId }[] = [
  { title: "Items", text: "What drops it, from where, and how often it was seen.", href: "/database?category=item", icon: "items" },
  { title: "Creatures", text: "Loot and skinning, split by exact creature level.", href: searchPath({ category: "creature", kind: "mob" }), icon: "creatures" },
  { title: "Mining", text: "Veins and the ore, stone and gems they yielded.", href: searchPath({ kind: "mining" }), icon: "mining" },
  { title: "Herbalism", text: "Herb nodes, their zones and observed locations.", href: searchPath({ kind: "herbalism" }), icon: "herbalism" },
  { title: "Fishing", text: "Per-zone catches and fishing pools, kept separate.", href: searchPath({ kind: "fishing" }), icon: "fishing" },
  { title: "Zones", text: "Everything observed in an area, with filters.", href: "/zones", icon: "zones" },
];

/**
 * Product-discovery cards, distinct from ENTRY_POINTS above (those are the six
 * functional category filters; these four are higher-level "what can AzerDex do for
 * me" entries) - see docs/azerdex-card-art/provenance.md for the artwork these use.
 * Every href points at a page that already exists and does what the card says; no
 * card claims functionality (e.g. an interactive map) that isn't actually built yet.
 *
 * focalClass must be a literal Tailwind class (see FeatureCardData's doc comment in
 * FeatureCard.tsx for why) - Tailwind's build-time scanner needs the exact string
 * "object-[..._...]" to appear somewhere in source, so these can't be assembled from
 * a separate "18% 42%"-style value at render time.
 */
const FEATURE_CARDS: FeatureCardData[] = [
  {
    slug: "community-data",
    title: "Community Data",
    description: "See how real player observations from the ForeverDB addon become AzerDex's published rates.",
    href: "/about/data",
    focalClass: "object-[18%_42%]",
  },
  {
    slug: "interactive-maps",
    title: "Explore Zones",
    description: "Browse every observed zone and jump straight to what's been recorded there, source by source.",
    href: "/zones",
    focalClass: "object-[30%_38%]",
  },
  {
    slug: "tools-guides",
    title: "Tools & Guides",
    description: "Addon setup walkthroughs and practical guides for getting the most out of AzerDex.",
    href: "/guides",
    focalClass: "object-[20%_55%]",
  },
  {
    slug: "exploration-discovery",
    title: "Exploration & Discovery",
    description: "Search the full item, creature and node database to find exactly where something drops.",
    href: "/database",
    focalClass: "object-[20%_52%]",
  },
];

export default async function HomePage() {
  const { db, nonce } = await pageContext();
  const [meta, recent, zones] = await Promise.all([db.meta(), db.recent(8), db.zones()]);
  const articles = visibleArticles();
  const news = articles.filter((a) => a.section === "news").slice(0, 3);
  const guides = articles.filter((a) => a.section === "guides").sort((a, b) => Number(b.featured) - Number(a.featured)).slice(0, 3);
  const c = meta.counts ?? {};

  return (
    <div className="space-y-14">
      {/* Hero + central search: full-bleed artwork (.hero-bleed breaks out of
          <main>'s max-w-7xl), content kept in its own constrained container. */}
      <div>
        <section aria-labelledby="hero-title" className="hero-bleed relative overflow-hidden bg-[radial-gradient(900px_320px_at_50%_0,rgb(108_65_199/0.28),transparent_70%)] py-14 text-center sm:flex sm:min-h-[680px] sm:flex-col sm:justify-center sm:py-20">
          <HeroBackground nonce={nonce} />
          <HeroImageLayer />
          <div className="hero-vignette" />
          <div className="hero-fade-bottom" />
          <div className="relative z-10 mx-auto w-full max-w-7xl px-5 sm:px-10">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-violet-300">World of Warcraft: Forever</p>
            <h1 id="hero-title" className="mx-auto mt-3 max-w-3xl font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-parchment sm:text-5xl">
              Know Your World. <span className="text-gold-300">Know where it drops.</span>
            </h1>
            <p className="mx-auto mt-3 max-w-2xl text-sm text-mist sm:mt-4 sm:text-base">
              A community-powered database for World of Warcraft: Forever, built from real in-game observations.
            </p>
            <form action="/database" method="get" role="search" className="mx-auto mt-6 flex max-w-2xl flex-col gap-2 sm:mt-8 sm:flex-row">
              <label htmlFor="hero-q" className="sr-only">Search items, creatures, nodes or a game ID</label>
              <input id="hero-q" name="q" type="search" required minLength={2} maxLength={80} autoComplete="off"
                placeholder="Try “Copper Ore”, “Darkhound” or an ID like 2770"
                className="field h-12 flex-1 text-base" />
              <button type="submit" className="btn-primary h-12 px-6 text-base">Search database</button>
            </form>
          </div>
        </section>
        <div className="mx-auto mt-8 w-full max-w-3xl px-4">
          <div className="rule-ornament mx-auto max-w-md" />
          <div className="mx-auto mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Items" value={fmtInt(c.items ?? 0)} />
            <StatTile label="Sources" value={fmtInt(c.sources ?? 0)} hint="creatures, nodes, pools" />
            <StatTile label="Zones" value={fmtInt(c.zones ?? 0)} />
            <StatTile label="Last publish" value={fmtDate(meta.publishedAt)} />
          </div>
        </div>
      </div>

      {/* Entry points */}
      <section aria-labelledby="browse-title">
        <h2 id="browse-title" className="panel-title text-2xl">Browse the database</h2>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {ENTRY_POINTS.map((e) => (
            <li key={e.title}>
              <Link href={e.href} className="panel group flex h-full items-start gap-4 p-5 no-underline transition hover:border-gold-500/70">
                <CategoryIcon id={e.icon} />
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
          <h2 id="how-title" className="panel-title text-xl">How AzerDex works</h2>
          <ol className="mt-4 space-y-4 text-sm text-mist">
            <li><strong className="text-parchment">1. The addon observes.</strong> While you play, the ForeverDB addon records loot, gathering and fishing results with the source, level and an approximate position.</li>
            <li><strong className="text-parchment">2. The Companion syncs.</strong> The ForeverDB Companion uploads your installation&apos;s counters to the private AzerDex backend. Private records, such as Guildbook rosters, never reach this website.</li>
            <li><strong className="text-parchment">3. We publish aggregates.</strong> A one-way pipeline validates and publishes only approved, aggregated statistics here.</li>
          </ol>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/download" className="btn-primary">Get the addon &amp; Companion</Link>
            <Link href="/about/data" className="btn-ghost">Data methodology</Link>
          </div>
        </section>
      </div>

      {/* Explore AzerDex: illustrated product-discovery cards (distinct from the six
          category filters above). The full ornamental wordmark gets its brand moment
          here rather than in the hero: it carries its own "Know Your World" tagline,
          which would otherwise sit right on top of the hero's near-identical headline -
          see docs/azerdex-card-art/provenance.md for the hero-placement comparison. */}
      <section aria-labelledby="explore-title">
        <div className="flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- images.unoptimized is set
              site-wide, so next/image buys nothing here; see FeatureCard.tsx for the fuller
              reasoning (this is also a server component, so next/image's own inline
              placeholder style would hit the CSP restriction that broke 665eb6c). */}
          <img src="/logo-full.webp" alt="AzerDex" className="h-auto w-56 sm:w-72" />
          <h2 id="explore-title" className="panel-title mt-4 text-2xl">Explore AzerDex</h2>
        </div>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          {FEATURE_CARDS.map((card) => (
            <FeatureCard key={card.slug} {...card} />
          ))}
        </div>
      </section>

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
