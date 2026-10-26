import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateAccountAuth,
  isApprovedPublicBetaScope,
  PRIVATE_PRODUCTION_PROJECT_REF,
  PRODUCTION_ACCOUNT_AUTH_APPROVED,
  PUBLIC_BETA_ACCOUNT_SCOPE,
  SINGLE_PROJECT_PILOT_APPROVED,
  type AccountAuthContext,
} from "@/lib/account/config";
import { evaluateEnv, type RawEnv } from "@/lib/env";

/**
 * Owner-approved PUBLIC BETA activation of the Account System. The approval is scoped in code to the exact beta
 * deployment (branch + site origin + hosted preview); the global compile-time flags stay OFF, so the same source on
 * main / production / an unrelated preview stays disabled or fails closed.
 */

const PRIVATE_URL = `https://${PRIVATE_PRODUCTION_PROJECT_REF}.supabase.co`;
const BETA_ORIGIN = "https://beta.azerdex.com";
const betaCtx: AccountAuthContext = { hosted: true, deployment: "preview", platformEnv: "preview", gitBranch: "web/azerdex-beta" };
const pilotEnv: Record<string, string> = {
  ACCOUNT_AUTH_MODE: "pilot",
  ACCOUNT_AUTH_URL: PRIVATE_URL,
  ACCOUNT_AUTH_PROJECT_REF: PRIVATE_PRODUCTION_PROJECT_REF,
  ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_publishable_" + "k".repeat(30),
  ACCOUNT_CSRF_SECRET: "c".repeat(40),
  SITE_URL: BETA_ORIGIN,
};

describe("public beta Account scope", () => {
  it("keeps the global compile-time approval flags OFF (activation is scoped, not global)", () => {
    expect(SINGLE_PROJECT_PILOT_APPROVED).toBe(false);
    expect(PRODUCTION_ACCOUNT_AUTH_APPROVED).toBe(false);
    expect(PUBLIC_BETA_ACCOUNT_SCOPE).toEqual({ gitBranch: "web/azerdex-beta", siteOrigin: BETA_ORIGIN });
  });

  it("accepts pilot mode only on the exact beta branch + origin on a hosted preview", () => {
    const r = evaluateAccountAuth(pilotEnv, betaCtx);
    expect(r.issues).toEqual([]);
    expect(r.config).toMatchObject({ mode: "pilot", projectRef: PRIVATE_PRODUCTION_PROJECT_REF });
  });

  const refused: Array<[string, AccountAuthContext, string | undefined]> = [
    ["another branch", { ...betaCtx, gitBranch: "main" }, BETA_ORIGIN],
    ["a look-alike branch", { ...betaCtx, gitBranch: "web/azerdex-beta-2" }, BETA_ORIGIN],
    ["no branch metadata", { ...betaCtx, gitBranch: undefined }, BETA_ORIGIN],
    ["Vercel production target", { ...betaCtx, deployment: "production", platformEnv: "production" }, BETA_ORIGIN],
    ["the production alias demo (preview designation on production target)", { ...betaCtx, platformEnv: "production" }, BETA_ORIGIN],
    ["a developer machine", { hosted: false, deployment: "local", gitBranch: "web/azerdex-beta" }, BETA_ORIGIN],
    ["azerdex.com", betaCtx, "https://azerdex.com"],
    ["a vercel.app preview URL", betaCtx, "https://wow-foreverdb-git-web-azerdex-beta-imemoths-projects.vercel.app"],
    ["a look-alike host", betaCtx, "https://beta.azerdex.com.attacker.example"],
    ["http instead of https", betaCtx, "http://beta.azerdex.com"],
    ["no SITE_URL", betaCtx, undefined],
  ];
  it.each(refused)("refuses pilot mode on %s", (_name, ctx, siteUrl) => {
    expect(isApprovedPublicBetaScope(ctx, siteUrl)).toBe(false);
    const r = evaluateAccountAuth({ ...pilotEnv, SITE_URL: siteUrl }, ctx);
    expect(r.config).toBeNull();
    expect(r.issues.join(" ")).toMatch(/owner-approved code change|Vercel preview deployment/);
  });

  it("cannot be enabled by an environment variable alone", () => {
    const spoofed = { ...pilotEnv, ACCOUNT_AUTH_PILOT_APPROVED: "true", ACCOUNT_AUTH_PUBLIC_BETA: "true" };
    expect(evaluateAccountAuth(spoofed, { ...betaCtx, gitBranch: "feature/x" }).issues.join(" ")).toMatch(/unknown account-auth variable/);
  });

  it("does not approve production mode", () => {
    const r = evaluateAccountAuth({ ...pilotEnv, ACCOUNT_AUTH_MODE: "production" }, betaCtx);
    expect(r.config).toBeNull();
    expect(r.issues.join(" ")).toMatch(/owner-approved code change/);
  });

  it("still requires the private project, a modern publishable key and the CSRF secret", () => {
    expect(evaluateAccountAuth({ ...pilotEnv, ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_secret_" + "a".repeat(32) }, betaCtx).issues.join(" ")).toMatch(/SECRET key/);
    expect(
      evaluateAccountAuth({ ...pilotEnv, ACCOUNT_AUTH_URL: "https://abcdefghijklmnopqrst.supabase.co", ACCOUNT_AUTH_PROJECT_REF: "abcdefghijklmnopqrst" }, betaCtx).issues.join(" "),
    ).toMatch(/approved PRIVATE production project/);
    expect(evaluateAccountAuth({ ...pilotEnv, ACCOUNT_CSRF_SECRET: "short" }, betaCtx).issues.join(" ")).toMatch(/ACCOUNT_CSRF_SECRET/);
  });
});

describe("public beta Account scope through the global environment validator", () => {
  const protections: RawEnv = {
    RATE_LIMIT_BACKEND: "upstash", UPSTASH_REDIS_REST_URL: "https://x.upstash.io", UPSTASH_REDIS_REST_TOKEN: "t".repeat(40),
    RATE_LIMIT_SALT: "s".repeat(40), TURNSTILE_SECRET_KEY: "t".repeat(40), NEXT_PUBLIC_TURNSTILE_SITE_KEY: "p".repeat(40),
    CHALLENGE_COOKIE_SECRET: "c".repeat(40),
  };
  const betaRaw: RawEnv = {
    VERCEL: "1", VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "web/azerdex-beta", VERCEL_URL: "x.vercel.app",
    FOREVERDB_DEPLOYMENT: "preview", FOREVERDB_DATA_SOURCE: "fixture", ...protections, ...pilotEnv,
  };

  it("enables Account on the beta deployment (preview, fixture data, beta.azerdex.com)", () => {
    const r = evaluateEnv(betaRaw);
    expect(r.ok).toBe(true);
    expect(r.ok && r.env.accountAuth?.mode).toBe("pilot");
    expect(r.ok && r.env.SITE_URL).toBe(BETA_ORIGIN);
  });

  it("keeps requiring Upstash and Turnstile in the beta scope", () => {
    const r = evaluateEnv({ ...betaRaw, RATE_LIMIT_BACKEND: "memory" });
    expect(!r.ok && r.issues.join(" ")).toMatch(/pilot requires the upstash/);
    const t = evaluateEnv({ ...betaRaw, TURNSTILE_SECRET_KEY: undefined, NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined, CHALLENGE_COOKIE_SECRET: undefined });
    expect(!t.ok && t.issues.join(" ")).toMatch(/pilot requires server-side Turnstile/);
  });

  it("fails closed for the same configuration on any other branch, on production and on the production alias", () => {
    const patches: RawEnv[] = [
      { VERCEL_GIT_COMMIT_REF: "main" },
      { VERCEL_GIT_COMMIT_REF: "feature/account-ui" },
      { VERCEL_GIT_COMMIT_REF: undefined },
      { VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "wow-foreverdb.vercel.app" },
    ];
    for (const patch of patches) expect(evaluateEnv({ ...betaRaw, ...patch }).ok, JSON.stringify(patch)).toBe(false);
    const prod = evaluateEnv({ ...betaRaw, VERCEL_ENV: "production", FOREVERDB_DEPLOYMENT: "production", FOREVERDB_DATA_SOURCE: "postgres", SITE_URL: "https://azerdex.com" });
    expect(prod.ok).toBe(false);
  });

  it("stays disabled with no Account variables on any deployment (the default for every other branch)", () => {
    const rest: RawEnv = { ...betaRaw };
    for (const k of Object.keys(pilotEnv)) if (k !== "SITE_URL") delete rest[k];
    for (const branch of ["main", "web/azerdex-beta", "feature/x"]) {
      const r = evaluateEnv({ ...rest, VERCEL_GIT_COMMIT_REF: branch });
      expect(r.ok && r.env.accountAuth).toBe(null);
    }
  });
});

describe("header Account seam", () => {
  beforeEach(() => vi.resetModules());

  async function seam(state: "disabled" | "unavailable" | "ready") {
    vi.doMock("@/lib/account/runtime", () => ({ accountRuntime: () => (state === "ready" ? { state, ctx: {} } : { state }) }));
    return (await import("@/app/account/_ui/HeaderAccount")).HeaderAccount;
  }

  it("renders no Account entry unless Account is enabled and ready", async () => {
    expect((await seam("disabled"))({ variant: "desktop" })).toBeNull();
    vi.resetModules();
    expect((await seam("unavailable"))({ variant: "mobile" })).toBeNull();
  });

  it("renders the Account menu when Account is ready", async () => {
    const el = (await seam("ready"))({ variant: "desktop" });
    expect(el).not.toBeNull();
    expect((el as unknown as { props: { variant: string } }).props.variant).toBe("desktop");
  });
});
