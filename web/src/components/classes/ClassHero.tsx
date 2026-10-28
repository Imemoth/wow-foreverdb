import type { ClassInfo } from "@/lib/classes/classes";
import { classCardArt, HERO_ART_POSITION } from "@/lib/classes/art";
import { classStyle } from "./class-style";

/**
 * Illustrated banner at the top of a class page: the class's illustration (the very same files the class card on
 * /guides/classes uses) fills a wide, clipped hero; the name, intro and calculator link sit on a dark gradient on the left
 * (the bottom on phones). The picture is decorative; the class colour stays as the accent border.
 */
export function ClassHero({ info, intro, hasCalculator }: { info: ClassInfo; intro: string; hasCalculator: boolean }) {
  const s = classStyle(info.id);
  const art = classCardArt(info.id);
  return (
    <header
      className={`relative isolate flex min-h-[26rem] flex-col justify-end overflow-hidden rounded-xl border border-l-4 bg-ink-950 shadow-xl sm:min-h-[21rem] sm:justify-center lg:min-h-[23rem] ${s.border}`}
      data-testid="class-hero"
      data-class={info.id}
    >
      {/* The picture: full banner on phones, the right ~78% from sm up, fading into the dark on its left edge. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- static same-origin asset; responsive srcset without next/image's inline styles (page CSP) */}
      <img
        src={art.src}
        srcSet={art.srcSet}
        sizes="(min-width: 1280px) 975px, (min-width: 640px) 78vw, 100vw"
        alt=""
        aria-hidden="true"
        width={1024}
        height={576}
        loading="eager"
        fetchPriority="high"
        decoding="async"
        draggable={false}
        data-testid="class-hero-art"
        className={`absolute inset-y-0 right-0 -z-10 h-full w-full object-cover sm:w-[78%] sm:[mask-image:linear-gradient(to_right,transparent,black_28%)] ${HERO_ART_POSITION[info.id] ?? "object-center"}`}
      />
      {/* Readability: bottom-up on phones, left-to-right from sm. The character on the right stays untouched. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-4/5 bg-gradient-to-t from-ink-950 via-ink-950/85 to-transparent sm:hidden" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 -z-10 hidden w-3/5 bg-gradient-to-r from-ink-950/95 via-ink-950/70 to-transparent sm:block" />
      <div className="max-w-xl space-y-2 p-6 sm:p-10">
        <h1 className="font-[family-name:var(--font-display)] text-4xl font-bold leading-tight text-parchment [text-shadow:0_2px_12px_rgb(0_0_0/0.8)] sm:text-5xl">{info.name}</h1>
        <p className="text-sm text-parchment/90 [text-shadow:0_1px_6px_rgb(0_0_0/0.9)] sm:text-base">{intro}</p>
        {hasCalculator && <a href="#talents" className="btn-primary mt-2 inline-flex min-h-11 items-center">Open the talent calculator</a>}
      </div>
    </header>
  );
}
