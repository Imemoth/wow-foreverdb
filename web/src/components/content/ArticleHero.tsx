import { CategoryBadge } from "@/components/library/CategoryBadge";
import type { Article } from "@/lib/content/loader";
import type { ArticleCoverImages } from "@/lib/content/article-media";
import { fmtDate } from "@/lib/format";

/**
 * Cover hero for an article that has frontmatter `cover` art (lib/content/article-media.ts). It reuses the News/Blog
 * hub hero technique (full-bleed breakout, `.hero-vignette`, ink gradients) and the same title/intro/meta content the
 * plain reader header shows, so an article with and without a cover read the same - only the backdrop differs.
 *
 * Phones (< 640px): the art sits on top as its own band (a purpose-cropped portrait file) and fades into the page
 * background; the title block follows it, so no headline is ever laid over the subject. 640px and up: the art fills the
 * hero and the left-anchored headline sits in the artwork's quiet half under a left-to-right and bottom scrim.
 * The image is the page's LCP element: eager, high fetch priority, explicit dimensions.
 */
export function ArticleHero({ article, cover, label }: { article: Article; cover: ArticleCoverImages["hero"]; label: string }) {
  return (
    <div className="relative left-1/2 mt-6 w-screen -ml-[50vw]">
      <header aria-labelledby="article-title" className="relative isolate overflow-hidden bg-ink-950 sm:flex sm:min-h-[480px] sm:items-end lg:min-h-[560px]">
        <div className="relative h-[300px] sm:absolute sm:inset-0 sm:h-auto">
          <picture>
            <source media="(max-width: 639px)" srcSet={cover.mobileSrc} />
            <img
              src={cover.src}
              alt={cover.alt}
              width={cover.width}
              height={cover.height}
              fetchPriority="high"
              decoding="async"
              className={`h-full w-full object-cover ${cover.position}`}
            />
          </picture>
          {/* Scrims stay light: the artwork already carries a quiet, darker left half. Left-to-right behind the headline, plus a fade into the page background at the bottom. */}
          <div className="absolute inset-0 hidden bg-gradient-to-r from-ink-950/80 via-ink-950/35 via-45% to-transparent sm:block" />
          <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-ink-950 via-ink-950/40 to-transparent sm:h-1/3 sm:via-ink-950/20" />
        </div>
        <div className="relative z-10 mx-auto -mt-16 w-full max-w-5xl px-4 pb-6 sm:mt-0 sm:pb-12 sm:pt-16">
          <div className="max-w-2xl space-y-3">
            <p aria-label={`${label} category`}><CategoryBadge category={article.category} /></p>
            <h1 id="article-title" className="font-[family-name:var(--font-display)] text-3xl font-bold leading-tight text-gold-300 sm:text-4xl lg:text-[2.75rem]">{article.title}</h1>
            <p className="max-w-lg text-base text-parchment/90 sm:text-lg">{article.description}</p>
            <p className="flex flex-wrap items-center gap-2 text-sm text-mist">
              By {article.author} · <time dateTime={article.publishedAt}>{fmtDate(article.publishedAt)}</time>
              {article.updatedAt && <> · updated <time dateTime={article.updatedAt}>{fmtDate(article.updatedAt)}</time></>}
              · {article.readingMinutes} min read
            </p>
          </div>
        </div>
      </header>
    </div>
  );
}
