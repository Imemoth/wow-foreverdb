import { ArticlePage, articleMetadata } from "@/components/ArticleViews";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  return articleMetadata("news", (await params).slug);
}

export default async function Page({ params }: { params: Params }) {
  return <ArticlePage section="news" slug={(await params).slug} />;
}
