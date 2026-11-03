import { articleMetadata } from "@/components/ArticleViews";
import { GuideArticle } from "@/components/library/GuideArticle";

type Params = Promise<{ slug: string }>;

export async function generateMetadata({ params }: { params: Params }) {
  return articleMetadata("guides", (await params).slug);
}

export default async function Page({ params }: { params: Params }) {
  return <GuideArticle slug={(await params).slug} />;
}
