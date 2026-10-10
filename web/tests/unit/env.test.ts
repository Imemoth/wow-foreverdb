import { afterEach, describe, expect, it, vi } from "vitest";

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const k of Object.keys(process.env)) if (k.startsWith("FOREVERDB_") || /RATE_LIMIT|UPSTASH|PUBLIC_READ|SITE_URL|TRUSTED_IP|TURNSTILE|CHALLENGE/.test(k)) delete process.env[k];
  Object.assign(process.env, env);
  const m = await import("@/lib/env");
  return () => m.serverEnv();
}

const prodBase = {
  FOREVERDB_DEPLOYMENT: "production",
  FOREVERDB_DATA_SOURCE: "postgres",
  PUBLIC_READ_DATABASE_URL: "postgresql://foreverdb_web_reader.abcdefghijklmnop:pw@aws-0-eu.pooler.supabase.com:6543/postgres",
  SITE_URL: "https://foreverdb.example",
  RATE_LIMIT_BACKEND: "upstash",
  UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "t".repeat(30),
  RATE_LIMIT_SALT: "s".repeat(40),
  TRUSTED_IP_HEADER: "x-real-ip",
};

afterEach(() => vi.resetModules());

describe("fail-closed configuration", () => {
  it("accepts a correct production configuration", async () => {
    expect((await load(prodBase))().FOREVERDB_DATA_SOURCE).toBe("postgres");
  });
  it("refuses to serve synthetic fixture data in production", async () => {
    expect(await load({ ...prodBase, FOREVERDB_DATA_SOURCE: "fixture" })).toThrow(/fixture/);
  });
  it("refuses the private production database", async () => {
    const f = await load({ ...prodBase, PUBLIC_READ_DATABASE_URL: "postgresql://foreverdb_web_reader:pw@db.klxhikdlfwgxurdyexdi.supabase.co:5432/postgres" });
    expect(f).toThrow(/PRIVATE production/);
  });
  it("refuses privileged database roles", async () => {
    expect(await load({ ...prodBase, PUBLIC_READ_DATABASE_URL: "postgresql://postgres:pw@db.otherproject.supabase.co:5432/postgres" })).toThrow(/foreverdb_web_reader/);
    expect(await load({ ...prodBase, PUBLIC_READ_DATABASE_URL: "postgresql://service_role:pw@host/db" })).toThrow(/foreverdb_web_reader/);
  });
  it("requires distributed rate limiting, trusted IP header, salt and https in production", async () => {
    expect(await load({ ...prodBase, RATE_LIMIT_BACKEND: "memory" })).toThrow(/upstash/);
    expect(await load({ ...prodBase, TRUSTED_IP_HEADER: "none" })).toThrow(/TRUSTED_IP_HEADER/);
    expect(await load({ ...prodBase, RATE_LIMIT_SALT: "" })).toThrow();
    expect(await load({ ...prodBase, SITE_URL: "http://foreverdb.example" })).toThrow(/https/);
  });
  it("error messages never echo secret values", async () => {
    try { (await load({ ...prodBase, PUBLIC_READ_DATABASE_URL: "postgresql://postgres:SuperSecret123@db.x.supabase.co/postgres" }))(); } catch (e) {
      expect(String(e)).not.toContain("SuperSecret123");
    }
  });
});
