import { describe, expect, it } from "vitest";
import { evaluateAccountAuth, PRIVATE_PRODUCTION_PROJECT_REF, type AccountAuthContext } from "@/lib/account/config";
import { evaluateEnv, type RawEnv } from "@/lib/env";

/**
 * Account System V1 Auth-only configuration boundary. Every rejection below is a statement the boundary
 * must keep making; the global private-project guard in env.ts must keep working next to it.
 */

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
const ANON = jwt({ role: "anon", ref: "abcdefghijklmnopqrst" });
const STAGING_URL = "https://abcdefghijklmnopqrst.supabase.co";

const local: AccountAuthContext = { hosted: false, deployment: "local" };
const previewCtx: AccountAuthContext = { hosted: true, deployment: "preview", platformEnv: "preview" };
const demoCtx: AccountAuthContext = { hosted: true, deployment: "preview", platformEnv: "production" };

const localEnv = { ACCOUNT_AUTH_MODE: "local", ACCOUNT_AUTH_URL: "http://127.0.0.1:54321", ACCOUNT_AUTH_PUBLISHABLE_KEY: ANON };
const stagingEnv = {
  ACCOUNT_AUTH_MODE: "staging",
  ACCOUNT_AUTH_URL: STAGING_URL,
  ACCOUNT_AUTH_PROJECT_REF: "abcdefghijklmnopqrst",
  ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_publishable_" + "a".repeat(30),
};

const issues = (raw: Record<string, string | undefined>, ctx: AccountAuthContext) => evaluateAccountAuth(raw, ctx).issues.join(" | ");

describe("account auth configuration: allowed shapes", () => {
  it("is disabled by default and needs nothing", () => {
    const r = evaluateAccountAuth({}, previewCtx);
    expect(r).toEqual({ config: null, issues: [] });
  });
  it("accepts a loopback local stack on a developer machine", () => {
    const r = evaluateAccountAuth(localEnv, local);
    expect(r.issues).toEqual([]);
    expect(r.config).toMatchObject({ mode: "local", authOrigin: "http://127.0.0.1:54321", projectRef: null });
  });
  it("accepts a staging project on a hosted PREVIEW deployment", () => {
    const r = evaluateAccountAuth(stagingEnv, previewCtx);
    expect(r.issues).toEqual([]);
    expect(r.config).toMatchObject({ mode: "staging", authOrigin: STAGING_URL, projectRef: "abcdefghijklmnopqrst" });
  });
});

describe("account auth configuration: refusals", () => {
  it("refuses production mode in V1 whatever else is set", () => {
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_MODE: "production" }, { hosted: true, deployment: "production", platformEnv: "production" })).toMatch(/not available in Account System V1/);
  });
  it("refuses stray configuration while disabled (no silent partial setup)", () => {
    expect(issues({ ACCOUNT_AUTH_URL: STAGING_URL }, previewCtx)).toMatch(/ACCOUNT_AUTH_URL: configured while/);
    expect(issues({ ACCOUNT_AUTH_MODE: "disabled", ACCOUNT_AUTH_PUBLISHABLE_KEY: ANON }, previewCtx)).toMatch(/ACCOUNT_AUTH_PUBLISHABLE_KEY: configured while/);
    expect(issues({ ACCOUNT_AUTH_MODE: "", ACCOUNT_AUTH_PROJECT_REF: "x" }, previewCtx)).toMatch(/PROJECT_REF: configured while/);
  });
  it("refuses an unknown mode without echoing it", () => {
    const msg = issues({ ACCOUNT_AUTH_MODE: "SecretValue123" }, previewCtx);
    expect(msg).toMatch(/ACCOUNT_AUTH_MODE must be one of/);
    expect(msg).not.toMatch(/SecretValue123/);
  });
  it("refuses unknown ACCOUNT_AUTH_* variables (they may be secrets)", () => {
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_SERVICE_KEY: "x" }, previewCtx)).toMatch(/ACCOUNT_AUTH_SERVICE_KEY: unknown account-auth variable/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_JWT_SECRET: "x" }, previewCtx)).toMatch(/JWT_SECRET: unknown/);
  });
  it("refuses the private production project in every spelling", () => {
    const ref = PRIVATE_PRODUCTION_PROJECT_REF;
    for (const url of [
      `https://${ref}.supabase.co`,
      `https://${ref.toUpperCase()}.supabase.co`,
      `https://%256bl%2578hikdlfwgxurdyexdi.supabase.co`, // double-encoded k,x
      `https://ｋｌｘｈｉｋｄｌｆｗｇｘｕｒｄｙｅｘｄｉ.supabase.co`,
      `https://x.example/?p=${ref}`,
    ]) {
      expect(issues({ ...stagingEnv, ACCOUNT_AUTH_URL: url, ACCOUNT_AUTH_PROJECT_REF: ref }, previewCtx), url).toMatch(/PRIVATE production project/);
    }
  });
  it("requires staging to name its own project twice (URL and ref agree)", () => {
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_PROJECT_REF: undefined }, previewCtx)).toMatch(/PROJECT_REF must equal/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_PROJECT_REF: "zzzzzzzzzzzzzzzzzzzz" }, previewCtx)).toMatch(/PROJECT_REF must equal/);
  });
  it("restricts staging to https <ref>.supabase.co origins without credentials, path or query", () => {
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_URL: "http://abcdefghijklmnopqrst.supabase.co" }, previewCtx)).toMatch(/must be https/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_URL: "https://attacker.example" }, previewCtx)).toMatch(/supabase\.co origin/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_URL: "https://abcdefghijklmnopqrst.supabase.co.attacker.example" }, previewCtx)).toMatch(/supabase\.co origin/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_URL: "https://u:p@abcdefghijklmnopqrst.supabase.co" }, previewCtx)).toMatch(/credentials/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_URL: STAGING_URL + "/rest/v1" }, previewCtx)).toMatch(/origin only/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_URL: STAGING_URL + "/?x=1" }, previewCtx)).toMatch(/origin only/);
  });
  it("never enables accounts on ForeverDB production or Vercel's production target (the demo alias)", () => {
    expect(issues(stagingEnv, demoCtx)).toMatch(/Vercel's production target/);
    expect(issues(stagingEnv, { hosted: true, deployment: "production", platformEnv: "production" })).toMatch(/not allowed on a production deployment/);
  });
  it("confines local mode to a developer machine and loopback addresses", () => {
    expect(issues(localEnv, previewCtx)).toMatch(/only allowed on a developer machine/);
    expect(issues({ ...localEnv, ACCOUNT_AUTH_URL: "http://192.168.1.5:54321" }, local)).toMatch(/loopback/);
    expect(issues({ ...localEnv, ACCOUNT_AUTH_URL: "http://localhost.attacker.example" }, local)).toMatch(/loopback/);
    expect(issues({ ...localEnv, ACCOUNT_AUTH_PROJECT_REF: "abcdefghijklmnopqrst" }, local)).toMatch(/must not be set in local mode/);
  });
  it("accepts only publishable/anon keys, never secret or service-role keys", () => {
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_secret_" + "a".repeat(30) }, previewCtx)).toMatch(/SECRET key/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: jwt({ role: "service_role" }) }, previewCtx)).toMatch(/role=anon/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: jwt({ role: "authenticated" }) }, previewCtx)).toMatch(/role=anon/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: "not-a-key" }, previewCtx)).toMatch(/neither/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: "has space" }, previewCtx)).toMatch(/malformed/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: undefined }, previewCtx)).toMatch(/KEY is required/);
  });
  it("rejects an anon key minted for the private project or a different project", () => {
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: jwt({ role: "anon", ref: PRIVATE_PRODUCTION_PROJECT_REF }) }, previewCtx)).toMatch(/PRIVATE production project/);
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: jwt({ role: "anon", ref: "zzzzzzzzzzzzzzzzzzzz" }) }, previewCtx)).toMatch(/different project/);
  });
  it("never echoes configuration values in messages", () => {
    const secret = "sb_secret_TOPSECRETVALUE0123456789abcdef";
    const msg = issues({ ...stagingEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: secret, ACCOUNT_AUTH_URL: "https://u:hunter2pw@abcdefghijklmnopqrst.supabase.co" }, previewCtx);
    expect(msg).not.toMatch(/TOPSECRETVALUE|hunter2pw/);
  });
});

describe("integration with the global environment validator", () => {
  const demo: RawEnv = {
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_URL: "wow-foreverdb-abc123-imemoths-projects.vercel.app",
    FOREVERDB_DEPLOYMENT: "preview",
    FOREVERDB_DATA_SOURCE: "fixture",
  };
  it("leaves the public site unchanged and accounts disabled when nothing is configured", () => {
    const r = evaluateEnv(demo);
    expect(r.ok && r.env.accountAuth).toBeNull();
  });
  it("carries a valid staging configuration on a hosted preview", () => {
    const r = evaluateEnv({ ...demo, ...stagingEnv });
    expect(r.ok && r.env.accountAuth?.mode).toBe("staging");
  });
  it("fails the whole process closed when the account configuration is unsafe", () => {
    const r = evaluateEnv({ ...demo, ...stagingEnv, ACCOUNT_AUTH_URL: `https://${PRIVATE_PRODUCTION_PROJECT_REF}.supabase.co`, ACCOUNT_AUTH_PROJECT_REF: PRIVATE_PRODUCTION_PROJECT_REF });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues.join(" ")).toMatch(/PRIVATE production project/);
  });
  it("does NOT weaken the global guard: the private project is still refused everywhere else", () => {
    const ref = PRIVATE_PRODUCTION_PROJECT_REF;
    const r1 = evaluateEnv({ ...demo, FOREVERDB_DATA_SOURCE: "postgres", PUBLIC_READ_DATABASE_URL: `postgresql://foreverdb_web_reader:pw@db.${ref}.supabase.co/postgres` });
    expect(!r1.ok && r1.issues.join(" ")).toMatch(/PRIVATE production database/);
    const r2 = evaluateEnv({ ...demo, NEXT_PUBLIC_API_BASE: `https://${ref}.supabase.co` });
    expect(!r2.ok && r2.issues.join(" ")).toMatch(/NEXT_PUBLIC_API_BASE: references the PRIVATE/);
    // Supabase-named and service-role variables remain forbidden on hosted deployments, account mode or not.
    const r3 = evaluateEnv({ ...demo, ...stagingEnv, SUPABASE_SERVICE_ROLE_KEY: "x".repeat(40) });
    expect(!r3.ok && r3.issues.join(" ")).toMatch(/SUPABASE_SERVICE_ROLE_KEY: private backend credentials/);
    const r4 = evaluateEnv({ ...demo, ...stagingEnv, SERVICE_ROLE_KEY: "x".repeat(40) });
    expect(!r4.ok && r4.issues.join(" ")).toMatch(/SERVICE_ROLE_KEY: private backend credentials/);
  });
  it("refuses accounts on the demonstration alias (Vercel production target) end to end", () => {
    const r = evaluateEnv({ ...demo, VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "wow-foreverdb.vercel.app", ...stagingEnv });
    expect(!r.ok && r.issues.join(" ")).toMatch(/Vercel's production target/);
  });
  it("never lets ForeverDB production mode be reached through the account variables", () => {
    const r = evaluateEnv({ ...demo, ACCOUNT_AUTH_MODE: "production" });
    expect(!r.ok && r.issues.join(" ")).toMatch(/not available in Account System V1/);
  });
});
