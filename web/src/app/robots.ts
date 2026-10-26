import type { MetadataRoute } from "next";
import { isIndexable, serverEnv } from "@/lib/env";
import { BETA_SEO_HOSTNAME, requestHostname } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const env = serverEnv();
  if (env.FOREVERDB_DEPLOYMENT === "preview" && (await requestHostname()) === BETA_SEO_HOSTNAME) {
    // No beta page is indexable after production launch. Google must be allowed to crawl
    // HTML to read noindex; blocking / here would prevent deindexing of formerly listed URLs.
    // APIs and the challenge endpoint remain excluded.
    return {
      rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/verify"] }],
    };
  }
  if (!isIndexable(env)) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/verify"] }],
    sitemap: new URL("/sitemap.xml", env.SITE_URL).toString(),
  };
}
