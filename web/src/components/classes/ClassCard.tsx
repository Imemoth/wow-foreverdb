import Link from "next/link";
import type { ClassInfo } from "@/lib/classes/classes";
import { classPath } from "@/lib/classes/classes";
import { CARD_ART_POSITION, classCardArt } from "@/lib/classes/art";
import { joinNames } from "@/lib/classes/facts";
import { getTalentData } from "@/lib/talents/registry";
import { classStyle } from "./class-style";

/**
 * One illustrated class card. The whole card opens the class page through the class name's link (its ::after is stretched over the card; the text block is deliberately not positioned, so the card is that link's containing block);
 * the talent calculator is a separate link above it, so no link is nested in another. The character art is the main visual,
 * with a dark gradient only behind the text at the bottom; the class colour is a thin accent line on top.
 */
export function ClassCard({ info }: { info: ClassInfo }) {
  const data = getTalentData(info.id);
  const s = classStyle(info.id);
  const art = classCardArt(info.id);
  return (
    <li
      className={`group relative isolate flex aspect-[4/3] flex-col justify-end overflow-hidden rounded-xl border border-t-2 bg-ink-900 shadow-lg transition-[border-color,box-shadow] duration-300 hover:shadow-xl has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-violet-400 ${s.border}`}
      data-testid={`class-card-${info.id}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static same-origin asset; responsive srcset without next/image's inline styles (page CSP) */}
      <img
        src={art.src}
        srcSet={art.srcSet}
        sizes="(min-width: 1024px) 540px, (min-width: 640px) 60vw, 135vw"
        alt=""
        aria-hidden="true"
        width={1024}
        height={640}
        loading="lazy"
        decoding="async"
        draggable={false}
        data-testid="class-card-art"
        className={`absolute inset-0 -z-10 h-full w-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.03] ${CARD_ART_POSITION[info.id] ?? "object-center"}`}
      />
      {/* Readability: darkens only the lower part, where the text sits; the character above stays untouched. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-3/5 bg-gradient-to-t from-ink-950 via-ink-950/75 to-transparent" />
      <div className="flex flex-col gap-1 p-4">
        <h2 className="font-[family-name:var(--font-display)] text-2xl font-semibold leading-tight [text-shadow:0_1px_6px_rgb(0_0_0/0.8)]">
          <Link href={classPath(info.id)} className="text-parchment no-underline after:absolute after:inset-0 after:content-[''] hover:text-gold-300 focus-visible:outline-none">
            {info.name}
          </Link>
        </h2>
        {data ? (
          <>
            <p className="text-xs text-parchment/85 [text-shadow:0_1px_4px_rgb(0_0_0/0.9)]">{joinNames(data.trees.map((t) => t.name))}</p>
            <Link href={`${classPath(info.id)}#talents`} className="btn-ghost relative z-10 mt-1.5 min-h-11 self-start bg-ink-950/60 text-sm backdrop-blur-sm">
              Talent calculator
            </Link>
          </>
        ) : (
          <p className="text-xs text-parchment/85">Talent data for this class is not available yet.</p>
        )}
      </div>
    </li>
  );
}
