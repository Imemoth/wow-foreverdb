import Link from "next/link";
import { CLASSES, classPath } from "@/lib/classes/classes";
import { classIconPath } from "@/lib/classes/art";

/**
 * Compact class navigation on the Guides landing page, shown under the library search: a heading with the link to the full
 * class chooser, and one row of the nine class icons (alphabetical - the order of `CLASSES`). The large illustrated cards
 * live on /guides/classes, not here.
 */
export function ClassGuidesEntry() {
  return (
    <section aria-labelledby="class-guides-entry" className="panel space-y-3 p-4" data-testid="class-guides-entry">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="max-w-2xl">
          <h2 id="class-guides-entry" className="panel-title text-xl">Class guides &amp; talent calculator</h2>
          <p className="text-sm text-mist">Browse every class&apos;s talent trees, plan a build with shareable links, and read specialization guides.</p>
        </div>
        <Link href="/guides/classes" className="btn-primary inline-flex text-sm">Browse classes</Link>
      </div>
      <ul className="grid grid-cols-5 gap-x-1 gap-y-1 sm:grid-cols-9" aria-label="Classes" data-testid="class-icon-nav">
        {CLASSES.map((c) => (
          <li key={c.id}>
            <Link
              href={classPath(c.id)}
              aria-label={`${c.name} class guide`}
              data-testid={`class-icon-${c.id}`}
              className="group flex min-h-[4.25rem] min-w-11 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 text-xs text-mist no-underline transition-colors hover:bg-ink-800/70 hover:text-gold-300 focus-visible:bg-ink-800/70 focus-visible:text-gold-300"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- static same-origin asset; the class name below is the accessible name */}
              <img
                src={classIconPath(c.id)}
                alt=""
                aria-hidden="true"
                width={40}
                height={40}
                loading="lazy"
                decoding="async"
                draggable={false}
                data-testid="class-icon"
                className="h-9 w-9 rounded-lg border border-ink-600 object-cover shadow-[0_0_0_1px_rgb(0_0_0/0.5)] transition-[border-color,transform] group-hover:border-gold-400/70 group-focus-visible:border-gold-400/70 motion-safe:group-hover:-translate-y-0.5 sm:h-10 sm:w-10"
              />
              <span>{c.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
