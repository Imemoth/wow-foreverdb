import "@fontsource-variable/cinzel/wght.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { DatasetBanner } from "@/components/DatasetBanner";
import { JsonLd } from "@/components/JsonLd";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { TrafficAnalytics } from "@/components/TrafficAnalytics";
import { isIndexable, serverEnv } from "@/lib/env";
import { pageContext } from "@/lib/page";
import { isPublicAnalyticsHost } from "@/lib/analytics";
import { BETA_SEO_HOSTNAME, isPublicBetaHost, requestHostname } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  const env = serverEnv();
  const betaHost = isPublicBetaHost(env, await requestHostname());
  return {
    metadataBase: new URL(env.SITE_URL),
    title: { default: "AzerDex — Know Your World. WoW: Forever observed loot & gathering database", template: "%s · AzerDex" },
    description:
      "AzerDex is a community-powered database for World of Warcraft: Forever — observed loot, skinning, mining, herbalism and fishing data, with honest sample sizes.",
    applicationName: "AzerDex",
    openGraph: { siteName: "AzerDex", type: "website", locale: "en_US" },
    twitter: { card: "summary" },
    alternates: { types: { "application/rss+xml": "/news/rss.xml" } },
    // Production remains indexable; public beta can be crawled so its noindex is visible.
    robots: isIndexable(env) ? { index: true, follow: true } : { index: false, follow: betaHost },
    // Lets tests and operators tell a preview from a real production release in the HTML itself.
    other: { "foreverdb-deployment": env.FOREVERDB_DEPLOYMENT },
    icons: { icon: "/icon.svg" },
  };
}

export const viewport: Viewport = { themeColor: "#07091c", colorScheme: "dark" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { nonce, db, baseUrl, env } = await pageContext();
  const meta = await db.meta().catch(() => null);
  // Keep beta JSON-LD pointing at the beta host even though it is now noindex.
  const h = await headers();
  const hostname = (h.get("host") ?? "").split(":")[0]!.toLowerCase();
  const jsonLdBase = isPublicBetaHost(env, hostname) ? `https://${BETA_SEO_HOSTNAME}` : baseUrl;
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <a href="#main" className="skip-link">Skip to content</a>
        {meta && <DatasetBanner meta={meta} />}
        <SiteHeader />
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">{children}</main>
        <SiteFooter />
        {env.hosted && isPublicAnalyticsHost(hostname) && <TrafficAnalytics />}
        <JsonLd nonce={nonce} data={{
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "AzerDex",
          url: jsonLdBase,
          potentialAction: {
            "@type": "SearchAction",
            target: { "@type": "EntryPoint", urlTemplate: `${jsonLdBase}/database?q={search_term_string}` },
            "query-input": "required name=search_term_string",
          },
        }} />
      </body>
    </html>
  );
}
