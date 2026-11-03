import Link from "next/link";
import type { NewsEntry } from "@/lib/data/types";
import { selectHomepageNews } from "@/lib/news/selection";
import { NewsCard } from "./NewsCard";

export function NewsSection({ entries }: { entries: NewsEntry[] }) {
  const { featured, recent } = selectHomepageNews(entries, 3);
  return (
    <section aria-labelledby="latest-azeroth-title" className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="latest-azeroth-title" className="panel-title text-2xl">Latest from Azeroth</h2>
          <p className="mt-1 text-sm text-mist">Official WoW Forever news &amp; AzerDex updates</p>
        </div>
        <Link href="/news" className="text-sm">View All News →</Link>
      </div>
      {featured ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <NewsCard entry={featured} featured />
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-1">
            {recent.map((entry) => <NewsCard key={entry.id} entry={entry} />)}
          </div>
        </div>
      ) : (
        <div className="panel p-6 text-sm text-mist">The Azeroth news feed is warming up. Check back soon for official WoW Forever updates.</div>
      )}
    </section>
  );
}
