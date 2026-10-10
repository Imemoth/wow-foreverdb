import { ArticleList, SECTION_META } from "@/components/ArticleViews";

export const metadata = { title: SECTION_META.news.title, description: SECTION_META.news.intro, alternates: { canonical: "/news" } };

export default function Page() {
  return <ArticleList section="news" />;
}
