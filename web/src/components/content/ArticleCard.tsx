import Link from "next/link";
import type { Article, Section } from "@/lib/content/loader";
import { articlePath } from "@/lib/content/loader";
import { CategoryBadge } from "@/components/library/CategoryBadge";
import { CATEGORY_MEDALLION } from "@/lib/content/article-media";
import { fmtDate } from "@/lib/format";

/**
 * Shared News/Blog card - deliberately the same structure as library/GuideCard.tsx (featured
 * ribbon, category badge, reading time, title, description, tag pills, date/sample/draft row),
 * reused here rather than forked per-section so News and Blog stay in lockstep for any future
 * fix. CategoryBadge is imported directly from the Guides implementation: it is already
 * section-agnostic (works off any free-form category string), so reusing it is not a Guides
 * rewrite, just reuse.
 *
 * Always compact and text-only - the one News article with content-specific art
 * (lib/content/article-media.ts's SLUG_FEATURED_IMAGE) is pulled out of the grid and rendered via
 * ArticleSpotlight.tsx instead, so a tall illustrated cell never stretches its plain neighbors to
 * match its height (CSS grid rows stretch by default).
 */
export function ArticleCard({ article, section }: { article: Article; section: Section }) {
  const medallion = CATEGORY_MEDALLION[article.category];
  return (
    <li className="panel group relative flex h-full flex-col p-5">
      {article.featured && (
        <span className="absolute -top-2.5 left-4 rounded-full border border-gold-300/60 bg-ink-900 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-gold-300">
          Featured
        </span>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          {medallion && (
            // eslint-disable-next-line @next/next/no-img-element -- static repository asset
            <img src={medallion} alt="" aria-hidden="true" className="h-5 w-5" />
          )}
          <CategoryBadge category={article.category} />
        </span>
        <span className="text-xs text-mist">{article.readingMinutes} min read</span>
      </div>
      <h2 className="mt-2.5 text-lg font-semibold">
        <Link href={articlePath(article)} className="text-parchment no-underline hover:text-gold-300">{article.title}</Link>
      </h2>
      <p className="mt-2 flex-1 text-sm text-mist">{article.description}</p>
      {article.tags.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Topics">
          {article.tags.map((t) => (
            <li key={t}>
              <Link href={`/${section}?tag=${encodeURIComponent(t)}`} className="rounded-full border border-ink-600 px-2 py-0.5 text-xs text-mist no-underline hover:border-violet-400 hover:text-violet-300">
                #{t}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-mist">
        <time dateTime={article.publishedAt}>{fmtDate(article.publishedAt)}</time>
        {article.updatedAt && <>· updated <time dateTime={article.updatedAt}>{fmtDate(article.updatedAt)}</time></>}
        {article.sample && <span className="rounded bg-conf-low/15 px-1.5 py-0.5 text-conf-low">Editorial sample</span>}
        {article.status === "draft" && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-danger">Draft (local only)</span>}
      </p>
    </li>
  );
}
