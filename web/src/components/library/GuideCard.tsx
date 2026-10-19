import Link from "next/link";
import type { Article } from "@/lib/content/loader";
import { articlePath } from "@/lib/content/loader";
import { fmtDate } from "@/lib/format";
import { CategoryBadge } from "./CategoryBadge";

export function GuideCard({ guide }: { guide: Article }) {
  return (
    <li className="panel group relative flex h-full flex-col p-5">
      {guide.featured && (
        <span className="absolute -top-2.5 left-4 rounded-full border border-gold-300/60 bg-ink-900 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-gold-300">
          Featured
        </span>
      )}
      <div className="flex items-center justify-between gap-2">
        <CategoryBadge category={guide.category} />
        <span className="text-xs text-mist">{guide.readingMinutes} min read</span>
      </div>
      <h2 className="mt-2.5 text-lg font-semibold">
        <Link href={articlePath(guide)} className="text-parchment no-underline hover:text-gold-300">{guide.title}</Link>
      </h2>
      <p className="mt-2 flex-1 text-sm text-mist">{guide.description}</p>
      {guide.tags.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Topics">
          {guide.tags.map((t) => (
            <li key={t}>
              <Link href={`/guides?tag=${encodeURIComponent(t)}`} className="rounded-full border border-ink-600 px-2 py-0.5 text-xs text-mist no-underline hover:border-violet-400 hover:text-violet-300">
                #{t}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-mist">
        <time dateTime={guide.publishedAt}>{fmtDate(guide.publishedAt)}</time>
        {guide.updatedAt && <>· updated <time dateTime={guide.updatedAt}>{fmtDate(guide.updatedAt)}</time></>}
        {guide.sample && <span className="rounded bg-conf-low/15 px-1.5 py-0.5 text-conf-low">Editorial sample</span>}
        {guide.status === "draft" && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-danger">Draft (local only)</span>}
      </p>
    </li>
  );
}
