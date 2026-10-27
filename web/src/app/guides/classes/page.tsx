import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ClassCard } from "@/components/classes/ClassCard";
import { DataNote } from "@/components/DataNote";
import { CLASSES } from "@/lib/classes/classes";
import { talentSourceNote } from "@/lib/classes/facts";
import { pageContext } from "@/lib/page";
import { robotsFor } from "@/lib/seo";

export function generateMetadata(): Metadata {
  return {
    title: "Class Guides & Talent Calculator",
    description: "WoW: Forever class guides and a talent calculator for all nine classes: Warrior, Paladin, Hunter, Rogue, Priest, Shaman, Mage, Warlock and Druid.",
    alternates: { canonical: "/guides/classes" },
    robots: robotsFor(true),
  };
}

export default async function Page() {
  const { nonce, baseUrl } = await pageContext();
  return (
    <div className="space-y-8">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Guides", href: "/guides" }, { name: "Classes" }]} />
      <header className="max-w-3xl space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-violet-300">Class guides</p>
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-bold text-parchment sm:text-5xl">Choose your class</h1>
        <p className="text-mist">
          Explore each class&apos;s talent trees and plan a build with the talent calculator. Every class has three trees that share one pool of talent
          points; builds are shareable by link and need no account.
        </p>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Classes">
        {CLASSES.map((c) => <ClassCard key={c.id} info={c} />)}
      </ul>
      <DataNote>{talentSourceNote()}</DataNote>
    </div>
  );
}
