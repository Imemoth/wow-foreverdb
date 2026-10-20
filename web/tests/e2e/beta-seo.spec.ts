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

const SENSITIVE_PREFIXES = /^(FOREVERDB_|VERCEL|SITE_URL|RATE_LIMIT|UPSTASH|PUBLIC_READ|TRUSTED_IP|TURNSTILE|NEXT_PUBLIC_TURNSTILE|CHALLENGE_|SUPABASE|DATABASE_URL|POSTGRES_|BETA_SEO_)/;

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

/** A VALID, fully-authorized public-beta Preview deployment of the web/azerdex-beta branch. */
const authorizedBeta: Record<string, string> = {
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_URL: "wow-foreverdb-abc123-imemoths-projects.vercel.app",
  VERCEL_BRANCH_URL: VERCEL_ALIAS,
  VERCEL_GIT_COMMIT_REF: "web/azerdex-beta",
  BETA_SEO_AUTHORIZED_BRANCH: "web/azerdex-beta",
  FOREVERDB_DEPLOYMENT: "preview",
  FOREVERDB_DATA_SOURCE: "fixture",
  TRUSTED_IP_HEADER: "x-forwarded-for",
};

let n = 0;
const client = () => ({ "x-forwarded-for": `198.51.100.${(n += 1) % 250}` });

test.describe.configure({ timeout: 90_000 });

test.describe("eligible public-beta homepage (all five conditions hold)", () => {
  test("indexable homepage: meta robots, canonical, OG, JSON-LD and X-Robots-Tag all agree", async () => {
    await withServer(3220, authorizedBeta, async (base) => {
      const r = await curlGet(`${base}/`, { Host: BETA_HOST, ...client() });
      expect(r.status).toBe(200);
      expect(r.headers["x-robots-tag"]).toBeUndefined();
      expect(r.headers["x-foreverdb-deployment"]).toBe("preview");
      expect(r.body).toMatch(/<meta name="robots" content="index, follow"/);
      expect(r.body).toContain(`<link rel="canonical" href="https://${BETA_HOST}"`);
      expect(r.body).toContain(`<meta property="og:url" content="https://${BETA_HOST}"`);
      const ld = /"@type":"WebSite"[\s\S]*?"url":"([^"]+)"/.exec(r.body)?.[1];
      expect(ld).toBe(`https://${BETA_HOST}`);
    });
  });

  test("no synthetic content misrepresentation: identifies as public beta, never claims real observations on that page", async () => {
    await withServer(3221, authorizedBeta, async (base) => {
      const { body } = await curlGet(`${base}/`, { Host: BETA_HOST, ...client() });
      expect(body).toMatch(/Public beta/);
      expect(body).toMatch(/synthetic demo data/);
      expect(body).not.toMatch(/built from real in-game observations/);
      // the sitewide honesty banner must still be present too
      expect(body).toContain("Preview with synthetic sample data");
    });
  });

  test("non-indexable beta data pages: Database, Zones, entity, API, verify, Account all stay noindex", async () => {
    await withServer(3222, authorizedBeta, async (base) => {
      for (const path of ["/database", "/zones", "/zone/1420", "/item/2770", "/download"]) {
        const r = await curlGet(`${base}${path}`, { Host: BETA_HOST, ...client() });
        expect(r.headers["x-robots-tag"], path).toBe("noindex, nofollow");
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
    await withServer(3223, authorizedBeta, async (base) => {
      const r = await curlGet(`${base}/`, client()); // Host defaults to 127.0.0.1:PORT, never beta.azerdex.com
      expect(r.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(r.body).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    });
  });

  test("robots.txt / sitemap.xml consistency: crawlable data pages, no disallow hiding their noindex, single approved URL", async () => {
    await withServer(3224, authorizedBeta, async (base) => {
      const robotsTxt = (await curlGet(`${base}/robots.txt`, { Host: BETA_HOST })).body;
      expect(robotsTxt).toMatch(/Allow: \//);
      expect(robotsTxt).toMatch(/Disallow: \/api\//);
      expect(robotsTxt).toMatch(/Disallow: \/verify/);
      // Data pages must stay crawlable so Google can see their own noindex tag - never disallowed here.
      expect(robotsTxt).not.toMatch(/Disallow:\s*\/database/);
      expect(robotsTxt).not.toMatch(/Disallow:\s*\/zones/);
      expect(robotsTxt).not.toMatch(/Disallow:\s*\/zone\//);
      expect(robotsTxt).not.toMatch(/Disallow:\s*\/item\//);
      expect(robotsTxt).toContain(`Sitemap: https://${BETA_HOST}/sitemap.xml`);

      const sitemapXml = (await curlGet(`${base}/sitemap.xml`, { Host: BETA_HOST })).body;
      const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      expect(locs).toEqual([`https://${BETA_HOST}/`]);
      // Never advertises synthetic entities or sample articles.
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

test.describe("every one of the five conditions is independently required", () => {
  test("non-indexable development branch: same host, env config copied to the wrong branch stays noindex", async () => {
    await withServer(3225, { ...authorizedBeta, VERCEL_GIT_COMMIT_REF: "feature/unrelated-branch" }, async (base) => {
      const r = await curlGet(`${base}/`, { Host: BETA_HOST, ...client() });
      expect(r.headers["x-robots-tag"]).toBe("noindex, nofollow");
      expect(r.body).toMatch(/<meta name="robots" content="noindex, nofollow"/);
      const robotsTxt = (await curlGet(`${base}/robots.txt`, { Host: BETA_HOST })).body;
      expect(robotsTxt).toMatch(/Disallow: \/\s*$/m);
    });
  });

  test("not indexable without FOREVERDB_DATA_SOURCE=fixture (a real/postgres-backed preview, hypothetically)", async () => {
    await withServer(
      3226,
      { ...authorizedBeta, FOREVERDB_DATA_SOURCE: "postgres", PUBLIC_READ_DATABASE_URL: "postgresql://foreverdb_web_reader:pw@public-db.example.com:6543/postgres" },
      async (base) => {
        const r = await curlGet(`${base}/`, { Host: BETA_HOST, ...client() });
        expect(r.headers["x-robots-tag"]).toBe("noindex, nofollow");
      },
    );
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
        PUBLIC_READ_DATABASE_URL: "postgresql://foreverdb_web_reader:pw@public-db.example.com:6543/postgres",
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
        PUBLIC_READ_DATABASE_URL: "postgresql://foreverdb_web_reader:pw@public-db.example.com:6543/postgres",
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
