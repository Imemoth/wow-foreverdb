import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { RaceCard } from "@/components/races/RaceCard";
import { FACTION_STYLE } from "@/components/races/faction-style";
import { pageContext } from "@/lib/page";
import { FACTION_LABEL } from "@/lib/races/format";
import { RACE_GUIDES, raceNewFlags } from "@/lib/races/registry";
import { robotsFor } from "@/lib/seo";

export function generateMetadata(): Metadata {
  return {
    title: "Race Guides & Racial Abilities",
    description: "WoW: Forever race guides for all ten Alliance and Horde races: available classes, racial abilities and their version history, with Blizzard sources.",
    alternates: { canonical: "/guides/races" },
    robots: robotsFor(true),
  };
}

export default async function Page() {
  const { nonce, baseUrl } = await pageContext();
  return (
    <div className="space-y-10">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Guides", href: "/guides" }, { name: "Races" }]} />
      <header className="max-w-3xl space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-violet-300">Race guides</p>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-bold text-parchment sm:text-5xl">Choose your race</h1>
        <p className="text-mist">
          Every playable race in WoW: Forever has two active and two passive racial abilities. Each race page lists the classes it can play and its
          abilities, shows where every statement comes from, and keeps a version history so you can see how racials changed during the beta. The
          two Skyborne factions are listed separately because their classes and some abilities differ.
        </p>
      </header>
      {(["alliance", "horde"] as const).map((faction) => (
        <section key={faction} aria-labelledby={`faction-${faction}`} className="space-y-4" data-testid={`faction-${faction}`}>
          <h2 id={`faction-${faction}`} className={`panel-title text-2xl ${FACTION_STYLE[faction].text}`}>{FACTION_LABEL[faction]}</h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label={`${FACTION_LABEL[faction]} races`}>
            {RACE_GUIDES.filter((g) => g.faction === faction).map((g) => <RaceCard key={g.slug} guide={g} isNewRace={raceNewFlags[g.slug] ?? false} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}
