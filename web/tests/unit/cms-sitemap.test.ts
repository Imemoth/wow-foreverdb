import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cmsArticles, cmsPublicEnabled } = vi.hoisted(() => ({
  cmsArticles: vi.fn(), cmsPublicEnabled: vi.fn(),
}));
vi.mock('@/lib/content/cms-public', () => ({ cmsArticles, cmsPublicEnabled }));
vi.mock('@/lib/env', () => ({
  serverEnv: () => ({ FOREVERDB_DEPLOYMENT: 'local', SITE_URL: 'http://localhost:3000' }),
  isIndexable: () => false,
}));
vi.mock('@/lib/seo', () => ({
  BETA_SEO_HOSTNAME: 'beta.example', requestHostname: async () => 'localhost',
  isIndexablePublicBetaHost: async () => false,
}));

beforeEach(() => { cmsArticles.mockReset(); cmsPublicEnabled.mockReset(); });

describe('disposable CMS sitemap', () => {
  it('lists the published revision and removes its tombstone on the next read', async () => {
    const { default: sitemap } = await import('@/app/sitemap');
    cmsPublicEnabled.mockReturnValue(true);
    cmsArticles.mockResolvedValueOnce([{ section: 'news', slug: 'cms-live-article',
      sample: false, publishedAt: '2026-11-16T12:00:00Z',
      updatedAt: '2026-11-16T13:00:00Z' }]);
    expect(await sitemap()).toEqual([{ url: 'http://localhost:3000/news/cms-live-article',
      lastModified: '2026-11-16T13:00:00Z' }]);
    cmsArticles.mockResolvedValueOnce([]);
    expect(await sitemap()).toEqual([]);
  });

  it('keeps the existing local noindex sitemap empty by default', async () => {
    const { default: sitemap } = await import('@/app/sitemap');
    cmsPublicEnabled.mockReturnValue(false);
    expect(await sitemap()).toEqual([]);
    expect(cmsArticles).not.toHaveBeenCalled();
  });
});
