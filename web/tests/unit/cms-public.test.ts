import { afterEach, describe, expect, it, vi } from 'vitest';

const { query, connection } = vi.hoisted(() => ({ query: vi.fn(), connection: vi.fn() }));
vi.mock('next/server', () => ({ connection }));
vi.mock('pg', () => ({ default: { Pool: class { query = query; } } }));
vi.mock('@/lib/env', () => ({ serverEnv: () => ({
  FOREVERDB_DEPLOYMENT: process.env.FOREVERDB_DEPLOYMENT,
  FOREVERDB_DATA_SOURCE: 'postgres', hosted: Boolean(process.env.VERCEL_ENV),
  AZERDEX_READ_DB_URL: process.env.AZERDEX_READ_DB_URL,
}) }));

afterEach(() => { vi.unstubAllEnvs(); query.mockReset(); connection.mockReset(); });

describe('disposable CMS public adapter', () => {
  it('stays off for hosted and non-loopback configurations', async () => {
    const { cmsPublicEnabled, cmsArticles } = await import('@/lib/content/cms-public');
    vi.stubEnv('FDB_CMS_DISPOSABLE', '1'); vi.stubEnv('FOREVERDB_DEPLOYMENT', 'local');
    vi.stubEnv('AZERDEX_READ_DB_URL', 'postgres://foreverdb_web_reader@127.0.0.1/public');
    expect(cmsPublicEnabled()).toBe(true);
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(cmsPublicEnabled()).toBe(false);
    expect(await cmsArticles()).toEqual([]);
    vi.stubEnv('VERCEL_ENV', '');
    vi.stubEnv('AZERDEX_READ_DB_URL', 'postgres://foreverdb_web_reader@public.example/public');
    expect(cmsPublicEnabled()).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns a tombstone without exposing an older revision', async () => {
    const { cmsArticle } = await import('@/lib/content/cms-public');
    vi.stubEnv('FDB_CMS_DISPOSABLE', '1'); vi.stubEnv('FOREVERDB_DEPLOYMENT', 'local');
    vi.stubEnv('AZERDEX_READ_DB_URL', 'postgres://foreverdb_web_reader@127.0.0.1/public');
    query.mockResolvedValueOnce({ rows: [{ value: { slug: 'test-article', tombstone: true } }] });
    expect(await cmsArticle('test-article')).toEqual({ tombstone: true, article: null });
    expect(connection).toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith('select web_api.cms_article($1) as value', ['test-article']);
  });
});
