import Link from "next/link";
import { CLASSES, classPath } from "@/lib/classes/classes";
import { ClassEmblem } from "./ClassEmblem";

/** Entry point to the Classes category, shown on the Guides landing page above the library search. */
export function ClassGuidesEntry() {
  return (
    <section aria-labelledby="class-guides-entry" className="panel flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between" data-testid="class-guides-entry">
      <div className="max-w-xl space-y-1.5">
        <h2 id="class-guides-entry" className="panel-title text-xl">Class guides &amp; talent calculator</h2>
        <p className="text-sm text-mist">Browse every class&apos;s talent trees, plan a build with shareable links, and read specialization guides.</p>
        <Link href="/guides/classes" className="btn-primary mt-2 inline-flex text-sm">Browse classes</Link>
      </div>
      <ul className="flex flex-wrap gap-3" aria-label="Classes">
        {CLASSES.map((c) => (
          <li key={c.id}>
            <Link href={classPath(c.id)} className="flex flex-col items-center gap-1 text-xs text-mist no-underline hover:text-gold-300" aria-label={`${c.name} class guide`}>
              <ClassEmblem classId={c.id} name={c.name} size="sm" />
              <span>{c.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
