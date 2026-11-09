import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLASSES } from "@/lib/classes/classes";
import { articleMetadata } from "@/components/ArticleViews";
import {
  articleCoverImages, COVER_CARD_SIZE, COVER_MASTER_SIZE, COVER_MOBILE_SIZE, COVER_SOCIAL_SIZE, SLUG_COVER_ART,
} from "@/lib/content/article-media";
import { SLUG_FEATURE, ROSTER_MARKER, splitAtRosterMarker } from "@/lib/content/feature-articles";
import { extractGuideToc } from "@/lib/content/toc";
import { getArticle, loadAllArticles, visibleArticles } from "@/lib/content/loader";
import { pickLeadArticle } from "@/components/news/NewsFeatureLead";

/** "World First: Level 60" editorial (Team Jokerd): content integrity, factual guard-rails, assets, SEO and feed behaviour. */
const SLUG = "jokerd-team-world-first-level-60-wow-forever";
const PUBLIC = join(process.cwd(), "public");
const article = loadAllArticles().find((a) => a.slug === SLUG)!;
const bodyText = article.body;

function webpSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  expect(b.toString("ascii", 0, 4)).toBe("RIFF");
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
  if (kind === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  throw new Error(`unexpected WebP chunk ${kind}`);
}

describe("world first article: content", () => {
  it("is a published, non-sample, featured News article under the AzerDex editorial identity", () => {
    expect(article.section).toBe("news");
    expect(article.status).toBe("published");
    expect(article.sample).toBe(false);
    expect(article.featured).toBe(true);
    expect(article.author).toBe("AzerDex Editorial");
    expect(article.publishedAt.slice(0, 10)).toBe("2026-11-07");
    expect(article.title).toBe("WORLD FIRST: Jokerd's Team Reaches Level 60 in WoW: Forever in Just 52 Hours");
    expect(getArticle("news", SLUG)).not.toBeNull();
  });

  it("body is 600-900 words", () => {
    const words = bodyText.replace(/<!--.*?-->/g, " ").split(/\s+/).filter(Boolean).length;
    expect(words).toBeGreaterThanOrEqual(600);
    expect(words).toBeLessThanOrEqual(900);
  });

  it("credits all five players and states the confirmed facts", () => {
    for (const n of ["Jokerd Prime", "Burning Speed", "Vitochie Gofast", "Cloud Bells", "Lmgd Mmr"]) {
      expect(SLUG_FEATURE[SLUG]!.roster.map((p) => p.name)).toContain(n);
    }
    for (const n of ["Jokerd Prime", "Burning Speed", "Vitochie Gofast", "Cloud Bells", "Lmgd Mmr"]) expect(bodyText).toContain(n);
    for (const phrase of ["November 7, 2026", "52 hours", "Horde", "Normal ruleset", "Arcane Explosion", "final 4% of level 59"]) expect(bodyText).toContain(phrase);
  });

  it("is never presented as an official Blizzard announcement and invents no quotes", () => {
    expect(bodyText).toMatch(/not a Blizzard announcement/i);
    expect(bodyText).not.toMatch(/[“"][^"”\n]{12,}[”"]/); // no quoted speech in the body
  });

  it("renders no closing sources block and hotlinks no external or competitor images", () => {
    expect(extractGuideToc(article.body).map((t) => t.text.toLowerCase())).not.toContain("sources and notes");
    expect(article.body).not.toMatch(/https?:\/\//);
    expect(article.body).not.toMatch(/!\[/);
  });

  it("internal links resolve to real AzerDex routes", () => {
    const classIds = new Set(CLASSES.map((c) => c.id));
    const internal = [...article.body.matchAll(/\]\((\/[^)\s]*)\)/g)].map((m) => m[1]!);
    expect(internal.length).toBeGreaterThanOrEqual(4);
    for (const href of internal) {
      const [, a, b, c] = href.split("/");
      if (a === "guides" && b === "classes") expect(classIds.has(c!)).toBe(true);
      else if (a === "blog") expect(getArticle("blog", b!)).not.toBeNull();
      else throw new Error(`unexpected internal link ${href}`);
    }
    for (const ref of article.related.articles) {
      const [sec, sl] = ref.split("/") as ["blog", string];
      expect(getArticle(sec, sl)).not.toBeNull();
    }
  });

  it("has a table of contents with unique heading ids and the roster marker exactly once", () => {
    const toc = extractGuideToc(article.body);
    expect(toc.length).toBeGreaterThanOrEqual(5);
    expect(new Set(toc.map((t) => t.id)).size).toBe(toc.length);
    expect(article.body.split(ROSTER_MARKER)).toHaveLength(2);
    const { before, after } = splitAtRosterMarker(article.body);
    expect(after).not.toBeNull();
    expect(extractGuideToc(before).map((t) => t.id).some((id) => extractGuideToc(after!).some((t) => t.id === id))).toBe(false);
  });

  it("feature presentation data matches the headline stats", () => {
    expect(SLUG_FEATURE[SLUG]!.stats.map((s) => `${s.value} ${s.label}`)).toEqual(["52 Hours", "5 Players", "60 Level"]);
    expect(SLUG_FEATURE[SLUG]!.roster.filter((p) => p.classId === "mage")).toHaveLength(3);
  });
});

describe("world first article: cover assets", () => {
  it("cover frontmatter and every responsive variant exist with documented dimensions", () => {
    expect(article.cover).toEqual({
      src: `/content-images/news/${SLUG}.webp`,
      alt: expect.stringMatching(/^[A-Z].{40,}/),
      attribution: "Owner-supplied AzerDex editorial illustration",
    });
    const art = SLUG_COVER_ART[SLUG]!;
    // poster cover: phones reuse the hero file and the poster hero is shown uncropped
    expect(art.mobileSrc).toBe(article.cover!.src);
    expect(SLUG_FEATURE[SLUG]!.poster).toBe(true);
    const checks: [string, { width: number; height: number }][] = [
      [article.cover!.src, COVER_MASTER_SIZE], [art.cardSrc, COVER_CARD_SIZE], [art.socialSrc, COVER_SOCIAL_SIZE],
      // code-authored fallback art keeps the original hero/mobile/card/social cut
      [art.fallbackSrc!, COVER_MASTER_SIZE], [art.fallbackSrc!.replace("-art.webp", "-art-mobile.webp"), COVER_MOBILE_SIZE],
      [art.fallbackSrc!.replace("-art.webp", "-art-card.webp"), COVER_CARD_SIZE], [art.fallbackSrc!.replace("-art.webp", "-art-social.webp"), COVER_SOCIAL_SIZE],
    ];
    for (const [src, size] of checks) {
      const file = join(PUBLIC, src);
      expect(existsSync(file), src).toBe(true);
      expect(webpSize(file)).toEqual(size);
      expect(readFileSync(file).length).toBeLessThan(400_000);
    }
  });
});

describe("world first article: SEO and /news lead", () => {
  it("metadata: canonical, article Open Graph, 1200x630 image with alt, large-image Twitter card", async () => {
    const m = await articleMetadata("news", SLUG);
    expect(m.alternates?.canonical).toBe(`/news/${SLUG}`);
    const og = m.openGraph as { type: string; images: { url: string; width: number; height: number; alt: string }[] };
    expect(og.type).toBe("article");
    expect(og.images).toEqual([{ url: SLUG_COVER_ART[SLUG]!.socialSrc, width: 1200, height: 630, alt: article.cover!.alt }]);
    expect((m.twitter as { card: string }).card).toBe("summary_large_image");
  });

  it("articleCoverImages exposes the social crop used for structured data", () => {
    expect(articleCoverImages(article)!.social.src).toBe(SLUG_COVER_ART[SLUG]!.socialSrc);
  });

  it("is the /news lead story; unfeatured, sample or cover-less articles never are", () => {
    expect(pickLeadArticle(visibleArticles("news"))?.slug).toBe(SLUG);
    expect(pickLeadArticle([{ ...article, featured: false }])).toBeNull();
    expect(pickLeadArticle([{ ...article, sample: true }])).toBeNull();
    expect(pickLeadArticle([{ ...article, cover: undefined }])).toBeNull();
    expect(pickLeadArticle([{ ...article, status: "draft" }])).toBeNull();
  });
});

describe("world first article: feeds", () => {
  afterEach(() => { vi.doUnmock("@/lib/data"); vi.resetModules(); vi.unstubAllEnvs(); });

  it("RSS lists the editorial piece at its dedicated URL beside, not instead of, database news entries", async () => {
    vi.resetModules();
    vi.doMock("@/lib/data", () => ({
      data: () => ({ newsList: async () => ({ total: 1, rows: [{ title: "Hotfix", slug: "us-hotfix", entryKind: "bluepost", category: "bluepost", region: "us", excerpt: "x", publishedAt: "2026-11-06T10:00:00.000Z", officialUpdatedAt: null }] }) }),
    }));
    const xml = await (await (await import("@/app/news/rss.xml/route")).GET()).text();
    expect(xml).toContain(`/news/${SLUG}</link>`);
    expect(xml).toContain("/news/entry/us-hotfix</link>");
    expect(xml).not.toContain("[Sample] WORLD FIRST");
    expect(xml.indexOf(`/news/${SLUG}`)).toBeLessThan(xml.indexOf("/news/entry/us-hotfix"));
  });
});
