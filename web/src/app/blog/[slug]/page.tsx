import { articleMetadata } from "@/components/ArticleViews";
import { ArticleReader } from "@/components/content/ArticleReader";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  return articleMetadata("blog", (await params).slug);
}

export default async function Page({ params }: { params: Params }) {
  return <ArticleReader section="blog" slug={(await params).slug} />;
}
