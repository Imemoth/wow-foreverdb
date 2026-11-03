import type { MetadataRoute } from "next";
import { SPEC_GUIDES } from "@/components/classes/spec-guides";
import { CLASSES, classPath, specPath } from "@/lib/classes/classes";
import { articlePath, visibleArticles } from "@/lib/content/loader";
import { data } from "@/lib/data";
import { RACE_GUIDES, racePath } from "@/lib/races/registry";
import { isIndexable, serverEnv } from "@/lib/env";
import { itemPath, sourcePath, zonePath } from "@/lib/routes";
import { BETA_SEO_HOSTNAME, isIndexablePublicBetaHost, requestHostname } from "@/lib/seo";

export const dynamic = "force-dynamic";

/** Only indexable entities (thin-content policy) and published, non-sample articles. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const env = serverEnv();
  if (await isIndexablePublicBetaHost(env, await requestHostname())) {
    // The public beta advertises only the one approved, indexable homepage (zone, source and item pages
    // are noindex by the thin-content policy until the beta is promoted).
    return [{ url: `https://${BETA_SEO_HOSTNAME}/`, changeFrequency: "daily", priority: 1 }];
  }
  if (!isIndexable(env)) return [];
  const u = (p: string) => new URL(p, env.SITE_URL).toString();
  const db = data();
  const [items, sources, zones, firstNews] = await Promise.all([
    db.sitemap("item", 0, 5000), db.sitemap("source", 0, 5000), db.sitemap("zone", 0, 5000),
    db.newsList({ category: null, query: "", page: 1, pageSize: 50 }).catch(() => ({ rows: [], total: 0 })),
  ]);
  const news = [...firstNews.rows];
  const newsPages = Math.ceil(firstNews.total / 50);
  for (let page = 2; page <= newsPages; page += 1) {
    try {
      news.push(...(await db.newsList({ category: null, query: "", page, pageSize: 50 })).rows);
    } catch {
      break;
    }
  }
  return [
    { url: u("/"), changeFrequency: "daily", priority: 1 },
    ...["/database", "/zones", "/news", "/guides", "/guides/classes", "/guides/races", "/blog", "/download", "/about/data"].map((p) => ({ url: u(p) })),
    ...CLASSES.map((c) => ({ url: u(classPath(c.id)) })),
    ...RACE_GUIDES.map((g) => ({ url: u(racePath(g.slug)) })),
    ...Object.keys(SPEC_GUIDES).map((key) => { const [cls, spec] = key.split("/") as [string, string]; return { url: u(specPath(cls, spec)) }; }),
    ...news.map((entry) => ({ url: u(`/news/entry/${entry.slug}`), lastModified: entry.modifiedAt ?? entry.publishedAt })),
    ...visibleArticles().filter((a) => a.status === "published" && !a.sample).map((a) => ({ url: u(articlePath(a)), lastModified: a.updatedAt ?? a.publishedAt })),
    ...items.map((r) => ({ url: u(itemPath(r.itemId!)), lastModified: r.updatedAt ?? undefined })),
    ...sources.map((r) => ({ url: u(sourcePath(r.sourceType!, r.sourceId!).split("#")[0]!), lastModified: r.updatedAt ?? undefined })),
    ...zones.map((r) => ({ url: u(zonePath(r.mapId!)) })),
  ];
}
