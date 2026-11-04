import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLASSES } from "@/lib/classes/classes";
import { articleMetadata } from "@/components/ArticleViews";
import {
  articleCoverImages, COVER_CARD_SIZE, COVER_MASTER_SIZE, COVER_MOBILE_SIZE, COVER_SOCIAL_SIZE, SLUG_COVER_ART,
} from "@/lib/content/article-media";
import { loadAllArticles, type Article } from "@/lib/content/loader";
import { RACE_GUIDES } from "@/lib/races/registry";

/**
 * The two WoW: Forever launch posts (Beginner's Guide, Race & Class Combinations): content integrity, cover assets,
 * link targets, and the factual claims that can be checked mechanically against AzerDex's own race/class data.
 * Claims that only Blizzard can confirm (Heroic Pack requirement, preset contents, ...) are verified against the
 * official pages listed in each article's source line, as recorded in the pull request.
 */
const SLUGS = ["wow-forever-beginners-guide-2026", "wow-forever-new-race-class-combinations"] as const;
const PUBLIC = join(process.cwd(), "public");
const articles = Object.fromEntries(SLUGS.map((s) => [s, loadAllArticles().find((a) => a.slug === s)!])) as Record<(typeof SLUGS)[number], Article>;

/** Width/height of a WebP file from its RIFF header (VP8, VP8L and VP8X), so the test needs no image library. */
function webpSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  expect(b.toString("ascii", 0, 4)).toBe("RIFF");
  expect(b.toString("ascii", 8, 12)).toBe("WEBP");
  const kind = b.toString("ascii", 12, 16);
  if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L") {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  throw new Error(`unexpected WebP chunk ${kind}`);
}

const links = (md: string) => [...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);

describe("launch articles: frontmatter", () => {
  it.each(SLUGS)("%s is published, not a sample, and has an original-illustration cover", (slug) => {
    const a = articles[slug];
    expect(a).toBeDefined();
    expect(a.section).toBe("blog");
    expect(a.status).toBe("published");
    expect(a.sample).toBe(false);
    expect(a.description.length).toBeGreaterThanOrEqual(90);
    expect(a.description.length).toBeLessThanOrEqual(200);
    expect(a.cover).toEqual({
      src: `/content-images/blog/${slug}.webp`,
      alt: expect.stringMatching(/^[A-Z].{20,}/),
      attribution: "Original AzerDex editorial illustration",
    });
  });

  it("the two covers are distinct and each article cross-links the other", () => {
    expect(articles[SLUGS[0]].cover!.src).not.toBe(articles[SLUGS[1]].cover!.src);
    expect(articles[SLUGS[0]].cover!.alt).not.toBe(articles[SLUGS[1]].cover!.alt);
    expect(links(articles[SLUGS[0]].body)).toContain(`/blog/${SLUGS[1]}`);
    expect(links(articles[SLUGS[1]].body)).toContain(`/blog/${SLUGS[0]}`);
  });

  it("only Beginner's Guide is featured, and the two articles do not share art mappings", () => {
    expect(articles[SLUGS[0]].featured).toBe(true);
    expect(articles[SLUGS[1]].featured).toBe(false);
    const files = SLUGS.flatMap((s) => Object.values(SLUG_COVER_ART[s]!).filter((v) => v.startsWith("/")));
    expect(new Set(files).size).toBe(files.length);
  });
});

describe("launch articles: cover assets", () => {
  it.each(SLUGS)("%s: every variant exists, is WebP, and has the documented dimensions", (slug) => {
    const img = articleCoverImages(articles[slug])!;
    const art = SLUG_COVER_ART[slug]!;
    const check = (src: string, size: { width: number; height: number }) => {
      const file = join(PUBLIC, src);
      expect(existsSync(file), src).toBe(true);
      expect(webpSize(file), src).toEqual(size);
    };
    check(img.hero.src, COVER_MASTER_SIZE);
    check(art.mobileSrc, COVER_MOBILE_SIZE);
    check(art.cardSrc, COVER_CARD_SIZE);
    check(art.socialSrc, COVER_SOCIAL_SIZE);
    // Responsive crops keep payloads small: the master is the largest file, and nothing is heavier than 400 KB.
    for (const src of [img.hero.src, art.mobileSrc, art.cardSrc, art.socialSrc]) expect(readFileSync(join(PUBLIC, src)).length).toBeLessThan(400 * 1024);
  });

  it("an article with a cover but no variant mapping still gets a hero from cover.src alone", () => {
    const img = articleCoverImages({ slug: "unmapped-article", cover: { src: "/content-images/blog/x.webp", alt: "x alt text", attribution: "attr text" } })!;
    expect(img.hero.mobileSrc).toBe("/content-images/blog/x.webp");
    expect(img.card.src).toBe("/content-images/blog/x.webp");
    expect(articleCoverImages({ slug: "none", cover: undefined })).toBeNull();
  });
});

describe("launch articles: links and wording", () => {
  const classIds = new Set(CLASSES.map((c) => c.id));
  const raceSlugs = new Set(RACE_GUIDES.map((g) => g.slug));
  const published = new Set(loadAllArticles().filter((a) => a.status === "published").map((a) => `/${a.section}/${a.slug}`));
  const OFFICIAL = new Set(["news.blizzard.com", "worldofwarcraft.blizzard.com"]);

  it.each(SLUGS)("%s: every internal link resolves to a real route and every external link is an official Blizzard page", (slug) => {
    const all = links(articles[slug].body);
    expect(all.length).toBeGreaterThan(10);
    for (const href of all) {
      if (href.startsWith("/")) {
        const [, a, b] = href.split("/");
        if (a === "guides" && b === "classes") expect(["/guides/classes", ...[...classIds].map((c) => `/guides/classes/${c}`)]).toContain(href);
        else if (a === "guides" && b === "races") expect(["/guides/races", ...[...raceSlugs].map((r) => `/guides/races/${r}`)]).toContain(href);
        else if (a === "news" && !b) expect(href).toBe("/news");
        else if (a === "blog") expect(published.has(href), href).toBe(true);
        else throw new Error(`unexpected internal link ${href}`);
      } else {
        const u = new URL(href);
        expect(u.protocol).toBe("https:");
        expect(OFFICIAL.has(u.hostname), href).toBe(true);
      }
    }
  });

  it.each(SLUGS)("%s: links the class and race guide indexes and /news where the brief requires", (slug) => {
    const all = links(articles[slug].body);
    expect(all).toContain("/guides/classes");
    expect(all).toContain("/guides/races");
  });
  it("the Beginner's Guide links News; both cite official sources", () => {
    expect(links(articles[SLUGS[0]].body)).toContain("/news");
    for (const s of SLUGS) expect(links(articles[s].body).filter((h) => h.startsWith("https://")).length).toBeGreaterThanOrEqual(4);
  });

  it.each(SLUGS)("%s: stays evergreen and keeps the independence disclosure / no-endorsement stance", (slug) => {
    const body = articles[slug].body;
    expect(body).not.toMatch(/\b(today|tonight|tomorrow|just launched|launch day|this week|coming soon|will launch)\b/i);
    expect(body).not.toMatch(/\b(tier list S|best-in-slot|BiS|top[- ]tier)\b/);
    expect(body).not.toMatch(/\b\d+(\.\d+)?\s?%/); // no racial percentages: AzerDex has not verified them in the release client
    expect(body).not.toMatch(/official(ly)? (endorsed|partner)/i);
  });
  it("the Beginner's Guide carries the fan-project non-affiliation line", () => {
    expect(articles[SLUGS[0]].body).toContain("AzerDex is an independent fan project, not an official Blizzard publication.");
  });
  it("the Race & Class article preserves the 'not verified in the live release client' distinction", () => {
    expect(articles[SLUGS[1]].body).toMatch(/not every ability has been verified against the live release client/i);
    expect(articles[SLUGS[1]].body).toMatch(/numerical racial details have not been verified against the live release client/i);
  });
});

describe("launch articles: facts checked against AzerDex race/class data", () => {
  const race = (slug: string) => RACE_GUIDES.find((g) => g.slug === slug)!;
  const classesOf = (slug: string) => race(slug).classes.map((c) => c.classId).sort();

  it("exactly the six announced combinations are new, and every one is named in both articles", () => {
    const newPairs = RACE_GUIDES.flatMap((g) => g.classes.filter((c) => c.isNew).map((c) => `${g.slug}/${c.classId}`)).sort();
    expect(newPairs).toEqual(["dwarf/shaman", "gnome/priest", "human/hunter", "orc/mage", "troll/warlock", "undead/paladin"]);
    const names = ["Human Hunter", "Dwarf Shaman", "Gnome Priest", "Orc Mage", "Troll Warlock", "Undead Paladin"];
    for (const s of SLUGS) for (const n of names) expect(articles[s].body, `${s}: ${n}`).toContain(n);
    expect(race("human").faction).toBe("alliance");
    expect(["dwarf", "gnome"].map((r) => race(r).faction)).toEqual(["alliance", "alliance"]);
    expect(["orc", "troll", "undead"].map((r) => race(r).faction)).toEqual(["horde", "horde", "horde"]);
  });

  it("Skyborne class lists: High Order (Alliance) has Mage, Windshaper (Horde) has Shaman, four shared", () => {
    expect(classesOf("high-order-skyborne")).toEqual(["druid", "hunter", "mage", "rogue", "warrior"]);
    expect(classesOf("windshaper-skyborne")).toEqual(["druid", "hunter", "rogue", "shaman", "warrior"]);
    expect(race("high-order-skyborne").faction).toBe("alliance");
    expect(race("windshaper-skyborne").faction).toBe("horde");
    const body = articles[SLUGS[1]].body;
    const section = (title: string) => body.slice(body.indexOf(title), body.indexOf(title) + 260);
    for (const c of ["Druid", "Hunter", "Mage", "Rogue", "Warrior"]) expect(section("**High Order Skyborne"), c).toContain(`- ${c}`.replace("- Mage", "- **Mage"));
    for (const c of ["Druid", "Hunter", "Rogue", "Shaman", "Warrior"]) expect(section("**Windshaper Skyborne"), c).toContain(`- ${c}`.replace("- Shaman", "- **Shaman"));
  });

  it("nine classes, three talent trees each, and every race has two active and two passive abilities", () => {
    expect(CLASSES).toHaveLength(9);
    expect(articles[SLUGS[0]].body).toContain("nine playable classes");
    for (const g of RACE_GUIDES) expect([g.slug, g.active.length, g.passive.length]).toEqual([g.slug, 2, 2]);
  });

  it("talent tree names quoted in the Race & Class article exist in the class data", async () => {
    const { getSpecs } = await import("@/lib/classes/classes");
    const trees = (id: string) => getSpecs(id).map((s) => s.tree.name);
    for (const t of ["Beast Mastery", "Marksmanship", "Survival"]) expect(trees("hunter")).toContain(t);
    for (const t of ["Elemental Combat", "Enhancement", "Restoration"]) expect(trees("shaman")).toContain(t);
    for (const t of ["Affliction", "Demonology", "Destruction"]) expect(trees("warlock")).toContain(t);
    for (const t of ["Holy", "Protection", "Retribution"]) expect(trees("paladin")).toContain(t);
  });
});

describe("launch articles: SEO metadata", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(SLUGS)("%s: unique title/description, canonical, Open Graph and Twitter large-image card", async (slug) => {
    const a = articles[slug];
    const m = await articleMetadata("blog", slug);
    expect(m.title).toBe(a.title);
    expect(m.description).toBe(a.description);
    expect(m.alternates?.canonical).toBe(`/blog/${slug}`);
    const og = m.openGraph as { type: string; url: string; images: { url: string; width: number; height: number; alt: string }[] };
    expect(og.type).toBe("article");
    expect(og.url).toBe(`/blog/${slug}`);
    expect(og.images).toEqual([{ url: SLUG_COVER_ART[slug]!.socialSrc, width: 1200, height: 630, alt: a.cover!.alt }]);
    const tw = m.twitter as { card: string; images: { url: string; alt: string }[] };
    expect(tw.card).toBe("summary_large_image");
    expect(tw.images[0]).toEqual({ url: SLUG_COVER_ART[slug]!.socialSrc, alt: a.cover!.alt });
  });

  it("titles and descriptions are unique across the whole content set", () => {
    const all = loadAllArticles();
    expect(new Set(all.map((a) => a.title)).size).toBe(all.length);
    expect(new Set(all.map((a) => a.description)).size).toBe(all.length);
  });

  it("an article without cover art keeps the previous metadata shape (no images, no twitter override)", async () => {
    const m = await articleMetadata("blog", "building-a-safe-public-database");
    expect((m.openGraph as { images?: unknown }).images).toBeUndefined();
    expect(m.twitter).toBeUndefined();
  });
});

describe("launch articles: sitemap", () => {
  const SITE = "https://foreverdb.example";
  const production = {
    VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "foreverdb.example", FOREVERDB_DEPLOYMENT: "production",
    FOREVERDB_DATA_SOURCE: "postgres", SITE_URL: SITE,
    AZERDEX_READ_DB_URL: "postgresql://foreverdb_web_reader.abcdefghijklmnop:pw@aws-0-eu.pooler.example.com:6543/postgres",
    RATE_LIMIT_BACKEND: "upstash", UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t".repeat(30),
    RATE_LIMIT_SALT: "s".repeat(40), TRUSTED_IP_HEADER: "x-real-ip",
  };
  async function sitemapFor(env: Record<string, string>) {
    vi.resetModules();
    for (const k of Object.keys(process.env)) if (/^(FOREVERDB_|VERCEL|SITE_URL|RATE_LIMIT|UPSTASH|AZERDEX_READ|TRUSTED_IP)/.test(k)) delete process.env[k];
    Object.assign(process.env, env);
    vi.doMock("@/lib/data", () => ({ data: () => ({ sitemap: async () => [], newsList: async () => ({ rows: [], total: 0 }) }) }));
    return (await import("@/app/sitemap")).default();
  }
  afterEach(() => { vi.doUnmock("@/lib/data"); vi.resetModules(); });

  it("production lists both published, non-sample posts and not the editorial sample; preview/local list nothing", async () => {
    const urls = (await sitemapFor(production)).map((e) => e.url);
    for (const s of SLUGS) expect(urls.filter((u) => u === `${SITE}/blog/${s}`)).toHaveLength(1);
    expect(urls).not.toContain(`${SITE}/blog/building-a-safe-public-database`);
    expect(await sitemapFor({ VERCEL: "1", VERCEL_ENV: "preview", FOREVERDB_DEPLOYMENT: "preview", FOREVERDB_DATA_SOURCE: "fixture", VERCEL_URL: "x-abc.vercel.app", VERCEL_BRANCH_URL: "x-git-y.vercel.app" })).toEqual([]);
    expect(await sitemapFor({})).toEqual([]);
  });
});
