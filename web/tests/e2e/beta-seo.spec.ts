import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

/**
 * HTTP-level verification of the narrowly-scoped public-beta homepage SEO exception (see
 * isPublicBetaHomepage in src/lib/seo.ts). Nothing here uses a browser or the shared desktop/mobile
 * webServer: each test spawns its own short-lived `next start` with a specific, realistic
 * Vercel-style environment, exactly like the "unsafe configurations" half of preview-safety.spec.ts.
 *
 * The request's Host header (not request.nextUrl.hostname, which is NOT the incoming Host header
 * on a self-hosted Next.js server) is what proxy.ts and lib/seo.ts key off, so overriding it
 * faithfully simulates what Vercel's own edge sets when routing a request to the custom domain vs.
 * a generated *.vercel.app alias. Node's built-in fetch (undici) silently ignores a custom Host
 * header and always sends the real connection target instead, so requests here shell out to curl,
 * which honors an explicit -H "Host: ..." override exactly as a test like this needs.
 */

const execFileAsync = promisify(execFile);

interface CurlResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function curlGet(url: string, headers: Record<string, string> = {}): Promise<CurlResponse> {
  const args = ["-s", "-i", "--max-time", "10"];
  for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
  args.push(url);
  const { stdout } = await execFileAsync("curl", args, { maxBuffer: 10 * 1024 * 1024 });
  const sep = stdout.indexOf("\r\n\r\n");
  const headPart = sep >= 0 ? stdout.slice(0, sep) : stdout;
  const body = sep >= 0 ? stdout.slice(sep + 4) : "";
  const lines = headPart.split("\r\n");
  const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
  const respHeaders: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) respHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { status, headers: respHeaders, body };
}

const SENSITIVE_PREFIXES = /^(FOREVERDB_|VERCEL|SITE_URL|RATE_LIMIT|UPSTASH|AZERDEX_READ|TRUSTED_IP|TURNSTILE|NEXT_PUBLIC_TURNSTILE|CHALLENGE_|SUPABASE|DATABASE_URL|POSTGRES_|BETA_SEO_)/;

async function withServer(port: number, env: Record<string, string>, run: (base: string) => Promise<void>) {
  const clean: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!SENSITIVE_PREFIXES.test(k)) clean[k] = v;
  const child: ChildProcess = spawn("npx", ["next", "start", "-p", String(port)], {
    env: { ...clean, ...env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
    detached: true,
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
      try {
        await fetch(base, { signal: AbortSignal.timeout(1500) });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    await run(base);
  } finally {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const BETA_HOST = "beta.azerdex.com";
const VERCEL_ALIAS = "wow-foreverdb-git-web-azerdex-beta-imemoths-projects.vercel.app";

/**
 * A published public read model reachable from this test process (the CI job that provisions one sets BETA_SEO_DATABASE_URL to a
 * foreverdb_web_reader URL). The positive tests need a genuine active publication, so they run only where one exists; every negative
 * test runs everywhere. (Its content is whatever that database holds: the policy under test is host/branch/path/publication, not data.)
 */
const DB_URL = process.env.BETA_SEO_DATABASE_URL;
const UNREACHABLE_DB = "postgresql://foreverdb_web_reader:pw@public-db.example.com:6543/postgres";

/** A VALID, fully-authorized public-beta Preview deployment of the web/azerdex-beta branch (data source: the public PostgreSQL read model). */
const authorizedBeta: Record<string, string> = {
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_URL: "wow-foreverdb-abc123-imemoths-projects.vercel.app",
  VERCEL_BRANCH_URL: VERCEL_ALIAS,
  VERCEL_GIT_COMMIT_REF: "web/azerdex-beta",
  BETA_SEO_AUTHORIZED_BRANCH: "web/azerdex-beta",
  FOREVERDB_DEPLOYMENT: "preview",
  FOREVERDB_DATA_SOURCE: "postgres",
  AZERDEX_READ_DB_URL: UNREACHABLE_DB,
  TRUSTED_IP_HEADER: "x-forwarded-for",
};

/** The same deployment but with a reachable database. A local test database cannot satisfy the hosted-address rule, so VERCEL is omitted here. */
const { VERCEL: _v, VERCEL_ENV: _ve, ...authorizedBetaNoPlatform } = authorizedBeta;
void _v; void _ve;
const betaWithPublication: Record<string, string> = { ...authorizedBetaNoPlatform, AZERDEX_READ_DB_URL: DB_URL ?? UNREACHABLE_DB };

let n = 0;
const client = () => ({ "x-forwarded-for": `198.51.100.${(n += 1) % 250}` });

test.describe.configure({ timeout: 90_000 });

test.describe("post-launch beta deindexing (authorized published preview)", () => {
  test.skip(!DB_URL, "needs BETA_SEO_DATABASE_URL (a published public read model)");

  test("homepage is noindex despite authorized published data; canonical points at production", async () => {
    await withServer(3220, betaWithPublication, async (base) => {
      const r = await curlGet(`${base}/`, { Host: BETA_HOST, ...client() });
      expect(r.status).toBe(200);
      expect(r.headers["x-robots-tag"]).toBe("noindex, follow");
      expect(r.headers["x-foreverdb-deployment"]).toBe("preview");
      expect(r.body).toMatch(/<meta name="robots" content="noindex, follow"/);
      expect(r.body).toContain(`<link rel="canonical" href="https://azerdex.com/"`);
      expect(r.body).toContain(`<meta property="og:url" content="https://${BETA_HOST}"`);
      const ld = /"@type":"WebSite"[\s\S]*?"url":"([^"]+)"/.exec(r.body)?.[1];
      expect(ld).toBe(`https://${BETA_HOST}`);
    });
  });

  test("published data only: identifies as public beta, no synthetic wording or banner anywhere on the page", async () => {
    await withServer(3221, betaWithPublication, async (base) => {
      const { body } = await curlGet(`${base}/`, { Host: BETA_HOST, ...client() });
      expect(body).toMatch(/Public beta/);
      expect(body).not.toMatch(/synthetic/i);
      expect(body).toMatch(/Observed data · publication #/);
      const api = await curlGet(`${base}/api/v1/meta`, { Host: BETA_HOST, ...client() });
      const m = JSON.parse(api.body);
      expect(m.mode).toBe("published");
      expect(m.publicationId).toBeGreaterThan(0);
      const mp = JSON.parse((await curlGet(`${base}/api/v1/zones/1420/map-points`, { Host: BETA_HOST, ...client() })).body);
      expect(mp.dataset).toBe("published");
      expect(mp.publicationId).toBe(m.publicationId);
    });
  });

  test("non-indexable beta data pages: Database, Zones, entity, API, verify, Account all stay noindex", async () => {
    await withServer(3222, betaWithPublication, async (base) => {
      for (const path of ["/database", "/zones", "/zone/1420", "/item/2770", "/download"]) {
        const r = await curlGet(`${base}${path}`, { Host: BETA_HOST, ...client() });
        expect(r.headers["x-robots-tag"], path).toBe("noindex, follow");
        expect(r.body, path).toMatch(/<meta name="robots" content="noindex/);
      }
      const verify = await curlGet(`${base}/verify`, { Host: BETA_HOST, ...client() });
      expect(verify.headers["x-robots-tag"]).toBe("noindex, nofollow");
      const api = await curlGet(`${base}/api/v1/meta`, { Host: BETA_HOST, ...client() });
      expect(api.headers["x-robots-tag"]).toBe("noindex, nofollow");
      const account = await curlGet(`${base}/account/login`, { Host: BETA_HOST, ...client() });
      expect(account.headers["x-robots-tag"]).toBe("noindex, nofollow");
    });
  });

  test("non-indexable generated Preview alias: the same build, same branch, no Host override stays noindex", async () => {
    await withServer(3223, betaWithPublication, async (base) => {
      const r = await curlGet(`${base}/`, client()); // Host defaults to 127.0.0.1:PORT, never beta.azerdex.com
      expect(r.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(r.body).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    });
  });

  test("robots.txt permits deindexing and beta sitemap no longer advertises URLs", async () => {
    await withServer(3224, betaWithPublication, async (base) => {
      const robotsTxt = (await curlGet(`${base}/robots.txt`, { Host: BETA_HOST })).body;
      expect(robotsTxt).toMatch(/Allow: \//);
      expect(robotsTxt).toMatch(/Disallow: \/api\//);
      expect(robotsTxt).toMatch(/Disallow: \/verify/);
      // Data pages must stay crawlable so Google can see their own noindex tag - never disallowed here.
      expect(robotsTxt).not.toMatch(/Disallow:\s*\/database/);
      expect(robotsTxt).not.toMatch(/Disallow:\s*\/zones/);
      expect(robotsTxt).not.toMatch(/Disallow:\s*\/zone\//);
      expect(robotsTxt).not.toMatch(/Disallow:\s*\/item\//);
      expect(robotsTxt).not.toMatch(/Sitemap:/);

      const sitemapXml = (await curlGet(`${base}/sitemap.xml`, { Host: BETA_HOST })).body;
      const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      expect(locs).toEqual([]);
      // Never advertises entity pages or sample articles.
      expect(sitemapXml).not.toMatch(/\/item\/|\/creature\/|\/object\/|\/fishing\/|\/zone\/|\/news\/|\/blog\//);

      // Without the Host override (the generated alias), both surfaces revert to fully non-indexable.
      const robotsAlias = (await curlGet(`${base}/robots.txt`)).body;
      expect(robotsAlias).toMatch(/Disallow: \/\s*$/m);
      expect(robotsAlias).not.toMatch(/sitemap/i);
      const sitemapAlias = (await curlGet(`${base}/sitemap.xml`)).body;
      expect(sitemapAlias).not.toContain("<loc>");
    });
  });
});

test.describe("every condition is independently required", () => {
  test("non-indexable development branch: same host, env config copied to the wrong branch stays noindex", async () => {
    await withServer(3225, { ...authorizedBeta, VERCEL_GIT_COMMIT_REF: "feature/unrelated-branch" }, async (base) => {
      const r = await curlGet(`${base}/`, { Host: BETA_HOST, ...client() });
      expect(r.headers["x-robots-tag"]).toBe("noindex, follow");
      expect(r.body).toMatch(/<meta name="robots" content="noindex, nofollow"/);
      const robotsTxt = (await curlGet(`${base}/robots.txt`, { Host: BETA_HOST })).body;
      expect(robotsTxt).toMatch(/Allow: \/\s*$/m);
      expect(robotsTxt).not.toMatch(/Sitemap:/);
    });
  });

  test("not indexable on the synthetic fixture data source, even with host, branch and path all correct", async () => {
    const fixtureBeta: Record<string, string> = { ...authorizedBeta, FOREVERDB_DATA_SOURCE: "fixture" };
    delete fixtureBeta.AZERDEX_READ_DB_URL;
    await withServer(3226, fixtureBeta, async (base) => {
      const r = await curlGet(`${base}/`, { Host: BETA_HOST, ...client() });
      expect(r.headers["x-robots-tag"]).toBe("noindex, follow");
      expect(r.body).toMatch(/<meta name="robots" content="noindex, nofollow"/);
      const robotsTxt = (await curlGet(`${base}/robots.txt`, { Host: BETA_HOST })).body;
      expect(robotsTxt).toMatch(/Allow: \/\s*$/m);
      expect((await curlGet(`${base}/sitemap.xml`, { Host: BETA_HOST })).body).not.toContain("<loc>");
    });
  });

  test("not indexable while the public database has no reachable genuine publication (fails closed, no fixture substitution)", async () => {
    await withServer(3229, authorizedBeta, async (base) => {
      const r = await curlGet(`${base}/`, { Host: BETA_HOST, ...client() });
      expect(r.headers["x-robots-tag"]).toBe("noindex, follow");
      expect(r.body).not.toMatch(/<meta name="robots" content="index/);
      expect(r.body).not.toMatch(/synthetic|invented/i);
      const robotsTxt = (await curlGet(`${base}/robots.txt`, { Host: BETA_HOST })).body;
      expect(robotsTxt).toMatch(/Allow: \/\s*$/m);
      const api = await curlGet(`${base}/api/v1/meta`, { Host: BETA_HOST, ...client() });
      expect(api.status).toBe(503);
      expect(api.body).not.toMatch(/example\.com|postgres|password|pw/i);
    });
  });

  test("protected Production: the env.ts guard refuses to even boot with the beta flag set in production", async () => {
    await withServer(
      3227,
      {
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "foreverdb.example",
        VERCEL_GIT_COMMIT_REF: "main",
        BETA_SEO_AUTHORIZED_BRANCH: "main",
        FOREVERDB_DEPLOYMENT: "production",
        FOREVERDB_DATA_SOURCE: "postgres",
        AZERDEX_READ_DB_URL: "postgresql://foreverdb_web_reader:pw@public-db.example.com:6543/postgres",
        SITE_URL: "https://foreverdb.example",
        RATE_LIMIT_BACKEND: "upstash",
        UPSTASH_REDIS_REST_URL: "https://fake-upstash.invalid",
        UPSTASH_REDIS_REST_TOKEN: "t".repeat(30),
        RATE_LIMIT_SALT: "s".repeat(40),
        TRUSTED_IP_HEADER: "x-real-ip",
      },
      async (base) => {
        // Fail closed: either the server never comes up (curl fails to connect - refused/reset)
        // or it answers with a server error - either way, production is never reachable or indexed
        // through this misconfiguration, and real production (without the flag) is completely unaffected.
        const r = await curlGet(`${base}/`, { Host: BETA_HOST, ...client() }).catch(() => null);
        if (r) expect(r.status).toBeGreaterThanOrEqual(500);
      },
    );
  });

  test("real production (no beta flag at all) is completely unaffected by this feature", async () => {
    // robots.txt needs no database (unlike the homepage, which does real Postgres queries in
    // production mode and would need a live connection this test cannot provide), so it isolates
    // exactly the thing under test: whether the Host header can influence production's own,
    // pre-existing isIndexable() behavior. It must not, with or without the beta.azerdex.com Host.
    await withServer(
      3228,
      {
        VERCEL: "1",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: "foreverdb.example",
        FOREVERDB_DEPLOYMENT: "production",
        FOREVERDB_DATA_SOURCE: "postgres",
        AZERDEX_READ_DB_URL: "postgresql://foreverdb_web_reader:pw@public-db.example.com:6543/postgres",
        SITE_URL: "https://foreverdb.example",
        RATE_LIMIT_BACKEND: "upstash",
        UPSTASH_REDIS_REST_URL: "https://fake-upstash.invalid",
        UPSTASH_REDIS_REST_TOKEN: "t".repeat(30),
        RATE_LIMIT_SALT: "s".repeat(40),
        TRUSTED_IP_HEADER: "x-real-ip",
      },
      async (base) => {
        const withRealHost = await curlGet(`${base}/robots.txt`, { Host: "foreverdb.example" });
        const withBetaHost = await curlGet(`${base}/robots.txt`, { Host: BETA_HOST });
        for (const r of [withRealHost, withBetaHost]) {
          expect(r.status).toBe(200);
          expect(r.body).toMatch(/Allow: \//);
          expect(r.body).toContain("Sitemap: https://foreverdb.example/sitemap.xml");
          expect(r.body).not.toContain(BETA_HOST);
        }
        // Identical output either way: the custom Host header has no effect at all in production.
        expect(withRealHost.body).toBe(withBetaHost.body);
      },
    );
  });
});
