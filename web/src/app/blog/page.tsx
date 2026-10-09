import { ArticleList, SECTION_META } from "@/components/ArticleViews";

export const metadata = { title: SECTION_META.blog.title, description: SECTION_META.blog.intro, alternates: { canonical: "/blog" } };

export default function Page() {
  return <ArticleList section="blog" />;
}
