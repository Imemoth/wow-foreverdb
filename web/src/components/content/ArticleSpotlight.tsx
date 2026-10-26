import Link from "next/link";
import type { Article } from "@/lib/content/loader";
import { articlePath } from "@/lib/content/loader";
import { CategoryBadge } from "@/components/library/CategoryBadge";
import { CATEGORY_MEDALLION, type CardImage } from "@/lib/content/article-media";
import { fmtDate } from "@/lib/format";

/**
 * Large image-beside-text treatment, used in two places: (1) News' one content-specific featured
 * article (see lib/content/article-media.ts's SLUG_FEATURED_IMAGE), shown above the ordinary
 * compact grid so the grid's row-stretch behavior never has to accommodate an oversized cell; and
 * (2) Blog's hub, replacing the grid outright whenever exactly one unfiltered article is visible
 * (today, always - Blog has one sample post; News never reaches this path since it always has 3).
 * Desktop: illustration beside metadata/heading/excerpt. Mobile: stacked image above text (a
 * <picture> art-directed crop, not a CSS reflow of the same image, so the mobile frame stays a
 * deliberate composition rather than a squeezed desktop one). The image is decorative (`alt=""`) -
 * see article-media.ts's doc comments for why neither use ever claims to represent real site
 * analytics or gameplay data.
 */
export function ArticleSpotlight({ article, image }: { article: Article; image: CardImage }) {
  const medallion = CATEGORY_MEDALLION[article.category];
  return (
    <div className="panel relative grid overflow-hidden p-0 md:grid-cols-2 md:items-stretch">
      {article.featured && (
        <span className="absolute left-4 top-4 z-10 rounded-full border border-gold-300/60 bg-ink-900 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-gold-300">
          Featured
        </span>
      )}
      <picture>
        <source media="(max-width: 767px)" srcSet={image.wideSrc} />
        <img src={image.src} alt="" aria-hidden="true" className="h-48 w-full object-cover sm:h-64 md:h-full" />
      </picture>
      <div className="flex flex-col justify-center gap-3 p-6 sm:p-8">
        <div className="flex items-center gap-2">
          {medallion && (
            // eslint-disable-next-line @next/next/no-img-element -- static repository asset
            <img src={medallion} alt="" aria-hidden="true" className="h-6 w-6" />
          )}
          <CategoryBadge category={article.category} />
          <span className="text-xs text-mist">{article.readingMinutes} min read</span>
        </div>
        <h2 className="font-[family-name:var(--font-display)] text-2xl font-bold leading-tight text-parchment sm:text-3xl">
          <Link href={articlePath(article)} className="no-underline hover:text-gold-300">{article.title}</Link>
        </h2>
        <p className="text-mist">{article.description}</p>
        <p className="flex flex-wrap items-center gap-2 text-xs text-mist">
          <time dateTime={article.publishedAt}>{fmtDate(article.publishedAt)}</time>
          {article.updatedAt && <>· updated <time dateTime={article.updatedAt}>{fmtDate(article.updatedAt)}</time></>}
          {article.sample && <span className="rounded bg-conf-low/15 px-1.5 py-0.5 text-conf-low">Editorial sample</span>}
          {article.status === "draft" && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-danger">Draft (local only)</span>}
        </p>
        <p className="mt-1">
          <Link href={articlePath(article)} className="btn-primary inline-flex w-fit">Read article</Link>
        </p>
      </div>
    </div>
  );
}
