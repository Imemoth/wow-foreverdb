import { afterEach, describe, expect, it, vi } from "vitest";

const SITE = "https://foreverdb.example";
// Same shape as the valid production fixture in env-matrix.test.ts (the policy refuses unsafe production configurations).
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
  // The public database is irrelevant here: only the static guide entries are under test.
  vi.doMock("@/lib/data", () => ({
    data: () => ({ sitemap: async () => [], newsList: async () => ({ rows: [], total: 0 }) }),
  }));
  return (await import("@/app/sitemap")).default();
}

describe("race guides in the sitemap and robots policy", () => {
  afterEach(() => { vi.doUnmock("@/lib/data"); vi.resetModules(); });

  it("production lists the overview and all ten race pages exactly once", async () => {
    const urls = (await sitemapFor(production)).map((e) => e.url);
    expect(urls).toContain(`${SITE}/guides/races`);
    const races = urls.filter((u) => u.startsWith(`${SITE}/guides/races/`));
    expect(races.sort()).toEqual(
      ["human", "dwarf", "night-elf", "gnome", "high-order-skyborne", "orc", "tauren", "troll", "undead", "windshaper-skyborne"].map((r) => `${SITE}/guides/races/${r}`).sort(),
    );
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toContain(`${SITE}/guides/classes`); // existing entries untouched
  });

  it("preview and local stay empty (no race URL becomes indexable outside production)", async () => {
    expect(await sitemapFor({ VERCEL: "1", VERCEL_ENV: "preview", FOREVERDB_DEPLOYMENT: "preview", FOREVERDB_DATA_SOURCE: "fixture", VERCEL_URL: "x-abc.vercel.app", VERCEL_BRANCH_URL: "x-git-y.vercel.app" })).toEqual([]);
    expect(await sitemapFor({})).toEqual([]);
  });
});
