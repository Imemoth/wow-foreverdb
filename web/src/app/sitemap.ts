import type { MetadataRoute } from "next";
import { articlePath, visibleArticles } from "@/lib/content/loader";
import { data } from "@/lib/data";
import { isIndexable, serverEnv } from "@/lib/env";
import { itemPath, sourcePath, zonePath } from "@/lib/routes";

export const dynamic = "force-dynamic";

/** Only indexable entities (thin-content policy) and published, non-sample articles. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const env = serverEnv();
  if (!isIndexable(env)) return [];
  const u = (p: string) => new URL(p, env.SITE_URL).toString();
  const db = data();
  const [items, sources, zones] = await Promise.all([db.sitemap("item", 0, 5000), db.sitemap("source", 0, 5000), db.sitemap("zone", 0, 5000)]);
  return [
    { url: u("/"), changeFrequency: "daily", priority: 1 },
    ...["/database", "/zones", "/news", "/guides", "/blog", "/download", "/about/data"].map((p) => ({ url: u(p) })),
    ...visibleArticles().filter((a) => a.status === "published" && !a.sample).map((a) => ({ url: u(articlePath(a)), lastModified: a.updatedAt ?? a.publishedAt })),
    ...items.map((r) => ({ url: u(itemPath(r.itemId!)), lastModified: r.updatedAt ?? undefined })),
    ...sources.map((r) => ({ url: u(sourcePath(r.sourceType!, r.sourceId!).split("#")[0]!), lastModified: r.updatedAt ?? undefined })),
    ...zones.map((r) => ({ url: u(zonePath(r.mapId!)) })),
  ];
}
