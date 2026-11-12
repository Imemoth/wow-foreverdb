import { describe, expect, it } from "vitest";
import { ADMIN_PREVIEW_BUILD, evaluatePreviewGate, isAdminPreviewPath, isLoopbackHost } from "@/lib/admin-preview-gate";

const GOOD: Record<string, string> = {
  AZERDEX_ADMIN_PREVIEW: "isolated-synthetic",
  AZERDEX_ADMIN_PREVIEW_DATA: "synthetic",
  FOREVERDB_DEPLOYMENT: "local",
  FOREVERDB_DATA_SOURCE: "fixture",
  SITE_URL: "http://localhost:3300",
  RATE_LIMIT_BACKEND: "memory",
  PATH: "/usr/bin",
};
const without = (o: Record<string, string>, k: string): Record<string, string> => { const c = { ...o }; delete c[k]; return c; };
const closed = (env: Record<string, string | undefined>, build = true, why = "") => {
  const g = evaluatePreviewGate(env, build);
  expect(g.allowed, why).toBe(false);
  return g.allowed ? "" : g.reason;
};

describe("Admin UI preview runtime gate", () => {
  it("is open only for the fully consistent, local, synthetic configuration of a preview build", () => {
    expect(evaluatePreviewGate(GOOD, true)).toEqual({ allowed: true });
    expect(evaluatePreviewGate({ ...GOOD, SITE_URL: "http://127.0.0.1:3300" }, true)).toEqual({ allowed: true });
  });

  it("is closed in every normal build, whatever the runtime environment says", () => {
    expect(closed(GOOD, false)).toMatch(/not a preview build/);
    expect(ADMIN_PREVIEW_BUILD).toBe(false); // the unit-test (non-preview) environment never has the build flag
  });

  it("fails closed when the preview flags are absent, partial or sloppy", () => {
    expect(closed(without(GOOD, "AZERDEX_ADMIN_PREVIEW"))).toMatch(/absent/);
    expect(closed(without(GOOD, "AZERDEX_ADMIN_PREVIEW_DATA"))).toMatch(/acknowledgement/);
    for (const v of ["1", "true", "yes", "ISOLATED-SYNTHETIC", "isolated", " isolated-synthetic"]) expect(closed({ ...GOOD, AZERDEX_ADMIN_PREVIEW: v })).toMatch(/unexpected value/);
    expect(closed({ ...GOOD, AZERDEX_ADMIN_PREVIEW_DATA: "real" })).toMatch(/acknowledgement/);
    expect(closed({ ...GOOD, AZERDEX_ADMIN_PREVIEW: "" })).toMatch(/absent/);
  });

  it("never opens in a hosted environment", () => {
    for (const extra of [{ VERCEL: "1" }, { VERCEL_ENV: "preview" }, { VERCEL_URL: "x.vercel.app" }, { VERCEL_GIT_COMMIT_SHA: "abc" }, { NEXT_PUBLIC_VERCEL_ENV: "production" }]) {
      expect(closed({ ...GOOD, ...extra }), JSON.stringify(extra)).toMatch(/hosted/);
    }
    expect(closed({ ...GOOD, FOREVERDB_DEPLOYMENT: "preview" })).toMatch(/local/);
    expect(closed({ ...GOOD, FOREVERDB_DEPLOYMENT: "production" })).toMatch(/local/);
    expect(closed(without(GOOD, "FOREVERDB_DEPLOYMENT"))).toMatch(/local/);
    expect(closed({ ...GOOD, SITE_URL: "https://azerdex.com" })).toBeTruthy();
    expect(closed({ ...GOOD, SITE_URL: "https://preview.foreverdb.test" })).toBeTruthy();
  });

  it("never opens when any backend, database, Auth or secret configuration is present", () => {
    const secrets: Record<string, string> = {
      AZERDEX_READ_DB_URL: "postgresql://reader:pw@db.invalid/x",
      FOREVERDB_DATA_SOURCE: "postgres",
      SUPABASE_URL: "https://abc.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-value",
      NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      DATABASE_URL: "postgres://u:p@h/d",
      POSTGRES_URL: "postgres://u:p@h/d",
      ACCOUNT_AUTH_URL: "https://auth.invalid",
      ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_publishable_x",
      ACCOUNT_CSRF_SECRET: "s".repeat(40),
      UPSTASH_REDIS_REST_TOKEN: "t".repeat(40),
      TURNSTILE_SECRET_KEY: "k".repeat(20),
      RATE_LIMIT_SALT: "s".repeat(40),
      CHALLENGE_COOKIE_SECRET: "c".repeat(40),
      ADMIN_OWNER_UID: "00000000-0000-0000-0000-000000000000",
      BETA_SEO_AUTHORIZED_BRANCH: "main",
    };
    for (const [k, v] of Object.entries(secrets)) expect(closed({ ...GOOD, [k]: v }, true, k), k).toBeTruthy();
    expect(closed({ ...GOOD, SITE_NOTE_URL: "postgres://u:p@h/d" })).toBeTruthy();
  });

  it("an empty-string leftover does not count as configuration, a non-empty one does", () => {
    expect(evaluatePreviewGate({ ...GOOD, SUPABASE_URL: "" }, true)).toEqual({ allowed: true });
    expect(closed({ ...GOOD, SUPABASE_URL: "x" })).toBeTruthy();
  });

  it("closes on other hosting platforms' markers and on generic secret-looking variable names", () => {
    for (const k of ["NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "K_SERVICE", "CF_PAGES", "RENDER", "FLY_APP_NAME", "RAILWAY_ENVIRONMENT", "KUBERNETES_SERVICE_HOST"]) expect(closed({ ...GOOD, [k]: "1" }, true, k), k).toMatch(/hosted/);
    for (const k of ["SOME_SERVICE_ROLE_KEY", "AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD"]) expect(closed({ ...GOOD, [k]: "x" }, true, k), k).toMatch(/backend/);
  });

  it("only loopback Host headers pass", () => {
    for (const h of ["localhost:3300", "127.0.0.1:3300", "LOCALHOST", "[::1]:3300"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of [null, "", "evil.com", "localhost.evil.com", "127.0.0.1.evil.com", "0.0.0.0:3300", "preview.foreverdb.test", "x.trycloudflare.com"]) expect(isLoopbackHost(h), String(h)).toBe(false);
  });

  it("recognises encoded and differently-cased spellings of the preview prefix", () => {
    for (const p of ["/%61dmin-preview", "/admin%2Dpreview/x", "/ADMIN-PREVIEW", "//admin-preview//x", "/Admin-Preview/articles"]) expect(isAdminPreviewPath(p), p).toBe(true);
    expect(isAdminPreviewPath("/%E0%A4%A")).toBe(false);
  });

  it("recognises only the exact preview path prefix", () => {
    expect(isAdminPreviewPath("/admin-preview")).toBe(true);
    expect(isAdminPreviewPath("/admin-preview/staff")).toBe(true);
    expect(isAdminPreviewPath("/admin")).toBe(false);
    expect(isAdminPreviewPath("/admin-previews")).toBe(false);
    expect(isAdminPreviewPath("/x/admin-preview")).toBe(false);
  });
});
