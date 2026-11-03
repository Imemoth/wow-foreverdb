import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NewsDetail } from "@/components/NewsDetail";
import { data } from "@/lib/data";
import { pageContext } from "@/lib/page";

type Params = Promise<{ slug: string }>;

async function findEntry(slug: string) {
  return data().newsEntry(slug);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const entry = await findEntry((await params).slug);
  if (!entry) return { title: "Not found", robots: { index: false } };
  return {
    title: entry.title,
    description: entry.excerpt,
    alternates: { canonical: "/news/entry/" + entry.slug },
    openGraph: { type: "article", title: entry.title, description: entry.excerpt, publishedTime: entry.publishedAt, modifiedTime: entry.modifiedAt ?? entry.publishedAt },
  };
}

export default async function Page({ params }: { params: Params }) {
  const entry = await findEntry((await params).slug);
  if (!entry) notFound();
  const { nonce, baseUrl } = await pageContext();
  return <NewsDetail entry={entry} nonce={nonce} baseUrl={baseUrl} />;
}
