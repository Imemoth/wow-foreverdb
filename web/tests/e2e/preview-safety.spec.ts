import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";

/**
 * HTTP-level verification of the hosted PREVIEW boundary. The "preview" Playwright project runs a
 * server that simulates a Vercel preview deployment (explicit FOREVERDB_DEPLOYMENT=preview, https
 * SITE_URL, Vercel metadata). Nothing here uses a browser: these are the same checks an operator
 * can run against a real URL with scripts/verify-deployment.mjs.
 *
 * The last block starts deliberately misconfigured servers and proves they refuse to serve.
 */

const SITE = "https://preview.foreverdb.test";
let n = 40;
const client = () => ({ "x-forwarded-for": `203.0.113.${(n += 1) % 250}` });

test.describe("synthetic preview is labelled and not indexable", () => {
  test("home page: banner, noindex meta, canonical on the site origin, deployment marker", async ({ request }) => {
    const r = await request.get("/", { headers: client() });
    expect(r.status()).toBe(200);
    const h = r.headers();
    expect(h["x-robots-tag"]).toBe("noindex, nofollow");
    expect(h["x-foreverdb-deployment"]).toBe("preview");
    const html = await r.text();
    expect(html).toContain("Preview with synthetic sample data");
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    expect(html).toMatch(/<meta name="foreverdb-deployment" content="preview"/);
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1];
    expect(canonical, "canonical link present").toBeTruthy();
    expect(new URL(canonical!).origin).toBe(SITE);
    expect(html).not.toMatch(/localhost/i);
  });

  test("an item page is also marked noindex and still shows the synthetic banner", async ({ request }) => {
    const r = await request.get("/item/2770", { headers: client() });
    expect(r.status()).toBe(200);
    expect(r.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    const html = await r.text();
    expect(html).toMatch(/<meta name="robots" content="noindex, nofollow"/);
    expect(html).toContain("Preview with synthetic sample data");
  });

  test("robots.txt disallows everything and advertises no sitemap", async ({ request }) => {
    const r = await request.get("/robots.txt");
    expect(r.status()).toBe(200);
    const t = await r.text();
    expect(t).toMatch(/User-Agent: \*/i);
    expect(t).toMatch(/Disallow: \/\s*$/m);
    expect(t).not.toMatch(/sitemap/i);
    expect(t).not.toMatch(/^Allow:/im);
  });

  test("sitemap.xml lists no URLs outside production", async ({ request }) => {
    const r = await request.get("/sitemap.xml");
    expect(r.status()).toBe(200);
    expect(await r.text()).not.toContain("<loc>");
  });

  test("API responses are noindex too (not only HTML)", async ({ request }) => {
    const r = await request.get("/api/v1/meta", { headers: client() });
    expect(r.status()).toBe(200);
    expect(r.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(r.headers()["x-foreverdb-deployment"]).toBe("preview");
    const body = await r.json();
    expect(body.mode).toBe("synthetic-sample");
  });
});

test.describe("security headers, cookies and caching (HTTP level)", () => {
  test("HTML response headers", async ({ request }) => {
    const r = await request.get("/database?q=copper", { headers: client() });
    const h = r.headers();
    const csp = h["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).not.toMatch(/unsafe-eval|unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(h["strict-transport-security"]).toMatch(/max-age=\d{8,}/);
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["cross-origin-opener-policy"]).toBe("same-origin");
    expect(h["permissions-policy"]).toContain("camera=()");
    expect(h["x-powered-by"]).toBeUndefined();
    expect(h["cache-control"]).toMatch(/no-store/);
  });

  test("session cookie is Secure, HttpOnly, SameSite and host-bound on an https origin", async ({ request }) => {
    const r = await request.get("/", { headers: client() });
    const cookies = r.headersArray().filter((x) => x.name.toLowerCase() === "set-cookie").map((x) => x.value);
    expect(cookies.length).toBe(1);
    const c = cookies[0]!;
    expect(c).toMatch(/^__Host-fdb_sid=[A-Za-z0-9_-]{22};/);
    expect(c).toMatch(/;\s*Secure/i);
    expect(c).toMatch(/;\s*HttpOnly/i);
    expect(c).toMatch(/;\s*SameSite=Lax/i);
    expect(c).toMatch(/;\s*Path=\//i);
    expect(c).not.toMatch(/Domain=/i);
  });

  test("cacheable API responses are public-cacheable and never set cookies", async ({ request }) => {
    const r = await request.get("/api/v1/search?q=copper", { headers: client() });
    expect(r.status()).toBe(200);
    expect(r.headers()["cache-control"]).toMatch(/public, max-age=60/);
    expect(r.headers()["set-cookie"]).toBeUndefined();
    expect(r.headers()["content-security-policy"]).toContain("default-src 'none'");
  });

  test("error responses are generic, uncached and carry the same hardening headers", async ({ request }) => {
    const bad = await request.get("/api/v1/search?q=%25&bogus=1", { headers: client() });
    expect(bad.status()).toBe(400);
    expect(bad.headers()["cache-control"]).toBe("no-store");
    expect(bad.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    const text = await bad.text();
    expect(text).toMatch(/^\{"error":"[a-z_]+"\}$/);
    for (const forbidden of [/stack/i, /\bat\s.+\(.+:\d+:\d+\)/, /select\s.+from/i, /postgres(ql)?:\/\//i, /node_modules/]) expect(text).not.toMatch(forbidden);
    const missing = await request.get("/api/v1/item/999999999", { headers: client() });
    expect(missing.status()).toBe(404);
    const post = await request.post("/api/v1/search", { headers: client(), data: {} });
    expect(post.status()).toBe(405);
  });

  test("no connection strings, keys or private project references appear in a page", async ({ request }) => {
    const html = await (await request.get("/", { headers: client() })).text();
    for (const forbidden of [/postgres(ql)?:\/\//i, /foreverdb_web_reader/, /klxhikdlfwgxurdyexdi/, /service_role/i, /upstash/i, /SUPABASE/i, /\.supabase\.co/i]) {
      expect(html, String(forbidden)).not.toMatch(forbidden);
    }
  });

  test("rate limiting answers 429 with Retry-After, no-store and the preview markers", async ({ request }) => {
    const headers = client();
    let last = 0;
    let res = await request.get("/api/v1/search?q=copper", { headers });
    for (let i = 0; i < 30 && res.status() !== 429; i++) res = await request.get(`/api/v1/search?q=copper${i}x`, { headers });
    last = res.status();
    expect(last).toBe(429);
    const h = res.headers();
    expect(Number(h["retry-after"])).toBeGreaterThan(0);
    expect(h["cache-control"]).toBe("no-store");
    expect(h["x-robots-tag"]).toBe("noindex, nofollow");
    expect(h["x-foreverdb-deployment"]).toBe("preview");
    expect(h["strict-transport-security"]).toMatch(/max-age/);
    // a different client is unaffected
    expect((await request.get("/api/v1/search?q=copper", { headers: client() })).status()).toBe(200);
  });
});

/* ---- Unsafe configurations must refuse to serve (fail closed) ---------------------------------- */

const SENSITIVE_PREFIXES = /^(FOREVERDB_|VERCEL|SITE_URL|RATE_LIMIT|UPSTASH|PUBLIC_READ|TRUSTED_IP|TURNSTILE|NEXT_PUBLIC_TURNSTILE|CHALLENGE_|SUPABASE|DATABASE_URL|POSTGRES_)/;

async function withServer(port: number, env: Record<string, string>, run: (base: string) => Promise<void>) {
  const clean: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) if (!SENSITIVE_PREFIXES.test(k)) clean[k] = v;
  const child: ChildProcess = spawn("npx", ["next", "start", "-p", String(port)], {
    env: { ...clean, ...env, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
    detached: true, // own process group, so the whole tree (npx -> next-server) can be stopped
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

const cases: Array<{ name: string; port: number; env: Record<string, string> }> = [
  {
    name: "production designation with the synthetic fixture adapter",
    port: 3212,
    env: { FOREVERDB_DEPLOYMENT: "production", FOREVERDB_DATA_SOURCE: "fixture", SITE_URL: "https://foreverdb.example", RATE_LIMIT_BACKEND: "memory", TRUSTED_IP_HEADER: "x-real-ip", RATE_LIMIT_SALT: "s".repeat(40) },
  },
  {
    name: "hosted deployment with no ForeverDB designation (must not fall back to local)",
    port: 3213,
    env: { VERCEL: "1", VERCEL_ENV: "production", VERCEL_URL: "foreverdb-x.vercel.app" },
  },
  {
    name: "public database URL that points at the private Supabase project",
    port: 3214,
    env: { FOREVERDB_DEPLOYMENT: "preview", FOREVERDB_DATA_SOURCE: "postgres", SITE_URL: "https://preview.foreverdb.test", PUBLIC_READ_DATABASE_URL: "postgresql://foreverdb_web_reader:pw@db.klxhikdlfwgxurdyexdi.supabase.co:5432/postgres" },
  },
];

test.describe("unsafe configurations refuse to serve", () => {
  test.describe.configure({ timeout: 90_000 });
  for (const c of cases) {
    test(c.name, async () => {
      await withServer(c.port, c.env, async (base) => {
        for (const path of ["/", "/robots.txt", "/api/v1/meta"]) {
          const r = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
          expect(r.status, `${path} must not be served`).toBeGreaterThanOrEqual(500);
          const body = await r.text();
          // The reason is logged server-side only: nothing about the configuration reaches the client.
          for (const leak of [/Unsafe ForeverDB configuration/i, /FOREVERDB_/, /klxhikdlfwgxurdyexdi/, /foreverdb_web_reader/, /fixture/i]) expect(body).not.toMatch(leak);
        }
      });
    });
  }
});
