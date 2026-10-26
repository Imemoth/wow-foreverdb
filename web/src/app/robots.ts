import type { MetadataRoute } from "next";
import { isIndexable, serverEnv } from "@/lib/env";
import { BETA_SEO_HOSTNAME, isIndexablePublicBetaHost, requestHostname } from "@/lib/seo";

export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const env = serverEnv();
  if (await isIndexablePublicBetaHost(env, await requestHostname())) {
    // Only "/" is indexable here (enforced per-page by isPublicBetaHomepage/robotsFor), but Google
    // must still be able to CRAWL every other beta page to see its own noindex directive - a
    // disallow would hide that noindex instead of enforcing it. Same non-content exclusions as
    // production: /api/ returns no indexable markup, and /verify is a technical challenge page.
    return {
      rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/verify"] }],
      sitemap: `https://${BETA_SEO_HOSTNAME}/sitemap.xml`,
    };
  }
  if (!isIndexable(env)) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/verify"] }],
    sitemap: new URL("/sitemap.xml", env.SITE_URL).toString(),
  };
}
