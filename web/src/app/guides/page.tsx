import { ArticleList, SECTION_META } from "@/components/ArticleViews";

export const metadata = { title: SECTION_META.guides.title, description: SECTION_META.guides.intro, alternates: { canonical: "/guides" } };

export default function Page() {
  return <ArticleList section="guides" />;
}
