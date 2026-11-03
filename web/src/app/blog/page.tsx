import type { Metadata } from "next";
import { ArticleHub, articleQueryFrom, type SP } from "@/components/content/ArticleHub";
import { WritersStudyBanner } from "@/components/blog/WritersStudyBanner";
import { SECTION_META } from "@/components/ArticleViews";
import { isEmptyArticleQuery } from "@/lib/content/article-query";
import { robotsFor } from "@/lib/seo";

export async function generateMetadata({ searchParams }: { searchParams: SP }): Promise<Metadata> {
  const query = await articleQueryFrom(searchParams);
  return {
    title: query.q ? `Search: ${query.q}` : SECTION_META.blog.title,
    description: SECTION_META.blog.intro,
    alternates: { canonical: "/blog" },
    // Filtered/search views are useful to people, thin for search engines - same policy as /guides and /database.
    robots: robotsFor(isEmptyArticleQuery(query)),
  };
}

export default function Page({ searchParams }: { searchParams: SP }) {
  return (
    <ArticleHub
      section="blog"
      searchParams={searchParams}
      eyebrow="Editorial"
      eyebrowIcon="/library/medallions/inkwell.webp"
      title={SECTION_META.blog.title}
      intro={SECTION_META.blog.intro}
      Banner={WritersStudyBanner}
      searchLabel="Search the Blog"
    />
  );
}
