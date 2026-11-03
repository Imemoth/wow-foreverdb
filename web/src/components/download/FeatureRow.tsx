/**
 * One primary alternating image/text feature block (P2-E Phase 2) - reuses an existing
 * shipped card-art background + a library medallion as its icon, matching the
 * established "Explore AzerDex" visual language (FeatureCard.tsx) without reusing that
 * component directly, since this page's rows are wider and alternate left/right rather
 * than sitting in a uniform grid.
 */
export function FeatureRow({
  image, focalClass, medallion, title, description, bullets, reverse, note,
}: {
  image: string;
  focalClass: string;
  medallion: string;
  title: string;
  description: string;
  bullets: string[];
  reverse?: boolean;
  note?: string;
}) {
  const imageBlock = (
    <div className="relative h-56 overflow-hidden rounded-xl border border-ink-700 sm:h-72">
      {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
      <img src={image} alt="" aria-hidden="true" className={`h-full w-full object-cover ${focalClass}`} />
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950/70 via-transparent to-transparent" />
      {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
      <img src={medallion} alt="" aria-hidden="true" width={64} height={64} className="absolute left-4 top-4 h-14 w-14 drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]" />
    </div>
  );

  const textBlock = (
    <div>
      <h3 className="font-[family-name:var(--font-display)] text-2xl font-bold text-gold-300">{title}</h3>
      <p className="mt-2 text-sm text-mist sm:text-base">{description}</p>
      <ul className="mt-4 space-y-2">
        {bullets.map((b) => (
          <li key={b} className="flex items-start gap-2 text-sm text-parchment">
            <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-violet-300" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m4 10 4 4 8-8" />
            </svg>
            {b}
          </li>
        ))}
      </ul>
      {note && <p className="mt-3 text-xs italic text-mist/80">{note}</p>}
    </div>
  );

  return (
    <div className="grid items-center gap-6 lg:grid-cols-2 lg:gap-10">
      {reverse ? (
        <>
          <div className="lg:hidden">{imageBlock}</div>
          {textBlock}
          <div className="hidden lg:block">{imageBlock}</div>
        </>
      ) : (
        <>
          {imageBlock}
          {textBlock}
        </>
      )}
    </div>
  );
}
