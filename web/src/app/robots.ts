import type { MetadataRoute } from "next";
import { isIndexable, serverEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const env = serverEnv();
  if (!isIndexable(env)) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/verify"] }],
    sitemap: new URL("/sitemap.xml", env.SITE_URL).toString(),
  };
}
