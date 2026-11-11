import type { ArticleCoverImages } from "@/lib/content/article-media";

/**
 * A poster cover shown whole (16:9), with the code-authored fallback scene layered underneath as a second image. If the
 * poster fails to load, the fallback shows through instead of a broken box. Two stacked <img> elements rather than a CSS
 * background because the site's CSP forbids inline style attributes, and it needs no client JavaScript. The poster
 * is the LCP element (eager, high priority); the fallback is lazy and decorative.
 */
export function PosterImage({ cover, alt }: { cover: ArticleCoverImages["hero"]; alt: string }) {
  return (
    <div className="relative aspect-video w-full bg-ink-950">
      {cover.fallbackSrc && (
        // eslint-disable-next-line @next/next/no-img-element -- static repository asset
        <img src={cover.fallbackSrc} alt="" aria-hidden="true" width={cover.width} height={cover.height} loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-cover" />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- static repository asset */}
      <img src={cover.src} alt={alt} width={cover.width} height={cover.height} fetchPriority="high" decoding="async" className="relative block h-full w-full object-cover" />
    </div>
  );
}
