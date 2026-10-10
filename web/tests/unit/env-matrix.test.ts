import { afterEach, describe, expect, it, vi } from "vitest";
import { detectHosting, evaluateEnv, isIndexable, type RawEnv } from "@/lib/env";
import { deploymentHeaders } from "@/lib/security/headers";

/**
 * Environment matrix: local / protected preview / future production, on and off Vercel.
 * evaluateEnv() is pure, so every row below is a deterministic statement about the policy.
 */

const PUBLIC_DB = "postgresql://foreverdb_web_reader.abcdefghijklmnop:pw@aws-0-eu.pooler.example.com:6543/postgres";

const production: RawEnv = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  VERCEL_PROJECT_PRODUCTION_URL: "foreverdb.example",
  FOREVERDB_DEPLOYMENT: "production",
  FOREVERDB_DATA_SOURCE: "postgres",
  PUBLIC_READ_DATABASE_URL: PUBLIC_DB,
  SITE_URL: "https://foreverdb.example",
  RATE_LIMIT_BACKEND: "upstash",
  UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "t".repeat(30),
  RATE_LIMIT_SALT: "s".repeat(40),
  TRUSTED_IP_HEADER: "x-real-ip",
};

const previewDemo: RawEnv = {
  VERCEL: "1",
  VERCEL_ENV: "production", // the temporary demo is served through the production-target alias
  VERCEL_PROJECT_PRODUCTION_URL: "wow-foreverdb.vercel.app",
  VERCEL_URL: "wow-foreverdb-abc123-imemoths-projects.vercel.app",
  FOREVERDB_DEPLOYMENT: "preview",
  FOREVERDB_DATA_SOURCE: "fixture",
};

const branchPreview: RawEnv = {
  VERCEL: "1",
  VERCEL_ENV: "preview",
  VERCEL_URL: "wow-foreverdb-abc123-imemoths-projects.vercel.app",
  VERCEL_BRANCH_URL: "wow-foreverdb-git-feature-imemoths-projects.vercel.app",
  FOREVERDB_DEPLOYMENT: "preview",
  FOREVERDB_DATA_SOURCE: "fixture",
};

function ok(raw: RawEnv) {
  const r = evaluateEnv(raw);
  if (!r.ok) throw new Error(`expected ok, got: ${r.issues.join("; ")}`);
  return r.env;
}
function issues(raw: RawEnv): string {
  const r = evaluateEnv(raw);
  if (r.ok) throw new Error("expected the configuration to be rejected");
  return r.issues.join(" | ");
}

describe("local development", () => {
  it("allows fixtures, the memory limiter and localhost with no variables at all", () => {
    const e = ok({});
    expect(e).toMatchObject({ FOREVERDB_DEPLOYMENT: "local", FOREVERDB_DATA_SOURCE: "fixture", RATE_LIMIT_BACKEND: "memory", SITE_URL: "http://localhost:3000", hosted: false });
  });
  it("treats `vercel dev` as a developer machine", () => {
    expect(detectHosting({ VERCEL: "1", VERCEL_ENV: "development" }).hosted).toBe(false);
    expect(ok({ VERCEL: "1", VERCEL_ENV: "development" }).FOREVERDB_DEPLOYMENT).toBe("local");
  });
  it("refuses local mode with a public site URL", () => {
    expect(issues({ SITE_URL: "https://foreverdb.example" })).toMatch(/localhost SITE_URL/);
  });
  it("does not choke on unrelated tooling variables of a developer shell", () => {
    expect(ok({ SUPABASE_ACCESS_TOKEN: "sbp_unrelated_developer_token" }).FOREVERDB_DEPLOYMENT).toBe("local");
  });
});

describe("hosted deployments never fall back to local", () => {
  it("rejects a hosted deployment with no designation", () => {
    expect(issues({ VERCEL: "1", VERCEL_ENV: "production" })).toMatch(/FOREVERDB_DEPLOYMENT must be set explicitly/);
    expect(issues({ VERCEL: "1", VERCEL_ENV: "preview" })).toMatch(/FOREVERDB_DEPLOYMENT must be set explicitly/);
  });
  it("rejects an explicit local designation on a hosted deployment", () => {
    expect(issues({ ...branchPreview, FOREVERDB_DEPLOYMENT: "local" })).toMatch(/local is not permitted on a hosted/);
  });
  it("rejects a hosted deployment without an explicit data source", () => {
    const noSource: RawEnv = { ...previewDemo, FOREVERDB_DATA_SOURCE: undefined };
    expect(issues(noSource)).toMatch(/FOREVERDB_DATA_SOURCE must be set explicitly/);
  });
  it("detects hosting from either VERCEL or VERCEL_ENV", () => {
    expect(detectHosting({ VERCEL_ENV: "preview" }).hosted).toBe(true);
    expect(detectHosting({ VERCEL: "1" }).hosted).toBe(true);
    expect(detectHosting({}).hosted).toBe(false);
  });
});

describe("protected preview and the temporary synthetic demonstration", () => {
  it("accepts the demo served through the Vercel production alias ONLY when it declares preview", () => {
    const e = ok(previewDemo);
    expect(e.FOREVERDB_DEPLOYMENT).toBe("preview");
    expect(e.platformEnv).toBe("production");
    expect(e.SITE_URL).toBe("https://wow-foreverdb.vercel.app");
    expect(isIndexable(e)).toBe(false);
  });
  it("derives a branch preview's own https origin from Vercel metadata", () => {
    expect(ok(branchPreview).SITE_URL).toBe("https://wow-foreverdb-git-feature-imemoths-projects.vercel.app");
  });
  it("prefers an explicit https SITE_URL", () => {
    expect(ok({ ...previewDemo, SITE_URL: "https://wow-foreverdb.vercel.app/" }).SITE_URL).toBe("https://wow-foreverdb.vercel.app");
  });
  it("is never indexable", () => {
    expect(isIndexable(ok(previewDemo))).toBe(false);
    expect(isIndexable(ok(branchPreview))).toBe(false);
    expect(isIndexable(ok({}))).toBe(false);
  });
  it("rejects a hosted site URL that is localhost, a private address, http or credentialed", () => {
    expect(issues({ ...previewDemo, SITE_URL: "http://localhost:3000" })).toMatch(/https on a hosted/);
    expect(issues({ ...previewDemo, SITE_URL: "https://localhost:3000" })).toMatch(/not be a local address/);
    expect(issues({ ...previewDemo, SITE_URL: "https://192.168.1.10" })).toMatch(/not be a local address/);
    expect(issues({ ...previewDemo, SITE_URL: "http://wow-foreverdb.vercel.app" })).toMatch(/https on a hosted/);
    expect(issues({ ...previewDemo, SITE_URL: "https://user:pass@wow-foreverdb.vercel.app" })).toMatch(/credentials/);
    expect(issues({ ...previewDemo, SITE_URL: "not a url" })).toMatch(/not a valid URL/);
  });
  it("rejects a preview that has no SITE_URL and no Vercel URL metadata", () => {
    expect(issues({ VERCEL: "1", VERCEL_ENV: "preview", FOREVERDB_DEPLOYMENT: "preview", FOREVERDB_DATA_SOURCE: "fixture" })).toMatch(/SITE_URL is required/);
  });
});

describe("future production", () => {
  it("accepts a complete production configuration", () => {
    const e = ok(production);
    expect(e.FOREVERDB_DEPLOYMENT).toBe("production");
    expect(isIndexable(e)).toBe(true);
  });
  it("refuses the synthetic fixture adapter", () => {
    expect(issues({ ...production, FOREVERDB_DATA_SOURCE: "fixture" })).toMatch(/must not serve the synthetic fixture/);
  });
  it("requires Upstash, a trusted IP header and a salt", () => {
    expect(issues({ ...production, RATE_LIMIT_BACKEND: "memory" })).toMatch(/upstash/);
    expect(issues({ ...production, UPSTASH_REDIS_REST_TOKEN: undefined })).toMatch(/UPSTASH_REDIS_REST_TOKEN/);
    expect(issues({ ...production, TRUSTED_IP_HEADER: "none" })).toMatch(/TRUSTED_IP_HEADER/);
    expect(issues({ ...production, RATE_LIMIT_SALT: undefined })).toMatch(/RATE_LIMIT_SALT/);
  });
  it("refuses production designation in a Vercel preview environment", () => {
    expect(issues({ ...production, VERCEL_ENV: "preview" })).toMatch(/only valid in the Vercel production environment/);
  });
  it("requires an explicit https SITE_URL equal to the Vercel production domain", () => {
    const noUrl: RawEnv = { ...production, SITE_URL: undefined };
    expect(issues(noUrl)).toMatch(/SITE_URL must be set explicitly/);
    expect(issues({ ...production, SITE_URL: "http://foreverdb.example" })).toMatch(/https/);
    expect(issues({ ...production, SITE_URL: "https://wow-foreverdb.vercel.app" })).toMatch(/production domain/);
  });
  it("is only valid with the separate PUBLIC database, never the private Supabase project", () => {
    expect(issues({ ...production, PUBLIC_READ_DATABASE_URL: "postgresql://foreverdb_web_reader:pw@db.klxhikdlfwgxurdyexdi.supabase.co:5432/postgres" })).toMatch(/PRIVATE production/);
    expect(issues({ ...production, PUBLIC_READ_DATABASE_URL: "postgresql://postgres:pw@db.otherproject.supabase.co:5432/postgres" })).toMatch(/foreverdb_web_reader/);
    expect(issues({ ...production, PUBLIC_READ_DATABASE_URL: "postgresql://service_role:pw@host.example/db" })).toMatch(/foreverdb_web_reader/);
    expect(issues({ ...production, PUBLIC_READ_DATABASE_URL: "postgresql://foreverdb_web_reader:pw@localhost:5432/db" })).toMatch(/local address/);
    expect(issues({ ...production, PUBLIC_READ_DATABASE_URL: undefined })).toMatch(/PUBLIC_READ_DATABASE_URL is required/);
  });
});

describe("private backend credentials never reach the public website", () => {
  it("rejects Supabase and service-role variables on any designated deployment", () => {
    expect(issues({ ...previewDemo, SUPABASE_URL: "https://anything.supabase.co" })).toMatch(/SUPABASE_URL: private backend credentials/);
    expect(issues({ ...previewDemo, NEXT_PUBLIC_SUPABASE_ANON_KEY: "x" })).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(issues({ ...production, SUPABASE_SERVICE_ROLE_KEY: "x" })).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(issues({ ...previewDemo, DATABASE_URL: "postgresql://x" })).toMatch(/DATABASE_URL/);
    expect(issues({ ...previewDemo, POSTGRES_URL: "postgresql://x" })).toMatch(/POSTGRES_URL/);
  });
  it("rejects any application variable that references the private project", () => {
    expect(issues({ ...previewDemo, PUBLIC_READ_DATABASE_URL: "postgresql://foreverdb_web_reader:pw@db.klxhikdlfwgxurdyexdi.supabase.co/db", FOREVERDB_DATA_SOURCE: "postgres" })).toMatch(/PRIVATE production/);
    expect(issues({ ...previewDemo, NEXT_PUBLIC_API_BASE: "https://klxhikdlfwgxurdyexdi.supabase.co" })).toMatch(/NEXT_PUBLIC_API_BASE: references the PRIVATE/);
  });
  it("does not scan unrelated Vercel system metadata (a commit message may mention anything)", () => {
    expect(ok({ ...previewDemo, VERCEL_GIT_COMMIT_MESSAGE: "docs: ledger for klxhikdlfwgxurdyexdi" }).FOREVERDB_DEPLOYMENT).toBe("preview");
  });
  it("rejects cf-connecting-ip as the trusted client IP source on Vercel", () => {
    expect(issues({ ...previewDemo, TRUSTED_IP_HEADER: "cf-connecting-ip" })).toMatch(/only trustworthy behind Cloudflare/);
  });
});

describe("error messages never echo secret values", () => {
  it("names variables only", () => {
    const secrets = ["SuperSecret123", "tok_live_ABCDEFGHIJKLMNOPQRSTUV", "salt-salt-salt-salt-salt-salt-salt-salt-1"];
    const all = [
      issues({ ...production, PUBLIC_READ_DATABASE_URL: "postgresql://postgres:SuperSecret123@db.x.example/postgres" }),
      issues({ ...production, UPSTASH_REDIS_REST_TOKEN: "tok_live_ABCDEFGHIJKLMNOPQRSTUV", RATE_LIMIT_BACKEND: "memory", FOREVERDB_DATA_SOURCE: "fixture" }),
      issues({ ...previewDemo, SUPABASE_SERVICE_ROLE_KEY: "salt-salt-salt-salt-salt-salt-salt-salt-1" }),
    ].join(" ");
    for (const s of secrets) expect(all).not.toContain(s);
  });
});

describe("deployment headers keep non-production out of search indexes", () => {
  it("stamps preview and local as noindex and identifies the designation", () => {
    expect(deploymentHeaders("preview")).toEqual({ "X-ForeverDB-Deployment": "preview", "X-Robots-Tag": "noindex, nofollow" });
    expect(deploymentHeaders("local")["X-Robots-Tag"]).toBe("noindex, nofollow");
  });
  it("does not noindex the production release but still identifies it", () => {
    expect(deploymentHeaders("production")).toEqual({ "X-ForeverDB-Deployment": "production" });
  });
});

describe("indexing surfaces follow the designation (robots.txt, sitemap)", () => {
  afterEach(() => vi.resetModules());
  async function surfaces(env: RawEnv) {
    vi.resetModules();
    for (const k of Object.keys(process.env)) if (/^(FOREVERDB_|VERCEL|SITE_URL|RATE_LIMIT|UPSTASH|PUBLIC_READ|TRUSTED_IP)/.test(k)) delete process.env[k];
    Object.assign(process.env, env);
    const robots = (await import("@/app/robots")).default();
    const sitemap = await (await import("@/app/sitemap")).default();
    return { robots, sitemap };
  }
  it("preview: robots.txt disallows everything and the sitemap is empty", async () => {
    const { robots, sitemap } = await surfaces(previewDemo);
    expect(robots.rules).toEqual([{ userAgent: "*", disallow: "/" }]);
    expect(robots.sitemap).toBeUndefined();
    expect(sitemap).toEqual([]);
  });
  it("local: robots.txt disallows everything and the sitemap is empty", async () => {
    const { robots, sitemap } = await surfaces({});
    expect(robots.rules).toEqual([{ userAgent: "*", disallow: "/" }]);
    expect(sitemap).toEqual([]);
  });
});
