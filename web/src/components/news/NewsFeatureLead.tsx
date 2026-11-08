import Link from "next/link";
import type { Article } from "@/lib/content/loader";
import { articlePath } from "@/lib/content/loader";
import { articleCoverImages } from "@/lib/content/article-media";
import { SLUG_FEATURE } from "@/lib/content/feature-articles";
import { fmtDate } from "@/lib/format";

/** The newest published, non-sample, featured News article that has cover art: the /news lead story. */
export function pickLeadArticle(articles: readonly Article[]): Article | null {
  return articles.find((a) => a.section === "news" && a.status === "published" && a.featured && !a.sample && a.cover) ?? null;
}

/**
 * Featured editorial presentation at the top of /news. It is an AzerDex editorial piece and says so on its face:
 * the label, the byline and the explicit "not a Blizzard announcement" line keep community stories visibly apart
 * from the Official News and Blue Post cards below. Phones stack the art over the text (a purpose-cropped portrait
 * file); md+ lays the text over the artwork's quiet left half.
 */
export function NewsFeatureLead({ article }: { article: Article }) {
  const cover = articleCoverImages(article);
  if (!cover) return null;
  const feature = SLUG_FEATURE[article.slug];
  return (
    <section aria-labelledby="news-lead-title" className="relative isolate overflow-hidden rounded-2xl border border-gold-500/50 bg-ink-950 shadow-[0_0_48px_rgb(108_65_199/0.25)] md:flex md:min-h-[400px] md:items-end">
      <div className="relative h-56 sm:h-72 md:absolute md:inset-0 md:h-auto">
        <picture>
          <source media="(max-width: 767px)" srcSet={cover.hero.mobileSrc} />
          <img src={cover.hero.src} alt={cover.hero.alt} width={cover.hero.width} height={cover.hero.height} fetchPriority="high" decoding="async"
            className="h-full w-full object-cover object-[60%_85%] md:object-[50%_40%]" />
        </picture>
        <div className="absolute inset-0 hidden bg-gradient-to-r from-ink-950 via-ink-950/75 via-50% to-ink-950/0 md:block" />
        <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-ink-950 to-transparent md:h-1/3" />
      </div>
      <div className="relative z-10 -mt-12 space-y-3 p-5 sm:p-7 md:mt-0 md:max-w-xl md:p-10">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {feature && (
            <span className="inline-flex items-center gap-2 rounded-sm border border-gold-400/70 bg-ink-950/80 px-2.5 py-1 font-[family-name:var(--font-display)] text-[0.7rem] font-bold uppercase tracking-[0.26em] text-gold-300">
              <span aria-hidden="true" className="h-1.5 w-1.5 rotate-45 bg-gold-400" />{feature.kicker}
            </span>
          )}
          <span className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-bronze-400">AzerDex Editorial · {article.category}</span>
        </p>
        <h2 id="news-lead-title" className="font-[family-name:var(--font-display)] text-2xl font-bold leading-tight text-parchment sm:text-3xl lg:text-4xl [text-shadow:0_2px_14px_rgb(7_9_28/0.85)]">
          <Link href={articlePath(article)} className="no-underline text-parchment hover:text-gold-300">{article.title}</Link>
        </h2>
        <p className="text-parchment/90 [text-shadow:0_1px_10px_rgb(7_9_28/0.85)]">{article.description}</p>
        {feature && (
          <ul aria-label="Achievement at a glance" className="flex flex-wrap gap-2">
            {feature.stats.map((s) => (
              <li key={s.label} className="rounded-md border border-gold-500/40 bg-ink-900/80 px-3 py-1.5 text-sm">
                <span className="font-[family-name:var(--font-display)] font-bold text-gold-300">{s.value}</span> <span className="text-mist">{s.label}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="flex flex-wrap items-center gap-3 pt-1">
          <Link href={articlePath(article)} className="btn-primary inline-flex">Read the full story</Link>
          <span className="text-xs text-mist"><time dateTime={article.publishedAt}>{fmtDate(article.publishedAt)}</time> · {article.readingMinutes} min read</span>
        </p>
        <p className="text-xs text-mist">Community achievement reported by AzerDex. Not an official Blizzard announcement.</p>
      </div>
    </section>
  );
}
