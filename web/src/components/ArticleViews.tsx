import type { Metadata } from "next";
import { articlePath, getArticle, type Section } from "@/lib/content/loader";
import { robotsFor } from "@/lib/seo";

/**
 * Shared News/Guides/Blog metadata helper. The list/reader views this module used to export
 * (ArticleList, ArticlePage) have been replaced by section-specific hubs and the shared
 * content/ArticleReader.tsx (News, Blog: P2-C; Guides: P2-B's library/GuideArticle.tsx) - this
 * file now only holds what every section's page.tsx still needs: the shared section copy and the
 * metadata/robots computation.
 */
export const SECTION_META: Record<Section, { title: string; intro: string }> = {
  news: { title: "News", intro: "AzerDex development updates and WoW: Forever observation news, written and reviewed by the editors." },
  guides: { title: "Guides", intro: "Evergreen guides grounded in collected data: professions, gathering, fishing and using AzerDex." },
  blog: { title: "Blog", intro: "Behind the scenes: how AzerDex is built, data quality, and the road ahead." },
};

export async function articleMetadata(section: Section, slug: string): Promise<Metadata> {
  const a = getArticle(section, slug);
  if (!a) return { title: "Not found", robots: { index: false } };
  return {
    title: a.title,
    description: a.description,
    alternates: { canonical: articlePath(a) },
    openGraph: {
      type: "article", title: a.title, description: a.description, url: articlePath(a),
      publishedTime: a.publishedAt, modifiedTime: a.updatedAt ?? a.publishedAt, tags: a.tags,
    },
    // Sample/draft content is never indexed.
    robots: robotsFor(!a.sample && a.status === "published"),
  };
}
