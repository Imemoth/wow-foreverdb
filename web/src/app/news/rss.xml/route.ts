import { articlePath, visibleArticles } from "@/lib/content/loader";
import { data } from "@/lib/data";
import { serverEnv } from "@/lib/env";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

export async function GET() {
  const base = serverEnv().SITE_URL.replace(/\/$/, "");
  const items = visibleArticles("news").filter((a) => a.status === "published").slice(0, 30);
  const databaseItems = await data().newsList({ category: null, query: "", page: 1, pageSize: 30 }).then((result) => result.rows).catch(() => []);
  const rssItems = [
    ...items.map((a) => ({ title: a.sample ? `[Sample] ${a.title}` : a.title, link: base + articlePath(a), date: a.publishedAt, description: a.description, categories: a.tags })),
    ...databaseItems.map((entry) => ({ title: entry.title, link: `${base}/news/entry/${entry.slug}`, date: entry.publishedAt, description: entry.excerpt, categories: [entry.category, entry.region] })),
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>AzerDex News</title>
<link>${esc(base)}/news</link>
<atom:link href="${esc(base)}/news/rss.xml" rel="self" type="application/rss+xml"/>
<description>WoW: Forever and AzerDex news</description>
<language>en</language>
${rssItems.map((item) => `<item>
<title>${esc(item.title)}</title>
<link>${esc(item.link)}</link>
<guid isPermaLink="true">${esc(item.link)}</guid>
<pubDate>${new Date(item.date).toUTCString()}</pubDate>
<description>${esc(item.description)}</description>
${item.categories.map((t) => `<category>${esc(t)}</category>`).join("")}
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
