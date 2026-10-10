import "@fontsource-variable/cinzel/wght.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource/jetbrains-mono/400.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { DatasetBanner } from "@/components/DatasetBanner";
import { JsonLd } from "@/components/JsonLd";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { isIndexable, serverEnv } from "@/lib/env";
import { pageContext } from "@/lib/page";

export async function generateMetadata(): Promise<Metadata> {
  const env = serverEnv();
  return {
    metadataBase: new URL(env.SITE_URL),
    title: { default: "ForeverDB — WoW: Forever observed loot & gathering database", template: "%s · ForeverDB" },
    description:
      "Search community-observed loot, skinning, mining, herbalism and fishing data for World of Warcraft: Forever, with honest sample sizes.",
    applicationName: "ForeverDB",
    openGraph: { siteName: "ForeverDB", type: "website", locale: "en_US" },
    twitter: { card: "summary" },
    alternates: { types: { "application/rss+xml": "/news/rss.xml" } },
    // Preview/local builds are never indexed.
    robots: isIndexable(env) ? { index: true, follow: true } : { index: false, follow: false },
    // Lets tests and operators tell a preview from a real production release in the HTML itself.
    other: { "foreverdb-deployment": env.FOREVERDB_DEPLOYMENT },
    icons: { icon: "/icon.svg" },
  };
}

export const viewport: Viewport = { themeColor: "#090b10", colorScheme: "dark" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { nonce, db, baseUrl } = await pageContext();
  const meta = await db.meta().catch(() => null);
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <a href="#main" className="skip-link">Skip to content</a>
        {meta && <DatasetBanner meta={meta} />}
        <SiteHeader />
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-8">{children}</main>
        <SiteFooter />
        <JsonLd nonce={nonce} data={{
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "ForeverDB",
          url: baseUrl,
          potentialAction: {
            "@type": "SearchAction",
            target: { "@type": "EntryPoint", urlTemplate: `${baseUrl.replace(/\/$/, "")}/database?q={search_term_string}` },
            "query-input": "required name=search_term_string",
          },
        }} />
      </body>
    </html>
  );
}
