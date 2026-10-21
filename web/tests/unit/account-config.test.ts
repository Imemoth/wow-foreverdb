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

const CSRF = "c".repeat(40);
const localEnv = { ACCOUNT_AUTH_MODE: "local", ACCOUNT_AUTH_URL: "http://127.0.0.1:54321", ACCOUNT_AUTH_PUBLISHABLE_KEY: ANON, ACCOUNT_CSRF_SECRET: CSRF };
const stagingEnv = {
  ACCOUNT_AUTH_MODE: "staging",
  ACCOUNT_AUTH_URL: STAGING_URL,
  ACCOUNT_AUTH_PROJECT_REF: "abcdefghijklmnopqrst",
  ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_publishable_" + "a".repeat(30),
  ACCOUNT_CSRF_SECRET: CSRF,
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
  it("requires a strong CSRF signing secret and never echoes it", () => {
    expect(issues({ ...stagingEnv, ACCOUNT_CSRF_SECRET: undefined }, previewCtx)).toMatch(/ACCOUNT_CSRF_SECRET is required/);
    expect(issues({ ...stagingEnv, ACCOUNT_CSRF_SECRET: "short" }, previewCtx)).toMatch(/at least 32/);
    expect(issues({ ...stagingEnv, ACCOUNT_CSRF_SECRET: "x y ".repeat(12) }, previewCtx)).toMatch(/malformed/);
    expect(issues({ ACCOUNT_CSRF_SECRET: "z".repeat(40) }, previewCtx)).toMatch(/ACCOUNT_CSRF_SECRET: configured while/);
    expect(issues({ ...stagingEnv, ACCOUNT_CSRF_SECRET: "short-secret-VALUE" }, previewCtx)).not.toMatch(/short-secret-VALUE/);
  });
  it("rejects a port on the staging origin (host confusion)", () => {
    expect(issues({ ...stagingEnv, ACCOUNT_AUTH_URL: "https://abcdefghijklmnopqrst.supabase.co:8443" }, previewCtx)).toMatch(/must not carry a port/);
  });
  it("never echoes configuration values in messages", () => {
    const secret = "sb_secret_TOPSECRETVALUE0123456789abcdef";
    const msg = issues({ ...stagingEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: secret, ACCOUNT_AUTH_URL: "https://u:hunter2pw@abcdefghijklmnopqrst.supabase.co" }, previewCtx);
    expect(msg).not.toMatch(/TOPSECRETVALUE|hunter2pw/);
  });
});


describe("Vercel Upstash Marketplace REST credentials", () => {
  const marketplace = {
    RATE_LIMIT_BACKEND: "upstash",
    UPSTASH_REDIS_REST_KV_REST_API_URL: "https://primary-upstash.example.upstash.io",
    UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "t".repeat(40),
  };

  it("accepts integration REST API names without requiring manual secret duplication", () => {
    const r = evaluateEnv(marketplace);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.UPSTASH_REDIS_REST_URL).toBe(marketplace.UPSTASH_REDIS_REST_KV_REST_API_URL);
    expect(r.env.UPSTASH_REDIS_REST_TOKEN).toBe(marketplace.UPSTASH_REDIS_REST_KV_REST_API_TOKEN);
  });

  it("refuses conflicting manual and marketplace credentials rather than guessing", () => {
    const url = evaluateEnv({ ...marketplace, UPSTASH_REDIS_REST_URL: "https://different.example.upstash.io" });
    expect(url.ok).toBe(false);
    expect(!url.ok && url.issues.join(" ")).toMatch(/REST_URL conflicts with marketplace REST API URL/);
    const token = evaluateEnv({ ...marketplace, UPSTASH_REDIS_REST_TOKEN: "x".repeat(40) });
    expect(token.ok).toBe(false);
    expect(!token.ok && token.issues.join(" ")).toMatch(/REST_TOKEN conflicts with marketplace REST API token/);
    expect(!token.ok && token.issues.join(" ")).not.toContain("tttt");
  });

  it("does not mistake the Upstash Redis connection URL for the REST endpoint", () => {
    const r = evaluateEnv({ RATE_LIMIT_BACKEND: "upstash", UPSTASH_REDIS_REST_REDIS_URL: "rediss://redis.example:6380", UPSTASH_REDIS_REST_KV_URL: "redis://redis.example:6379" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues.join(" ")).toMatch(/upstash rate limiter requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN/);
  });
});

describe("single-project Auth pilot and production candidate: owner-gated policies", () => {
  const PRIVATE_URL = "https://" + PRIVATE_PRODUCTION_PROJECT_REF + ".supabase.co";
  const modernKey = "sb_publishable_" + "z".repeat(40);
  const privateAuth = {
    ACCOUNT_AUTH_URL: PRIVATE_URL,
    ACCOUNT_AUTH_PROJECT_REF: PRIVATE_PRODUCTION_PROJECT_REF,
    ACCOUNT_AUTH_PUBLISHABLE_KEY: modernKey,
    ACCOUNT_CSRF_SECRET: CSRF,
  };
  const pilot = { ...privateAuth, ACCOUNT_AUTH_MODE: "pilot" };
  const production = { ...privateAuth, ACCOUNT_AUTH_MODE: "production" };
  const ownerPilot = { pilot: true, production: false };
  const ownerProduction = { pilot: false, production: true };
  const releaseCtx: AccountAuthContext = { hosted: true, deployment: "production", platformEnv: "production" };

  it("allows only the explicitly source-approved Preview pilot, while production stays code-blocked", () => {
    // The compiled pilot approval is OFF on the release line: the environment alone must never open the pilot.
    expect(issues(pilot, previewCtx)).toMatch(/owner-approved code change/);
    expect(evaluateAccountAuth(pilot, previewCtx, ownerPilot).issues).toEqual([]);
    expect(issues(production, releaseCtx)).toMatch(/owner-approved code change/);
    // The approval is compiled into this TEMPORARY protected-pilot branch, not controlled by environment flags.
    // A simulation with compiled approval revoked must stay closed for either mode.
    expect(evaluateAccountAuth(pilot, previewCtx, { pilot: false, production: false }).issues.join(" "))
      .toMatch(/owner-approved code change/);
    const fakeApproval = { ...pilot, ACCOUNT_AUTH_PILOT_APPROVED: "false" };
    expect(issues(fakeApproval, previewCtx)).toMatch(/unknown account-auth variable/);
    // No environment var may approve public production.
    const productionSpoof = { ...production, ACCOUNT_AUTH_PRODUCTION_APPROVED: "true" };
    expect(issues(productionSpoof, releaseCtx)).toMatch(/owner-approved code change/);
  });

  it("accepts ONLY a precise private-project pilot on Vercel Preview if code is owner-approved", () => {
    const r = evaluateAccountAuth(pilot, previewCtx, ownerPilot);
    expect(r.issues).toEqual([]);
    expect(r.config).toMatchObject({
      mode: "pilot", authOrigin: PRIVATE_URL, projectRef: PRIVATE_PRODUCTION_PROJECT_REF,
    });
    expect(evaluateAccountAuth(pilot, demoCtx, ownerPilot).issues.join(" ")).toMatch(/protected Vercel preview/);
    expect(evaluateAccountAuth(pilot, releaseCtx, ownerPilot).issues.join(" ")).toMatch(/protected Vercel preview/);
    expect(evaluateAccountAuth(pilot, local, ownerPilot).issues.join(" ")).toMatch(/protected Vercel preview/);
  });

  it("accepts production only after separate code approval and matching real Vercel Production signals", () => {
    const r = evaluateAccountAuth(production, releaseCtx, ownerProduction);
    expect(r.issues).toEqual([]);
    expect(r.config).toMatchObject({
      mode: "production", authOrigin: PRIVATE_URL, projectRef: PRIVATE_PRODUCTION_PROJECT_REF,
    });
    expect(evaluateAccountAuth(production, previewCtx, ownerProduction).issues.join(" ")).toMatch(/Vercel's production environment/);
    expect(evaluateAccountAuth(production, demoCtx, ownerProduction).issues.join(" ")).toMatch(/Vercel's production environment/);
    expect(evaluateAccountAuth(production, local, ownerProduction).issues.join(" ")).toMatch(/Vercel's production environment/);
    // Pilot approval must not authorize production and vice versa.
    expect(evaluateAccountAuth(production, releaseCtx, ownerPilot).issues.join(" ")).toMatch(/owner-approved/);
    expect(evaluateAccountAuth(pilot, previewCtx, ownerProduction).issues.join(" ")).toMatch(/owner-approved/);
  });

  it("allows no other Supabase project or alternate host in either approved private mode", () => {
    for (const [authEnv, context, approval] of [
      [pilot, previewCtx, ownerPilot],
      [production, releaseCtx, ownerProduction],
    ] as const) {
      const badHost = evaluateAccountAuth({ ...authEnv, ACCOUNT_AUTH_URL: STAGING_URL, ACCOUNT_AUTH_PROJECT_REF: "abcdefghijklmnopqrst" }, context, approval);
      expect(badHost.issues.join(" ")).toMatch(/approved PRIVATE production project/);
      const badRef = evaluateAccountAuth({ ...authEnv, ACCOUNT_AUTH_PROJECT_REF: "abcdefghijklmnopqrst" }, context, approval);
      expect(badRef.issues.join(" ")).toMatch(/PROJECT_REF must equal/);
      const wrongHost = evaluateAccountAuth({ ...authEnv, ACCOUNT_AUTH_URL: PRIVATE_URL + ".attacker.example" }, context, approval);
      expect(wrongHost.issues.join(" ")).toMatch(/supabase\.co origin/);
      const withPath = evaluateAccountAuth({ ...authEnv, ACCOUNT_AUTH_URL: PRIVATE_URL + "/auth/v1" }, context, approval);
      expect(withPath.issues.join(" ")).toMatch(/origin only/);
      const withSecret = evaluateAccountAuth({ ...authEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_secret_" + "a".repeat(32) }, context, approval);
      expect(withSecret.issues.join(" ")).toMatch(/SECRET key/);
      const legacyKey = evaluateAccountAuth({ ...authEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: jwt({ role: "anon", ref: PRIVATE_PRODUCTION_PROJECT_REF }) }, context, approval);
      expect(legacyKey.issues.join(" ")).toMatch(/modern publishable key/);
      const blankPublishable = evaluateAccountAuth({ ...authEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_publishable_" }, context, approval);
      expect(blankPublishable.issues.join(" ")).toMatch(/well-formed/);
    }
  });

  it("requires Upstash, CSRF and Turnstile for an approved PRIVATE project pilot", () => {
    const preview: RawEnv = {
      VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "account-preview.example.vercel.app",
      FOREVERDB_DEPLOYMENT: "preview", FOREVERDB_DATA_SOURCE: "fixture",
      ...pilot,
    };
    const withoutLimiter = evaluateEnv(preview, ownerPilot);
    expect(withoutLimiter.ok).toBe(false);
    expect(!withoutLimiter.ok && withoutLimiter.issues.join(" ")).toMatch(/pilot requires the upstash/);

    const withLimiter: RawEnv = {
      ...preview,
      RATE_LIMIT_BACKEND: "upstash", UPSTASH_REDIS_REST_URL: "https://x.upstash.io",
      UPSTASH_REDIS_REST_TOKEN: "t".repeat(40), RATE_LIMIT_SALT: "s".repeat(40),
    };
    const missingCaptcha = evaluateEnv(withLimiter, ownerPilot);
    expect(missingCaptcha.ok).toBe(false);
    expect(!missingCaptcha.ok && missingCaptcha.issues.join(" ")).toMatch(/pilot requires server-side Turnstile/);

    const valid: RawEnv = {
      ...withLimiter, TURNSTILE_SECRET_KEY: "t".repeat(40),
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "p".repeat(40), CHALLENGE_COOKIE_SECRET: "c".repeat(40),
    };
    const accepted = evaluateEnv(valid, ownerPilot);
    expect(accepted.ok).toBe(true);
    expect(accepted.ok && accepted.env.accountAuth?.mode).toBe("pilot");
    expect(accepted.ok && accepted.env.FOREVERDB_DATA_SOURCE).toBe("fixture");
    const publicLeak = evaluateEnv({ ...valid, NEXT_PUBLIC_SUPABASE_URL: PRIVATE_URL }, ownerPilot);
    expect(publicLeak.ok).toBe(false);
    expect(!publicLeak.ok && publicLeak.issues.join(" ")).toMatch(/NEXT_PUBLIC_SUPABASE_URL: private backend credentials/);
  });

  it("accepts production policy ONLY with separate public read DB and full release controls", () => {
    const prod: RawEnv = {
      VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "wow-foreverdb.vercel.app",
      FOREVERDB_DEPLOYMENT: "production", FOREVERDB_DATA_SOURCE: "postgres",
      AZERDEX_READ_DB_URL: "postgresql://foreverdb_web_reader:pw@public-db.example.net:6543/postgres",
      SITE_URL: "https://wow-foreverdb.vercel.app",
      RATE_LIMIT_BACKEND: "upstash", RATE_LIMIT_SALT: "s".repeat(40),
      UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t".repeat(40),
      TRUSTED_IP_HEADER: "x-real-ip", TURNSTILE_SECRET_KEY: "t".repeat(40),
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "p".repeat(40), CHALLENGE_COOKIE_SECRET: "c".repeat(40),
      ...production,
    };
    const good = evaluateEnv(prod, ownerProduction);
    expect(good.ok).toBe(true);
    expect(good.ok && good.env.accountAuth?.mode).toBe("production");
    const fixture = evaluateEnv({ ...prod, FOREVERDB_DATA_SOURCE: "fixture" }, ownerProduction);
    expect(fixture.ok).toBe(false);
    expect(!fixture.ok && fixture.issues.join(" ")).toMatch(/synthetic fixture/);
    const privateDb = evaluateEnv({ ...prod, AZERDEX_READ_DB_URL: "postgresql://foreverdb_web_reader:pw@db." + PRIVATE_PRODUCTION_PROJECT_REF + ".supabase.co/postgres" }, ownerProduction);
    expect(privateDb.ok).toBe(false);
    expect(!privateDb.ok && privateDb.issues.join(" ")).toMatch(/PRIVATE production database/);
  });

  it("blocks public production and any pilot on the wrong Vercel target despite deployment environment values", () => {
    const base: RawEnv = {
      VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "wow-foreverdb.vercel.app",
      FOREVERDB_DEPLOYMENT: "production", FOREVERDB_DATA_SOURCE: "postgres",
      AZERDEX_READ_DB_URL: "postgresql://foreverdb_web_reader:pw@public-db.example.net:6543/postgres",
      SITE_URL: "https://wow-foreverdb.vercel.app",
      RATE_LIMIT_BACKEND: "upstash", RATE_LIMIT_SALT: "s".repeat(40),
      UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t".repeat(40),
      TRUSTED_IP_HEADER: "x-real-ip",
    };
    const r = evaluateEnv({ ...base, ...production });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues.join(" ")).toMatch(/owner-approved code change/);
    const rp = evaluateEnv({ ...base, FOREVERDB_DEPLOYMENT: "preview", FOREVERDB_DATA_SOURCE: "fixture", ...pilot });
    expect(rp.ok).toBe(false);
    expect(!rp.ok && rp.issues.join(" ")).toMatch(/protected Vercel preview/);
    // The pilot's source-code approval must not create public access or a public backend credential.
    const x = evaluateEnv({ ...base, ...production, NEXT_PUBLIC_ACCOUNT_BACKEND: PRIVATE_URL });
    expect(x.ok).toBe(false);
    expect(!x.ok && x.issues.join(" ")).toMatch(/NEXT_PUBLIC_ACCOUNT_BACKEND: references the PRIVATE/);
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
    const r1 = evaluateEnv({ ...demo, FOREVERDB_DATA_SOURCE: "postgres", AZERDEX_READ_DB_URL: `postgresql://foreverdb_web_reader:pw@db.${ref}.supabase.co/postgres` });
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
