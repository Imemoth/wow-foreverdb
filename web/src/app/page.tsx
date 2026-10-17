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
  const [meta, recent, zones] = await Promise.all([db.meta(), db.recent(5), db.zones()]);
  const articles = visibleArticles();
  const news = articles.filter((a) => a.section === "news").slice(0, 3);
  const c = meta.counts ?? {};

  return (
    // Breaks the whole homepage out of <main>'s max-w-7xl/px-4 (see the .hero-bleed
    // comment in globals.css) so it can use a wider, homepage-only max-width below,
    // without touching the global container every other page shares.
    <div className="hero-bleed">
      {/* Hero + central search: full-bleed artwork, content kept in its own
          constrained container that matches the width of every section below it. */}
      <section aria-labelledby="hero-title" className="relative overflow-hidden bg-[radial-gradient(900px_320px_at_50%_0,rgb(108_65_199/0.28),transparent_70%)] py-14 text-center sm:flex sm:min-h-[720px] sm:flex-col sm:justify-center sm:py-20">
        <HeroBackground nonce={nonce} />
        <HeroImageLayer />
        <div className="hero-vignette" />
        <div className="hero-fade-bottom" />
        <div className="relative z-10 mx-auto w-full max-w-[1400px] px-5 sm:px-10">
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-violet-300">World of Warcraft: Forever</p>
          {/* eslint-disable-next-line @next/next/no-img-element -- images.unoptimized is set
              site-wide, so next/image buys nothing here; this is also a server component, so
              next/image's own inline placeholder style would hit the CSP restriction that
              broke 665eb6c (see FeatureCard.tsx for the fuller reasoning). Meaningful alt
              text: this is the only place on the homepage that states the brand name and
              tagline together - the headline below deliberately doesn't repeat "Know Your
              World" now that the logo itself carries it. */}
          <img src="/logo-full.webp" alt="AzerDex — Know Your World." className="mx-auto mt-3 h-auto w-48 sm:w-72 lg:w-[420px]" />
          <h1 id="hero-title" className="mx-auto mt-3 max-w-3xl font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-parchment sm:text-5xl">
            Know Where It Drops.
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

      <div className="mx-auto w-full max-w-[1400px] space-y-14 px-4 pb-8 pt-8 sm:px-6 lg:px-8">
        {/* Statistics */}
        <div>
          <div className="rule-ornament mx-auto max-w-md" />
          <div className="mx-auto mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Items" value={fmtInt(c.items ?? 0)} />
            <StatTile label="Sources" value={fmtInt(c.sources ?? 0)} hint="creatures, nodes, pools" />
            <StatTile label="Zones" value={fmtInt(c.zones ?? 0)} />
            <StatTile label="Last publish" value={fmtDate(meta.publishedAt)} />
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

        {/* Latest news: full-width, ahead of Recently Observed - a step toward AzerDex
            becoming a hub for community updates and (eventually, separately planned)
            WoW: Forever Blue Posts. No feed/crawler here - same visibleArticles()
            content as the existing /news page, just the newest 3. */}
        <section aria-labelledby="news-title">
          <div className="flex items-baseline justify-between">
            <h2 id="news-title" className="panel-title text-2xl">Latest news</h2>
            <Link href="/news" className="text-sm">All news →</Link>
          </div>
          <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {news.map((a) => (
              <li key={a.slug} className="panel h-full p-4">
                <Link href={articlePath(a)} className="font-semibold text-parchment no-underline hover:text-gold-300">{a.title}</Link>
                <p className="mt-1 text-sm text-mist">{a.description}</p>
                <p className="mt-2 text-xs text-mist">{fmtDate(a.publishedAt)}{a.sample && <span className="ml-2 rounded bg-conf-low/15 px-1.5 py-0.5 text-conf-low">Sample article</span>}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* Recently observed: a compact, full-width activity strip - five rows, not a
            dashboard table. */}
        <section aria-labelledby="recent-title">
          <h2 id="recent-title" className="panel-title text-2xl">Recently observed</h2>
          <p className="mt-1 text-sm text-mist">Entries with the newest observations in the current publication.</p>
          {recent.length === 0 ? (
            <p className="panel mt-4 p-4 text-mist">No published observations yet.</p>
          ) : (
            <ul className="panel mt-4 divide-y divide-ink-700/70">
              {recent.map((r) => (
                <li key={`${r.entityKind}-${r.itemId ?? `${r.sourceType}-${r.sourceId}-${r.sourceLevel}`}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2">
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
          <h3 className="mt-6 font-semibold text-parchment">Observed zones</h3>
          <ul className="mt-3 flex flex-wrap gap-2">
            {zones.map((z) => (
              <li key={z.mapId}>
                <Link href={zonePath(z.mapId)} className="btn-ghost text-sm">{z.zoneName} <span className="text-mist">· {fmtInt(z.sourceCount)} sources</span></Link>
              </li>
            ))}
          </ul>
        </section>

        {/* Explore AzerDex: illustrated product-discovery cards (distinct from the six
            category filters above). The full ornamental wordmark now lives in the
            hero, so this section keeps only a plain gold-accented heading. */}
        <section aria-labelledby="explore-title">
          <h2 id="explore-title" className="panel-title text-center text-2xl">Explore AzerDex</h2>
          <div className="mt-5 grid gap-5 sm:grid-cols-2">
            {FEATURE_CARDS.map((card) => (
              <FeatureCard key={card.slug} {...card} />
            ))}
          </div>
        </section>

        {/* How AzerDex works: a compact bottom CTA, not a detailed explanation - the
            full write-up lives on /about/data. */}
        <section aria-labelledby="how-title" className="panel p-6 text-center sm:p-8">
          <h2 id="how-title" className="panel-title text-xl">How AzerDex works</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm text-mist">
            While you play, the ForeverDB addon records your observations and the Companion syncs them to the private
            AzerDex backend. Only approved, aggregated statistics are ever published here — private records, such as
            Guildbook rosters, never reach this website.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Link href="/about/data" className="btn-primary">Data methodology</Link>
            <Link href="/download" className="btn-ghost">Get the addon &amp; Companion</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
