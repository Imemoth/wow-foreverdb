import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { DataNote } from "@/components/DataNote";
import { AbilityCard } from "@/components/races/AbilityCard";
import { FACTION_STYLE } from "@/components/races/faction-style";
import { SourceLinks } from "@/components/races/SourceLinks";
import { VersionHistory } from "@/components/races/VersionHistory";
import { classPath } from "@/lib/classes/classes";
import { pageContext } from "@/lib/page";
import { FACTION_LABEL, formatDate } from "@/lib/races/format";
import { getRaceGuide, RACE_GUIDES, raceNewFlags, racePath } from "@/lib/races/registry";
import { robotsFor } from "@/lib/seo";

type Params = Promise<{ race: string }>;

export const dynamicParams = false;
export function generateStaticParams() {
  return RACE_GUIDES.map((g) => ({ race: g.slug }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const g = getRaceGuide((await params).race);
  if (!g) return { title: "Not found", robots: { index: false } };
  return {
    title: `${g.name} racial abilities & classes`,
    description: `${g.name} (${FACTION_LABEL[g.faction]}) in WoW: Forever: ${g.classes.length} available classes, four racial abilities and their version history, with Blizzard sources.`,
    alternates: { canonical: racePath(g.slug) },
    robots: robotsFor(true),
  };
}

export default async function Page({ params }: { params: Params }) {
  const g = getRaceGuide((await params).race);
  if (!g) notFound();
  const { nonce, baseUrl } = await pageContext();
  const s = FACTION_STYLE[g.faction];
  const isNewRace = raceNewFlags[g.slug] ?? false;
  const sources = [...new Map([...g.classSources, ...g.active.flatMap((a) => a.sources), ...g.passive.flatMap((a) => a.sources), ...g.retired.flatMap((a) => a.sources)].map((x) => [x.id, x])).values()]
    .sort((a, b) => a.publishedOn.localeCompare(b.publishedOn) || a.id.localeCompare(b.id));

  return (
    <div className="space-y-10">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Guides", href: "/guides" }, { name: "Races", href: "/guides/races" }, { name: g.name }]} />

      <header className={`space-y-3 rounded-xl border border-l-4 bg-ink-800 p-6 sm:p-8 ${s.border}`} data-testid="race-hero" data-faction={g.faction}>
        <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.25em]">
          <span className={s.text}>{FACTION_LABEL[g.faction]}</span>
          {isNewRace && <span className="rounded border border-violet-400/60 px-1.5 py-0.5 tracking-wider text-violet-300">New race in Forever</span>}
        </p>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-bold text-parchment sm:text-5xl">{g.name}</h1>
        <p className="max-w-3xl text-mist">{g.summary}</p>
        <p className="text-sm text-mist">
          {g.latestUpdate ? <>Latest documented change: <time dateTime={g.latestUpdate} className="text-parchment">{formatDate(g.latestUpdate)}</time>.</> : "No changes documented since the earliest published definitions."}
        </p>
      </header>

      <section aria-labelledby="classes-title" className="space-y-4">
        <h2 id="classes-title" className="panel-title text-2xl">Available classes</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label={`${g.name} classes`}>
          {g.classes.map((c) => (
            <li key={c.classId} className="panel flex items-center justify-between gap-3 p-4" data-testid={`class-${c.classId}`}>
              <Link href={classPath(c.classId)} className="min-h-11 flex-1 content-center font-[family-name:var(--font-display)] text-lg font-semibold text-parchment no-underline hover:text-gold-300">
                {c.name} <span className="sr-only">class guide</span>
              </Link>
              {c.isNew && <span className="rounded border border-violet-400/60 px-1.5 py-0.5 text-xs font-semibold text-violet-300">New in Forever</span>}
            </li>
          ))}
        </ul>
        <p className="text-sm text-mist">Class availability follows Blizzard&apos;s official race and class tables. Each class links to its AzerDex class guide and talent calculator.</p>
        <div data-testid="class-sources"><SourceLinks sources={g.classSources} label="Class availability source" /></div>
      </section>

      <section aria-labelledby="abilities-title" className="space-y-6">
        <h2 id="abilities-title" className="panel-title text-2xl">Racial abilities</h2>
        <div className="space-y-3" data-testid="active-abilities">
          <h3 className="font-[family-name:var(--font-display)] text-xl font-semibold text-violet-300">Active abilities</h3>
          <ul className="grid gap-4 lg:grid-cols-2">{g.active.map((a) => <AbilityCard key={a.id} ability={a} />)}</ul>
        </div>
        <div className="space-y-3" data-testid="passive-abilities">
          <h3 className="font-[family-name:var(--font-display)] text-xl font-semibold text-gold-300">Passive abilities</h3>
          <ul className="grid gap-4 lg:grid-cols-2">{g.passive.map((a) => <AbilityCard key={a.id} ability={a} />)}</ul>
        </div>
      </section>

      <VersionHistory raceName={g.name} changes={g.changes} earliest={g.earliest} />

      <section aria-labelledby="provenance-title" className="space-y-3" data-testid="provenance">
        <h2 id="provenance-title" className="panel-title text-2xl">Data provenance</h2>
        <DataNote tone="warn">
          <strong className="text-parchment">Not verified against the release client.</strong> No value on this page is tied to a specific game client build.
          Values come from Blizzard&apos;s published articles and beta development notes, which describe the beta; items marked
          &ldquo;Community-reported&rdquo; are not published by Blizzard. Blizzard&apos;s own statements always take priority.
        </DataNote>
        <div className="panel space-y-2 p-4 text-sm text-mist">
          <p>
            Documented changes for {g.name}: {g.evidence.official} from Blizzard&apos;s published notes, {g.evidence.community} community-reported details,{" "}
            {g.evidence.clientVerified} verified in the game client.
            {g.evidence.pending > 0 && ` Statements held back for insufficient evidence: ${g.evidence.pending}.`}
          </p>
          <SourceLinks sources={sources} label="All sources for this race" />
        </div>
      </section>
    </div>
  );
}
