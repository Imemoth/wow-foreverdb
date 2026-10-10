import { ArticlePage, articleMetadata } from "@/components/ArticleViews";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  return articleMetadata("guides", (await params).slug);
}

export default async function Page({ params }: { params: Params }) {
  return <ArticlePage section="guides" slug={(await params).slug} />;
}
