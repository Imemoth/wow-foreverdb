import 'server-only';
import { connection } from 'next/server';
import pg from 'pg';
import { serverEnv } from '@/lib/env';
import type { Article } from './loader';

type Projection = { article_id: string; slug: string; generation: number; tombstone: boolean;
  revision_id: string | null; published_at: string; changed_at: string;
  snapshot: Record<string, unknown> | null };

let pool: pg.Pool | undefined;

/** Compilation and runtime stay inert unless a disposable local process opts in. */
export function cmsPublicEnabled(): boolean {
  const env = serverEnv();
  let loopback = false;
  try { loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(env.AZERDEX_READ_DB_URL || '').hostname); }
  catch { return false; }
  return process.env.FDB_CMS_DISPOSABLE === '1' && env.FOREVERDB_DEPLOYMENT === 'local' &&
    !env.hosted && env.FOREVERDB_DATA_SOURCE === 'postgres' && loopback;
}

function db(): pg.Pool {
  if (!cmsPublicEnabled()) throw new Error('CMS public adapter is inactive');
  return pool ??= new pg.Pool({ connectionString: serverEnv().AZERDEX_READ_DB_URL,
    max: 2, connectionTimeoutMillis: 4000, query_timeout: 5000 });
}

function article(row: Projection): Article {
  const s = row.snapshot;
  if (!s || !row.revision_id || row.tombstone || typeof s.title !== 'string' ||
      typeof s.summary !== 'string' || typeof s.body_markdown !== 'string' ||
      typeof s.byline !== 'string' || typeof s.category !== 'string' ||
      !Array.isArray(s.tags) || !s.tags.every((t) => typeof t === 'string')) {
    throw new Error('Invalid CMS public projection');
  }
  const images = Array.isArray(s.images) ? s.images : [];
  const cover = images[0] as Record<string, unknown> | undefined;
  return {
    section: 'news', slug: row.slug, title: s.title, description: s.summary,
    body: s.body_markdown, author: s.byline, category: s.category, tags: s.tags,
    publishedAt: row.published_at, updatedAt: row.changed_at, status: 'published',
    featured: s.featured === true, sample: s.sample === true,
    readingMinutes: Math.max(1, Math.round(s.body_markdown.split(/\s+/).filter(Boolean).length / 220)),
    related: { items: [], sources: [], articles: [] },
    ...(cover && typeof cover.path === 'string' && typeof cover.alt === 'string' &&
      typeof cover.attribution === 'string' ? { cover: {
        src: cover.path, alt: cover.alt, attribution: cover.attribution,
      } } : {}),
  };
}

export async function cmsArticle(slug: string): Promise<{ tombstone: boolean; article: Article | null } | null> {
  if (!cmsPublicEnabled()) return null;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return null;
  await connection(); // request-bound read: an unpublish cannot be hidden by static page output
  const { rows } = await db().query('select web_api.cms_article($1) as value', [slug]);
  const value = rows[0]?.value as Projection | null;
  if (!value) return null;
  return value.tombstone ? { tombstone: true, article: null } : { tombstone: false, article: article(value) };
}

export async function cmsArticles(): Promise<Article[]> {
  if (!cmsPublicEnabled()) return [];
  await connection();
  const out: Article[] = [];
  for (let offset = 0; offset <= 10000; offset += 50) {
    const { rows } = await db().query('select web_api.cms_list($1,$2) as value', [50, offset]);
    for (const row of rows) out.push(article(row.value as Projection));
    if (rows.length < 50) break;
  }
  return out;
}
