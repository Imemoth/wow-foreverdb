import { articlePath, visibleArticles } from "@/lib/content/loader";
import { serverEnv } from "@/lib/env";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export async function GET() {
  const base = serverEnv().SITE_URL.replace(/\/$/, "");
  const items = visibleArticles("news").filter((a) => a.status === "published").slice(0, 30);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>ForeverDB News</title>
<link>${esc(base)}/news</link>
<atom:link href="${esc(base)}/news/rss.xml" rel="self" type="application/rss+xml"/>
<description>WoW: Forever and ForeverDB news</description>
<language>en</language>
${items.map((a) => `<item>
<title>${esc(a.sample ? `[Sample] ${a.title}` : a.title)}</title>
<link>${esc(base + articlePath(a))}</link>
<guid isPermaLink="true">${esc(base + articlePath(a))}</guid>
<pubDate>${new Date(a.publishedAt).toUTCString()}</pubDate>
<description>${esc(a.description)}</description>
${a.tags.map((t) => `<category>${esc(t)}</category>`).join("")}
</item>`).join("\n")}
</channel>
</rss>`;
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=900",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
