import Link from "next/link";
import type { ClassInfo } from "@/lib/classes/classes";
import { classPath } from "@/lib/classes/classes";
import { classCardArt, classIconPath, HERO_ART_POSITION } from "@/lib/classes/art";
import { classStyle } from "./class-style";

/**
 * A compact class link: the class's own illustration (the very files the class cards and class pages use, nothing duplicated)
 * cropped toward the right with a dark gradient protecting the name on the left, the small class emblem, and the class colour as a
 * thin accent. The whole tile opens the Class Guide through the name's stretched link. Used where a class is a destination but
 * not the main subject (the race pages); the large illustrated ClassCard stays on /guides/classes.
 */
export function ClassTile({ info, badge, testId }: { info: ClassInfo; badge?: React.ReactNode; testId?: string }) {
  const s = classStyle(info.id);
  const art = classCardArt(info.id);
  return (
    <li
      className={`group relative isolate flex min-h-[5.5rem] items-center overflow-hidden rounded-xl border border-l-4 bg-ink-900 shadow-md transition-[border-color,box-shadow] duration-300 hover:shadow-lg has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-violet-400 ${s.border}`}
      data-testid={testId ?? `class-tile-${info.id}`}
      data-class={info.id}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static same-origin asset; responsive srcset without next/image's inline styles (page CSP) */}
      <img
        src={art.src}
        srcSet={art.srcSet}
        sizes="(min-width: 1024px) 220px, (min-width: 640px) 30vw, 60vw"
        alt=""
        aria-hidden="true"
        width={1024}
        height={640}
        loading="lazy"
        decoding="async"
        draggable={false}
        data-testid="class-tile-art"
        className={`absolute inset-y-0 right-0 -z-10 h-full w-3/5 object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.04] ${HERO_ART_POSITION[info.id] ?? "object-center"}`}
      />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r from-ink-900 from-35% via-ink-900/80 to-transparent" />
      <div className="flex min-w-0 flex-1 flex-col items-start justify-center gap-1.5 p-3">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element -- static same-origin asset; the class name next to it is the accessible name */}
          <img src={classIconPath(info.id)} alt="" aria-hidden="true" width={36} height={36} loading="lazy" decoding="async" draggable={false} className="h-9 w-9 shrink-0 rounded-lg border border-ink-600 object-cover" />
          <Link
            href={classPath(info.id)}
            className="flex min-h-11 items-center font-[family-name:var(--font-display)] text-lg font-semibold text-parchment no-underline after:absolute after:inset-0 after:content-[''] hover:text-gold-300 focus-visible:outline-none [text-shadow:0_1px_6px_rgb(0_0_0/0.8)]"
          >
            {info.name} <span className="sr-only">class guide</span>
          </Link>
        </div>
        {badge}
      </div>
    </li>
  );
}
