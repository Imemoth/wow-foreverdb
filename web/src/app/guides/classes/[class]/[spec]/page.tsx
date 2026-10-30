import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ClassEmblem } from "@/components/classes/ClassEmblem";
import { SPEC_GUIDES, getSpecGuide } from "@/components/classes/spec-guides";
import { TalentCalculator } from "@/components/talents/TalentCalculator";
import { classPath, getClass, getSpec, specPath } from "@/lib/classes/classes";
import { pageContext } from "@/lib/page";
import { robotsFor } from "@/lib/seo";
import { getTalentData, getTalentIcons } from "@/lib/talents/registry";

type Params = Promise<{ class: string; spec: string }>;

export const dynamicParams = false;
export function generateStaticParams() {
  return Object.keys(SPEC_GUIDES).map((key) => {
    const [cls, spec] = key.split("/") as [string, string];
    return { class: cls, spec };
  });
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const p = await params;
  const info = getClass(p.class);
  const spec = info ? getSpec(info.id, p.spec) : null;
  const guide = getSpecGuide(p.class, p.spec);
  if (!info || !spec || !guide) return { title: "Not found", robots: { index: false } };
  return {
    title: guide.title,
    description: guide.description,
    alternates: { canonical: specPath(info.id, p.spec) },
    openGraph: { type: "article", title: guide.title, description: guide.description, url: specPath(info.id, p.spec), modifiedTime: guide.updatedAt },
    robots: robotsFor(true),
  };
}

export default async function Page({ params }: { params: Params }) {
  const p = await params;
  const info = getClass(p.class);
  const data = info ? getTalentData(info.id) : null;
  const spec = info ? getSpec(info.id, p.spec) : null;
  const guide = getSpecGuide(p.class, p.spec);
  if (!info || !data || !spec || !guide) notFound();
  const { nonce, baseUrl } = await pageContext();
  const { Body } = guide;
  const icons = getTalentIcons(data);

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <Breadcrumbs
        nonce={nonce}
        baseUrl={baseUrl}
        items={[
          { name: "Guides", href: "/guides" },
          { name: "Classes", href: "/guides/classes" },
          { name: info.name, href: classPath(info.id) },
          { name: spec.tree.name },
        ]}
      />
      <header className="flex items-center gap-4">
        <ClassEmblem classId={info.id} name={info.name} size="md" />
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-3xl font-bold text-parchment sm:text-4xl">{guide.title}</h1>
          <p className="text-sm text-mist">{info.name} · {spec.tree.name} · updated {guide.updatedAt}</p>
        </div>
      </header>
      <nav aria-label="On this page" className="flex flex-wrap gap-2 text-sm">
        <a className="btn-ghost" href="#overview">Overview</a>
        <a className="btn-ghost" href="#talents">Talents</a>
        <a className="btn-ghost" href="#beginner">Beginner guide</a>
        <Link className="btn-ghost" href={classPath(info.id)}>All {info.name} talents</Link>
      </nav>
      <Body
        data={data}
        tree={spec.tree}
        calculator={<TalentCalculator data={data} icons={icons} highlightTreeId={spec.tree.id} />}
      />
    </div>
  );
}
