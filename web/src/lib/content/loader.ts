import "server-only";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { serverEnv } from "../env";

/**
 * Repository-managed editorial content (Markdown + YAML frontmatter).
 * Publishing = a reviewed pull request; there is no public admin surface.
 * Markdown is rendered without raw HTML and without executable MDX.
 */

export const SECTIONS = ["news", "guides", "blog"] as const;
export type Section = (typeof SECTIONS)[number];

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(3).max(80);
const isoDate = z.union([z.string(), z.date()]).transform((v, ctx) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid date" });
    return z.NEVER;
  }
  return d.toISOString();
});

const Frontmatter = z
  .object({
    title: z.string().min(3).max(120),
    description: z.string().min(20).max(200),
    slug,
    category: z.string().min(2).max(40),
    tags: z.array(z.string().regex(/^[a-z0-9-]{2,30}$/)).max(10).default([]),
    author: z.string().min(2).max(60),
    publishedAt: isoDate,
    updatedAt: isoDate.optional(),
    status: z.enum(["draft", "published"]),
    /** Editorial SAMPLE content: rendered with a prominent label until replaced. */
    sample: z.boolean().default(false),
    featured: z.boolean().default(false),
    cover: z
      .object({
        src: z.string().regex(/^\/content-images\/[a-z0-9/_-]+\.(svg|png|jpg|webp)$/),
        alt: z.string().min(3).max(200),
        attribution: z.string().min(3).max(200),
      })
      .strict()
      .optional(),
    related: z
      .object({
        items: z.array(z.number().int().positive()).max(12).default([]),
        sources: z.array(z.object({ type: z.enum(["creature", "gameobject", "fishing"]), id: z.number().int() }).strict()).max(12).default([]),
        articles: z.array(z.string().regex(/^(news|guides|blog)\/[a-z0-9-]{3,80}$/)).max(6).default([]),
      })
      .strict()
      .default({}),
  })
  .strict();

export type Article = z.infer<typeof Frontmatter> & { section: Section; body: string; readingMinutes: number };

const CONTENT_ROOT = join(process.cwd(), "content");

function splitFrontmatter(raw: string): { data: unknown; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error("missing frontmatter");
  // yaml 'core' schema: no custom tags, no code execution.
  return { data: parseYaml(m[1]!, { schema: "core" }), body: m[2]! };
}

let cache: Article[] | null = null;

export function loadAllArticles(): Article[] {
  if (cache && process.env.NODE_ENV === "production") return cache;
  const out: Article[] = [];
  for (const section of SECTIONS) {
    let files: string[] = [];
    try {
      files = readdirSync(join(CONTENT_ROOT, section)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      const raw = readFileSync(join(CONTENT_ROOT, section, file), "utf8");
      const { data, body } = splitFrontmatter(raw);
      const fm = Frontmatter.parse(data);
      if (`${fm.slug}.md` !== file) throw new Error(`content/${section}/${file}: slug must match filename`);
      const words = body.split(/\s+/).filter(Boolean).length;
      out.push({ ...fm, section, body, readingMinutes: Math.max(1, Math.round(words / 220)) });
    }
  }
  out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.slug.localeCompare(b.slug));
  cache = out;
  return out;
}

/** Drafts are only visible in local development, never in preview/production. */
export function visibleArticles(section?: Section): Article[] {
  const showDrafts = serverEnv().FOREVERDB_DEPLOYMENT === "local";
  return loadAllArticles().filter((a) => (showDrafts || a.status === "published") && (!section || a.section === section));
}

export function getArticle(section: Section, s: string): Article | null {
  return visibleArticles(section).find((a) => a.slug === s) ?? null;
}

export function articlePath(a: Pick<Article, "section" | "slug">): string {
  return `/${a.section}/${a.slug}`;
}
