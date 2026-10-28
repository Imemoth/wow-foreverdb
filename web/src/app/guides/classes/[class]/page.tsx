import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ClassBackdrop, CLASS_MOTIF } from "@/components/classes/backdrops";
import { ClassEmblem } from "@/components/classes/ClassEmblem";
import { classStyle } from "@/components/classes/class-style";
import { getSpecGuide } from "@/components/classes/spec-guides";
import { DataNote } from "@/components/DataNote";
import { TalentCalculator } from "@/components/talents/TalentCalculator";
import { CLASSES, classPath, getClass, getSpecs, specPath } from "@/lib/classes/classes";
import { classIntro, talentSourceNote, treeRankCount } from "@/lib/classes/facts";
import { pageContext } from "@/lib/page";
import { robotsFor } from "@/lib/seo";
import { getTalentData, getTalentIcons } from "@/lib/talents/registry";

type Params = Promise<{ class: string }>;

export const dynamicParams = false;
export function generateStaticParams() {
  return CLASSES.map((c) => ({ class: c.id }));
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const info = getClass((await params).class);
  if (!info) return { title: "Not found", robots: { index: false } };
  return {
    title: `${info.name} talents & class guide`,
    description: classIntro(info.name, getTalentData(info.id)),
    alternates: { canonical: classPath(info.id) },
    robots: robotsFor(getTalentData(info.id) !== null),
  };
}

export default async function Page({ params }: { params: Params }) {
  const info = getClass((await params).class);
  if (!info) notFound();
  const { nonce, baseUrl } = await pageContext();
  const data = getTalentData(info.id);
  const icons = data ? getTalentIcons(data) : {};
  const specs = getSpecs(info.id);
  const s = classStyle(info.id);

  return (
    <div className="space-y-10">
      <Breadcrumbs nonce={nonce} baseUrl={baseUrl} items={[{ name: "Guides", href: "/guides" }, { name: "Classes", href: "/guides/classes" }, { name: info.name }]} />

      <header className={`panel relative flex flex-col gap-5 border-l-4 p-6 sm:flex-row sm:items-center sm:p-8 ${s.border}`} data-testid="class-hero">
        <ClassBackdrop classId={info.id} motif={CLASS_MOTIF[info.id] ?? "halo"} variant="hero" uid={`${info.id}-hero`} />
        <ClassEmblem classId={info.id} name={info.name} size="lg" />
        <div className="relative min-w-0 space-y-2">
          <h1 className="font-[family-name:var(--font-display)] text-4xl font-bold text-parchment">{info.name}</h1>
          <p className="max-w-3xl text-mist">{classIntro(info.name, data)}</p>
          {data && <a href="#talents" className="btn-primary mt-2 inline-flex">Open the talent calculator</a>}
        </div>
      </header>

      {data ? (
        <>
          <section aria-labelledby="specs-title" className="space-y-4">
            <h2 id="specs-title" className="panel-title text-2xl">Specializations</h2>
            <ul className="grid gap-4 md:grid-cols-3">
              {specs.map(({ slug, tree }) => {
                const guide = getSpecGuide(info.id, slug);
                return (
                  <li key={tree.id} className="panel flex h-full flex-col p-5" data-testid={`spec-${slug}`}>
                    <h3 className="font-[family-name:var(--font-display)] text-xl font-semibold text-gold-300">{tree.name}</h3>
                    <p className="mt-2 flex-1 text-sm text-mist">
                      {tree.talents.length} talents · {treeRankCount(tree)} ranks · {tree.rows} tiers
                    </p>
                    {guide ? (
                      <Link href={specPath(info.id, slug)} className="btn-ghost mt-4 self-start text-sm">Read the {tree.name} guide</Link>
                    ) : (
                      <p className="mt-4 text-xs text-mist">Guide not available yet.</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <div id="talents" className="scroll-mt-6">
            <TalentCalculator data={data} icons={icons} sourceNote={talentSourceNote(info.id, Object.keys(icons).length)} />
          </div>
        </>
      ) : (
        <DataNote tone="warn">
          Talent data for {info.name} has not been verified yet, so no talent tree is shown. AzerDex never displays guessed talent trees.
        </DataNote>
      )}
    </div>
  );
}
