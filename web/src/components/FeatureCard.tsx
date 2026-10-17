import Image from "next/image";
import Link from "next/link";

export type FeatureCardData = {
  slug: string;
  title: string;
  description: string;
  href: string;
  /** CSS object-position for the background, tuned to each image's actual subject. */
  focal: string;
};

/**
 * One illustrated "Explore AzerDex" entry: an owner-approved background
 * (public/cards/<slug>.webp, watermarked - see docs/azerdex-hero-art/provenance.md)
 * with its matching medallion (public/cards/medallions/<slug>.webp) overlaid, title,
 * description and a single real link. Unlike the compact ENTRY_POINTS cards above it
 * on the homepage, this is a product-discovery card, not a category filter - every
 * href here must point at a feature that already exists (see page.tsx callers).
 */
export function FeatureCard({ title, description, href, slug, focal }: FeatureCardData) {
  return (
    <Link
      href={href}
      className="group relative block h-60 overflow-hidden rounded-xl border border-ink-700 no-underline transition hover:border-gold-500/70 sm:h-72"
    >
      <Image
        src={`/cards/${slug}.webp`}
        alt=""
        aria-hidden="true"
        fill
        sizes="(min-width: 640px) 50vw, 100vw"
        className="object-cover transition duration-500 group-hover:scale-[1.03]"
        style={{ objectPosition: focal }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950/90 via-ink-950/25 to-transparent" />
      <Image
        src={`/cards/medallions/${slug}.webp`}
        alt=""
        aria-hidden="true"
        width={72}
        height={72}
        className="absolute left-4 top-4 h-16 w-16 drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] sm:h-[4.5rem] sm:w-[4.5rem]"
      />
      <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
        <h3 className="font-[family-name:var(--font-display)] text-lg font-semibold text-gold-300 sm:text-xl">{title}</h3>
        <p className="mt-1 max-w-md text-sm text-parchment/90">{description}</p>
      </div>
    </Link>
  );
}
