import type { MetadataRoute } from "next";
import { serverEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const env = serverEnv();
  if (env.FOREVERDB_DEPLOYMENT !== "production") return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/verify"] }],
    sitemap: new URL("/sitemap.xml", env.SITE_URL).toString(),
  };
}
