import type { Metadata } from "next";
import { ArticleHub, articleQueryFrom, type SP } from "@/components/content/ArticleHub";
import { NewsObservatoryBanner } from "@/components/news/NewsObservatoryBanner";
import { SECTION_META } from "@/components/ArticleViews";
import { isEmptyArticleQuery } from "@/lib/content/article-query";
import { robotsFor } from "@/lib/seo";

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const query = await articleQueryFrom(searchParams);
  return {
    title: query.q ? `Search: ${query.q}` : SECTION_META.news.title,
    description: SECTION_META.news.intro,
    alternates: { canonical: "/news", types: { "application/rss+xml": "/news/rss.xml" } },
    // Filtered/search views are useful to people, thin for search engines - same policy as /guides and /database.
    robots: robotsFor(isEmptyArticleQuery(query)),
  };
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <ArticleHub
      section="news"
      searchParams={searchParams}
      eyebrow="Dispatches"
      eyebrowIcon="/library/medallions/chronicle.webp"
      title={SECTION_META.news.title}
      intro={SECTION_META.news.intro}
      Banner={NewsObservatoryBanner}
      searchLabel="Search News"
      rss
    />
  );
}
