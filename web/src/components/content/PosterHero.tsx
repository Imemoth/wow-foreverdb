import { CategoryBadge } from "@/components/library/CategoryBadge";
import type { Article } from "@/lib/content/loader";
import type { ArticleCoverImages } from "@/lib/content/article-media";
import { PosterImage } from "@/components/content/PosterImage";
import { fmtDate } from "@/lib/format";

/**
 * Hero for an article whose cover is a finished poster (headline and badges are part of the artwork): the image is shown
 * whole, never cropped or overlaid, with the real <h1> and byline directly beneath it. The code-authored fallback art
 * (same subject) is layered behind the poster (see PosterImage), so if the poster ever fails to load the hero degrades
 * to that scene instead of a broken box. The image is the LCP element: eager, high priority, explicit dimensions.
 */
export function PosterHero({ article, cover, label }: { article: Article; cover: ArticleCoverImages["hero"]; label: string }) {
  return (
    <header aria-labelledby="article-title" className="mt-6">
      <div className="overflow-hidden rounded-xl border border-gold-500/40 shadow-[0_0_48px_rgb(108_65_199/0.3)]">
        <PosterImage cover={cover} alt={cover.alt} />
      </div>
      <div className="mx-auto mt-6 max-w-3xl space-y-3 text-center">
        <p aria-label={`${label} category`}><CategoryBadge category={article.category} /></p>
        <h1 id="article-title" className="font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-gold-300 sm:text-4xl">{article.title}</h1>
        <p className="text-lg text-parchment/90">{article.description}</p>
        <p className="flex flex-wrap items-center justify-center gap-2 text-sm text-mist">
          By {article.author} · <time dateTime={article.publishedAt}>{fmtDate(article.publishedAt)}</time>
          {article.updatedAt && <> · updated <time dateTime={article.updatedAt}>{fmtDate(article.updatedAt)}</time></>}
          · {article.readingMinutes} min read
        </p>
      </div>
    </header>
  );
}
