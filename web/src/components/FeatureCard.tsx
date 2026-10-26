import Link from "next/link";

export type FeatureCardData = {
  slug: string;
  title: string;
  description: string;
  href: string;
  /**
   * Tailwind object-position arbitrary-value class (e.g. "object-[18%_42%]"), tuned
   * to each background's actual subject. This must be a literal class name, not a
   * computed style value: this component is server-rendered, so the page's strict
   * CSP (`style-src 'self' 'nonce-...'`, no 'unsafe-inline') blocks any inline
   * `style` attribute baked into the initial HTML - unlike HeroImageLayer's
   * client-rendered image, where React applies the style via direct DOM-property
   * assignment after hydration rather than as a parsed HTML attribute, so it never
   * hits that restriction. A compiled Tailwind class avoids the problem entirely by
   * keeping the value in the stylesheet instead of an inline attribute - but only
   * works if Tailwind's build-time scanner can see the exact class text, which is
   * why this has to be a literal string (see FEATURE_CARDS in page.tsx) and not
   * assembled from the raw "18% 42%" value at render time.
   */
  focalClass: string;
};

/**
 * One illustrated "Explore AzerDex" entry: an owner-approved background
 * (public/cards/<slug>.webp, watermarked - see docs/azerdex-card-art/provenance.md)
 * with its matching medallion (public/cards/medallions/<slug>.webp) overlaid, title,
 * description and a single real link. Unlike the compact ENTRY_POINTS cards above it
 * on the homepage, this is a product-discovery card, not a category filter - every
 * href here must point at a feature that already exists (see page.tsx callers).
 *
 * Plain <img> rather than next/image: this app sets `images.unoptimized: true`
 * site-wide, so next/image provides no real optimization here, and it always injects
 * its own inline `style="color:transparent"` placeholder regardless of props - which
 * would hit the same CSP problem described above even without the custom
 * object-position value.
 */
export function FeatureCard({ title, description, href, slug, focalClass }: FeatureCardData) {
  return (
    <Link
      href={href}
      className="group relative block h-60 overflow-hidden rounded-xl border border-ink-700 no-underline transition hover:border-gold-500/70 sm:h-72"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- see doc comment above */}
      <img
        src={`/cards/${slug}.webp`}
        alt=""
        aria-hidden="true"
        loading="lazy"
        className={`absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-[1.03] ${focalClass}`}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950/85 from-0% via-ink-950/10 via-45% to-transparent to-80%" />
      {/* eslint-disable-next-line @next/next/no-img-element -- see doc comment above */}
      <img
        src={`/cards/medallions/${slug}.webp`}
        alt=""
        aria-hidden="true"
        loading="lazy"
        width={72}
        height={72}
        className="absolute left-4 top-4 h-16 w-16 drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] sm:h-[4.5rem] sm:w-[4.5rem]"
      />
      <div className="absolute inset-x-0 bottom-0 p-4 sm:p-6">
        <h3 className="font-[family-name:var(--font-display)] text-lg font-bold text-gold-300 drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)] sm:text-xl">{title}</h3>
        <p className="mt-1.5 max-w-md text-sm leading-snug text-parchment/90">{description}</p>
      </div>
    </Link>
  );
}
